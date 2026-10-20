"""
main.py - Raspberry Pi Pico W / Pico 2 W med MicroPython som adapter til HMI-huben.

Kortet kobler seg til Wi-Fi og til huben, og publiserer målinger som tagger. HMI-en kan slå
LED-en av og på, sette PWM-utgangen og alarmgrensen. Alt går som JSON over WebSocket; adapteren
er hub_adapter.py, som ligger ved siden av denne filen på kortet.

Sett WIFI_SSID, WIFI_PASS og HUB_HOST nedenfor, kopier main.py og hub_adapter.py til kortet, og
start det på nytt. main.py kjører av seg selv ved oppstart.

Taggene (med NAME = 'pico_1'):
    pico_1.temp          brikkens temperatur, °C   (grov: bytt gjerne til en ekte sensor)
    pico_1.button        BOOTSEL-knappen           (leses)
    pico_1.uptime        sekunder siden oppstart   (leses)
    pico_1.rssi          Wi-Fi-signal, dBm         (leses)
    pico_1.led           LED-en på kortet          (skrivbar: Switch)
    pico_1.pwm           PWM på GP15, 0-100 %      (skrivbar: Slider eller Number input)
    pico_1.alarm_limit   alarmgrense, °C           (skrivbar)
    pico_1.temp_high     temp over alarm_limit     (alarm i HMI-ens alarmliste)
"""
import time

import machine
import network
import rp2

from hub_adapter import HubAdapter

# ---------------------------------------------------------------- innstillinger
WIFI_SSID = 'your-wifi'
WIFI_PASS = 'your-password'
COUNTRY = 'NO'                   # Wi-Fi-landskode
HUB_HOST = '192.168.1.10'        # maskinen der hub.js kjører (Pi-en)
HUB_PORT = 8080
NAME = 'pico_1'                  # tagprefiks, unikt for hvert kort
PUBLISH_MS = 1000                # hvor ofte målingene sendes (bare endrede verdier går ut)
PWM_PIN = 15

# ---------------------------------------------------------------- maskinvaren
led = machine.Pin('LED', machine.Pin.OUT)          # LED-en sitter på Wi-Fi-brikken på W-kortene
pwm = machine.PWM(machine.Pin(PWM_PIN))
pwm.freq(1000)
pwm.duty_u16(0)
try:
    sensor = machine.ADC(machine.ADC.CORE_TEMP)    # nyere MicroPython
except AttributeError:
    sensor = machine.ADC(4)                        # temperatursensoren på RP2040 og RP2350


def read_temp():
    # spenningen over sensoren, omregnet til °C etter databladet
    volts = sensor.read_u16() * 3.3 / 65535
    return round(27 - (volts - 0.706) / 0.001721, 1)


state = {'pwm': 0, 'limit': 45.0}


def set_led(value):
    led.value(1 if value else 0)
    return bool(value)


def set_pwm(value):
    p = max(0, min(100, float(value)))
    pwm.duty_u16(int(p * 65535 / 100))
    state['pwm'] = p
    return p


def set_limit(value):
    state['limit'] = float(value)
    return state['limit']


# ---------------------------------------------------------------- Wi-Fi
rp2.country(COUNTRY)
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.config(pm=0xa11140)                           # skru av strømsparing: raskere svar fra kortet


def wifi_up():
    # kobler til (på nytt) og venter høyst 15 s; LED-en blinker mens den venter
    if wlan.isconnected():
        return True
    print('Wi-Fi: connecting to', WIFI_SSID)
    wlan.connect(WIFI_SSID, WIFI_PASS)
    for _ in range(30):
        if wlan.isconnected():
            print('Wi-Fi: IP', wlan.ifconfig()[0])
            led.value(0)
            return True
        led.toggle()
        time.sleep_ms(500)
    print('Wi-Fi: not connected, status', wlan.status())
    return False


# ---------------------------------------------------------------- adapteren
hub = HubAdapter(HUB_HOST, HUB_PORT, NAME)
hub.add_tag('temp', 'number', unit='°C', value=read_temp())
hub.add_tag('button', 'boolean', value=False)
hub.add_tag('uptime', 'number', unit='s', value=0)
hub.add_tag('rssi', 'number', unit='dBm')
hub.add_tag('led', 'boolean', writable=True, on_write=set_led, value=False)
hub.add_tag('pwm', 'number', unit='%', writable=True, on_write=set_pwm, value=0)
hub.add_tag('alarm_limit', 'number', unit='°C', writable=True, on_write=set_limit, value=state['limit'])
hub.add_tag('temp_high', 'boolean', value=False,
            alarm={'severity': 'alarm', 'text': 'Pico temperature above limit', 'delay': 3000})

# ---------------------------------------------------------------- hovedløkken
booted = time.time()                               # oppetid: time() går ikke rundt slik ticks_ms() gjør
last_publish = time.ticks_ms()
last_button = False
while True:
    if not wlan.isconnected():
        wifi_up()
    hub.poll()                                     # skrivinger fra HMI-en, ping, ny tilkobling

    # knappen sendes med en gang den endres, ikke bare hvert sekund
    pressed = bool(rp2.bootsel_button())
    if pressed != last_button:
        last_button = pressed
        hub.set('button', pressed)
        if pressed:
            hub.event('BOOTSEL button pressed on ' + NAME)

    if time.ticks_diff(time.ticks_ms(), last_publish) >= PUBLISH_MS:
        last_publish = time.ticks_ms()
        temp = read_temp()
        hub.set_many({
            'temp': temp,
            'temp_high': temp > state['limit'],
            'uptime': time.time() - booted,
            'rssi': wlan.status('rssi') if wlan.isconnected() else 0,
        })
    time.sleep_ms(20)
