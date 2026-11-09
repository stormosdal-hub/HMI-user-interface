#!/usr/bin/python3
# DHCP for nettbrett på Bluetooth-nettet (pan0), så de kan åpne HMI-et på http://192.168.1.<nummer>:8080.
# Et eget lite program fordi dhcp-helper (reléet for PLS-siden) har UDP-port 67 på alle grensesnitt;
# dette leser og sender rammene direkte på pan0 (AF_PACKET) og trenger ikke porten.
# Leiene holdes bare i minnet; etter en omstart får en klient som ber om adressen sin, den igjen.
import socket, struct, time
import btnet

IFACE = 'pan0'
SERVER = btnet.address()
PREFIX = btnet.prefix()
POOL = btnet.POOL
LEASE = 86400
ETH_P_IP = 0x0800
MAGIC = b'\x63\x82\x53\x63'
DISCOVER, OFFER, REQUEST, DECLINE, ACK, NAK, RELEASE, INFORM = 1, 2, 3, 4, 5, 6, 7, 8
NAMES = {1: 'DISCOVER', 2: 'OFFER', 3: 'REQUEST', 4: 'DECLINE', 5: 'ACK', 6: 'NAK', 7: 'RELEASE', 8: 'INFORM'}

def log(*a):
    print(*a, flush=True)

def checksum(b):
    if len(b) % 2:
        b += b'\0'
    s = sum(struct.unpack('!%dH' % (len(b) // 2), b))
    while s >> 16:
        s = (s & 0xffff) + (s >> 16)
    return ~s & 0xffff

def mac_str(m):
    return m.hex(':')

leases = {}   # adresse (siste tall) -> (mac, utløper)

def holder(n):
    l = leases.get(n)
    return l[0] if l and l[1] > time.time() else None

def pick(mac, wanted):
    for n, (m, _) in leases.items():
        if m == mac:
            return n
    if wanted in POOL and holder(wanted) in (None, mac):
        return wanted
    for n in POOL:
        if holder(n) is None:
            return n
    return None

def options(raw):
    opts, i = {}, 0
    while i < len(raw):
        code = raw[i]
        if code == 255:
            break
        if code == 0:
            i += 1
            continue
        n = raw[i + 1]
        opts[code] = raw[i + 2:i + 2 + n]
        i += 2 + n
    return opts

def octet(ip):
    return int(ip.split('.')[3]) if ip.startswith(PREFIX) else None

sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_IP))
sock.bind((IFACE, ETH_P_IP))
MYMAC = sock.getsockname()[4]

def send(kind, req, yiaddr, to_ip, to_mac):
    xid, flags, ciaddr, chaddr = req['xid'], req['flags'], req['ciaddr'], req['chaddr']
    opts = bytes([53, 1, kind]) + bytes([54, 4]) + socket.inet_aton(SERVER)
    if kind != NAK:
        if kind != ACK or yiaddr != '0.0.0.0':
            opts += bytes([51, 4]) + struct.pack('!I', LEASE)
        opts += bytes([1, 4]) + socket.inet_aton('255.255.255.0')
        opts += bytes([3, 4]) + socket.inet_aton(SERVER) + bytes([6, 4]) + socket.inet_aton(SERVER)
    opts += b'\xff'
    bootp = struct.pack('!BBBB4sHH4s4s4s4s16s64s128s', 2, 1, 6, 0, xid, 0, flags, ciaddr,
                        socket.inet_aton(yiaddr), socket.inet_aton(SERVER), b'\0' * 4, chaddr, b'', b'')
    payload = bootp + MAGIC + opts
    payload += b'\0' * max(0, 300 - len(payload))
    src, dst = socket.inet_aton(SERVER), socket.inet_aton(to_ip)
    udp_len = 8 + len(payload)
    pseudo = src + dst + struct.pack('!BBH', 0, 17, udp_len)
    udp = struct.pack('!HHHH', 67, 68, udp_len, 0) + payload
    udp = udp[:6] + struct.pack('!H', checksum(pseudo + udp) or 0xffff) + udp[8:]
    ip = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + udp_len, 0, 0, 64, 17, 0, src, dst)
    ip = ip[:10] + struct.pack('!H', checksum(ip)) + ip[12:]
    sock.send(to_mac + MYMAC + struct.pack('!H', ETH_P_IP) + ip + udp)

def handle(frame):
    if len(frame) < 14 + 20 + 8 + 240:
        return
    ihl = (frame[14] & 15) * 4
    if frame[23] != 17:
        return
    sport, dport = struct.unpack('!HH', frame[14 + ihl:18 + ihl])
    if (sport, dport) != (68, 67):
        return
    b = frame[14 + ihl + 8:]
    if b[0] != 1 or b[236:240] != MAGIC:
        return
    req = {'xid': b[4:8], 'flags': struct.unpack('!H', b[10:12])[0], 'ciaddr': b[12:16], 'chaddr': b[28:44]}
    mac = b[28:34]
    opts = options(b[240:])
    kind = opts.get(53, b'\0')[0]
    name = opts.get(12, b'').decode('utf-8', 'replace')
    who = '%s%s' % (mac_str(mac), ' (%s)' % name if name else '')
    ciaddr = socket.inet_ntoa(req['ciaddr'])
    wanted = socket.inet_ntoa(opts[50]) if 50 in opts else ciaddr
    bcast = b'\xff' * 6
    if kind == DISCOVER:
        n = pick(mac, octet(wanted))
        if n is None:
            return log('no free address for', who)
        leases[n] = (mac, time.time() + 60)   # holdes av til REQUEST kommer
        send(OFFER, req, PREFIX + str(n), '255.255.255.255', bcast)
        log('offered %s%d to %s' % (PREFIX, n, who))
    elif kind == REQUEST:
        if 54 in opts and socket.inet_ntoa(opts[54]) != SERVER:
            return
        n = octet(wanted)
        if n in POOL and holder(n) in (None, mac):
            leases[n] = (mac, time.time() + LEASE)
            unicast = ciaddr != '0.0.0.0'
            send(ACK, req, PREFIX + str(n), ciaddr if unicast else '255.255.255.255', mac if unicast else bcast)
            log('gave %s%d to %s' % (PREFIX, n, who))
        else:
            send(NAK, req, '0.0.0.0', '255.255.255.255', bcast)
            log('refused %s for %s' % (wanted, who))
    elif kind in (RELEASE, DECLINE):
        n = octet(wanted)
        if n in leases and leases[n][0] == mac:
            if kind == RELEASE:
                del leases[n]
            else:
                leases[n] = (b'declined', time.time() + 600)
        log('%s %s from %s' % (NAMES[kind].lower(), wanted, who))
    elif kind == INFORM and ciaddr != '0.0.0.0':
        send(ACK, req, '0.0.0.0', ciaddr, mac)

log('DHCP on %s: %s%d-%d, HMI at http://%s:8080' % (IFACE, PREFIX, POOL[0], POOL[-1], SERVER))
while True:
    frame, addr = sock.recvfrom(4096)
    if addr[2] == socket.PACKET_OUTGOING:
        continue
    try:
        handle(frame)
    except Exception as e:
        log('bad DHCP packet: %s' % e)
