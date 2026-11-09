# Felles for bt-hmi.py og bt-dhcp.py: innstillingene og adressen til Bluetooth-nettet.
# Pi-en får 192.168.1.<kjøreverksnummer> (kv_52: http://192.168.1.52:8080), nettbrettene adresser fra .200
# og oppover, utenfor alle kjøreverksnumrene. "address" i bt.json overstyrer adressen til Pi-en.
import json, os, re

CONF = os.environ.get('KJV_BT_CONF', '/etc/kjoreverk/bt.json')
VEHICLE = os.environ.get('KJV_VEHICLE', '/etc/kjoreverk/vehicle')
POOL = range(200, 251)

def config():
    return json.load(open(CONF))

def vehicle():
    try:
        return open(VEHICLE).read().strip()
    except OSError:
        return ''

def address():
    a = config().get('address')
    if not a:
        m = re.search(r'(\d+)$', vehicle())
        a = '192.168.1.%d' % int(m.group(1)) if m else ''
    if not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', a) or not 1 <= int(a.rsplit('.', 1)[1]) < POOL[0]:
        raise SystemExit('no address for the Bluetooth network: the vehicle code %r in %s should end in a number '
                         '1-%d, or set "address" in %s' % (vehicle(), VEHICLE, POOL[0] - 1, CONF))
    return a

def prefix():
    return address().rsplit('.', 1)[0] + '.'
