#!/usr/bin/python3
# HMI-et over Bluetooth: Pi-en er et Bluetooth-nett (PAN, rollen NAP) som nettbrett kobler seg til,
# i tillegg til wifi. Pi-en er 192.168.1.<kjøreverksnummer> på pan0 (se btnet.py), nettbrettet får en adresse
# av bt-dhcp.py og når bare Pi-en selv, altså HMI-et på http://192.168.1.52:8080 for kv_52; ingenting som
# kommer inn på pan0, videresendes til PLS-en eller tunnelnettet.
#
# Paring krever en fast PIN-kode (/etc/kjoreverk/bt.json). Det går bare med eldre PIN-paring, så SSP slås
# av; med SSP på kan en enhet uten skjerm pare uten kode («Just Works»). Klarer vi ikke å slå den av,
# slås Bluetooth av heller enn å stå åpent.
import subprocess, sys, time
import dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
import btnet

BRIDGE = 'pan0'
ADAPTER = '/org/bluez/hci0'
AGENT = '/kjoreverk/bt/agent'
CHECK_EVERY = 30   # s: SSP, synlighet og forwarding på pan0 sjekkes på nytt så ofte

def log(*a):
    print(*a, flush=True)

cfg = btnet.config()
PIN = str(cfg['pin'])
if not (4 <= len(PIN) <= 16):
    sys.exit('the PIN in %s must have 4 to 16 characters' % btnet.CONF)
vehicle = btnet.vehicle()
ALIAS = cfg.get('name') or ('%s HMI' % vehicle if vehicle else 'HMI')
ADDRESS = btnet.address()

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()

def iface(path, name):
    return dbus.Interface(bus.get_object('org.bluez', path), name)

def device(path):
    p = iface(path, 'org.freedesktop.DBus.Properties')
    try:
        return '%s (%s)' % (p.Get('org.bluez.Device1', 'Alias'), p.Get('org.bluez.Device1', 'Address'))
    except dbus.DBusException:
        return str(path)

def paired(path):
    try:
        return bool(iface(path, 'org.freedesktop.DBus.Properties').Get('org.bluez.Device1', 'Paired'))
    except dbus.DBusException:
        return False

class Rejected(dbus.DBusException):
    _dbus_error_name = 'org.bluez.Error.Rejected'

class Agent(dbus.service.Object):
    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='s')
    def RequestPinCode(self, dev):
        log('pairing request from %s: answering with the PIN' % device(dev))
        return PIN

    @dbus.service.method('org.bluez.Agent1', in_signature='os', out_signature='')
    def AuthorizeService(self, dev, uuid):
        if not paired(dev):
            log('refused %s for %s, which is not paired' % (uuid, device(dev)))
            raise Rejected('not paired')

    # SSP-paring skal ikke forekomme når SSP er av; avvis den, så ingen kommer inn uten koden
    @dbus.service.method('org.bluez.Agent1', in_signature='ou', out_signature='')
    def RequestConfirmation(self, dev, passkey):
        log('refused pairing without the PIN from %s' % device(dev))
        raise Rejected('PIN required')

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='')
    def RequestAuthorization(self, dev):
        log('refused pairing without the PIN from %s' % device(dev))
        raise Rejected('PIN required')

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='u')
    def RequestPasskey(self, dev):
        raise Rejected('PIN required')

    @dbus.service.method('org.bluez.Agent1', in_signature='ouq', out_signature='')
    def DisplayPasskey(self, dev, passkey, entered):
        pass

    @dbus.service.method('org.bluez.Agent1', in_signature='os', out_signature='')
    def DisplayPinCode(self, dev, pincode):
        pass

    @dbus.service.method('org.bluez.Agent1', in_signature='', out_signature='')
    def Cancel(self):
        log('pairing cancelled')

    @dbus.service.method('org.bluez.Agent1', in_signature='', out_signature='')
    def Release(self):
        pass

def btmgmt(*args):
    # stdin må være et rør: med /dev/null, slik en systemd-tjeneste har det, avslutter btmgmt før svaret kommer
    return subprocess.run(['btmgmt', '--index', '0'] + list(args), stdin=subprocess.PIPE, capture_output=True,
                          text=True, timeout=15).stdout

def settings():
    for _ in range(3):
        for line in btmgmt('info').splitlines():
            if 'current settings:' in line:
                return line.split(':', 1)[1].split()
        time.sleep(1)
    return None

def secure():
    # SSP av og Bluetooth på, eller Bluetooth av: aldri på med SSP. True når den er på og trygg.
    s = settings()
    if s is not None and 'ssp' in s:
        log('turning SSP off, so pairing needs the PIN')
        btmgmt('power', 'off')
        btmgmt('ssp', 'off')
        s = settings()
    if s is None or 'ssp' in s:
        log('SSP is on or its state is unknown: turning Bluetooth off instead of leaving it open')
        btmgmt('power', 'off')
        return False
    if 'powered' not in s:
        btmgmt('power', 'on')
    return True

def show():
    # synlig og parbar hele tiden; koden er det som stenger
    p = iface(ADAPTER, 'org.freedesktop.DBus.Properties')
    a = 'org.bluez.Adapter1'
    want = [('Alias', dbus.String(ALIAS)), ('DiscoverableTimeout', dbus.UInt32(0)), ('PairableTimeout', dbus.UInt32(0)),
            ('Pairable', dbus.Boolean(True)), ('Discoverable', dbus.Boolean(True))]
    for k, v in want:
        if p.Get(a, k) != v:
            p.Set(a, k, v)

def no_forwarding():
    path = '/proc/sys/net/ipv4/conf/%s/forwarding' % BRIDGE
    if open(path).read().strip() != '0':
        log('forwarding was on for %s (someone set ip_forward again): turning it off' % BRIDGE)
        open(path, 'w').write('0')

def check():
    try:
        no_forwarding()
        if secure():
            show()
    except Exception as e:
        log('check failed: %s' % e)
    return True

def on_props(interface, changed, invalidated, path=None):
    if interface != 'org.bluez.Device1':
        return
    if 'Paired' in changed:
        log('%s %s' % (device(path), 'paired' if changed['Paired'] else 'no longer paired'))
    if 'Connected' in changed:
        log('%s %s' % (device(path), 'connected' if changed['Connected'] else 'disconnected'))

def on_owner(name, old, new):
    if name == 'org.bluez' and old:
        log('bluetoothd went away; stopping so systemd starts us again with it')
        loop.quit()

subprocess.run(['ip', '-4', 'addr', 'flush', 'dev', BRIDGE], check=True)
subprocess.run(['ip', 'addr', 'add', ADDRESS + '/24', 'dev', BRIDGE], check=True)
no_forwarding()
on = secure()
Agent(bus, AGENT)
mgr = iface('/org/bluez', 'org.bluez.AgentManager1')
mgr.RegisterAgent(AGENT, 'KeyboardDisplay')
mgr.RequestDefaultAgent(AGENT)
iface(ADAPTER, 'org.bluez.NetworkServer1').Register('nap', BRIDGE)
if on:
    show()
bus.add_signal_receiver(on_props, dbus_interface='org.freedesktop.DBus.Properties', signal_name='PropertiesChanged',
                        path_keyword='path')
bus.add_signal_receiver(on_owner, dbus_interface='org.freedesktop.DBus', signal_name='NameOwnerChanged', arg0='org.bluez')
GLib.timeout_add_seconds(CHECK_EVERY, check)
log('Bluetooth network for the HMI is up: "%s", HMI at http://%s:8080 on %s' % (ALIAS, ADDRESS, BRIDGE))
loop = GLib.MainLoop()
loop.run()
sys.exit(1)
