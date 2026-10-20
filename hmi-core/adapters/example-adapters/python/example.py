"""
example.py - et eksempelprogram flettet sammen med en adapter til HMI-huben.

Programmet her er en liten simulert prosess: en tank med en pumpe som fyller den mot et
settpunkt, og et utløp som tømmer den. Bytt ut simuleringen med ditt eget program: les
verdiene du vil vise med hub.set(), og gjør det HMI-en ber om i on_write-funksjonene.

    python example.py                                  # huben på denne maskinen
    python example.py ws://192.168.1.10:8080 py_1      # huben på Pi-en, adapternavn py_1

Taggene (med navnet py_1):
    py_1.level        tanknivå, %               (leses)
    py_1.setpoint     ønsket nivå, %            (skrivbar: Number input eller Slider i HMI-en)
    py_1.running      pumpen går                (skrivbar: Switch)
    py_1.reset        nullstill telleren        (skrivbar: Button, verdi true)
    py_1.pump_starts  antall pumpestarter       (leses)
    py_1.status       en tekst om hva som skjer (leses: Value-widget)
    py_1.high_level   true over 95 %            (alarm i HMI-ens alarmliste)
"""
import os
import random
import sys
import time

from hub_adapter import HubAdapter

url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('HUB_URL', 'ws://localhost:8080')
name = sys.argv[2] if len(sys.argv) > 2 else 'py_1'

# ---------------------------------------------------------------- programmet ditt (her: en simulering)
state = {'level': 20.0, 'setpoint': 60.0, 'running': True, 'pump_starts': 0}


def set_setpoint(value):
    # kalles når HMI-en skriver py_1.setpoint. Begrens til et fornuftig område, og returner det
    # som faktisk ble satt: det er det alle HMI-er får se (ekkoet)
    v = max(0.0, min(100.0, float(value)))
    state['setpoint'] = v
    return v


def set_running(value):
    on = bool(value)
    if on and not state['running']:
        hub.event('Pump started from the HMI')
    if not on and state['running']:
        hub.event('Pump stopped from the HMI')
    state['running'] = on
    return on


def reset_counter(value):
    # en knapp: true nullstiller telleren; taggen går straks tilbake til false
    if value:
        state['pump_starts'] = 0
        hub.event('Pump start counter reset')
    return False


# ---------------------------------------------------------------- adapteren
hub = HubAdapter(url, name)
hub.add_tag('level', 'number', unit='%', description='Tank level (simulated)', value=state['level'])
hub.add_tag('setpoint', 'number', unit='%', writable=True, on_write=set_setpoint, value=state['setpoint'])
hub.add_tag('running', 'boolean', writable=True, on_write=set_running, value=state['running'])
hub.add_tag('reset', 'boolean', writable=True, on_write=reset_counter, value=False)
hub.add_tag('pump_starts', 'number', value=0)
hub.add_tag('status', 'string', value='starting')
hub.add_tag('high_level', 'boolean', value=False,
            alarm={'severity': 'alarm', 'text': 'Tank level above 95 %', 'delay': 2000})
hub.start()

# ---------------------------------------------------------------- hovedløkken
pump_on = False
try:
    while True:
        # simuleringen: pumpen fyller med 3 %/s, utløpet tømmer med 1-2 %/s
        want = state['running'] and state['level'] < state['setpoint']
        if want and not pump_on:
            state['pump_starts'] += 1
        pump_on = want
        state['level'] += (3.0 if pump_on else 0.0) * 0.5 - random.uniform(0.5, 1.0) * 0.5
        state['level'] = max(0.0, min(100.0, state['level']))

        status = 'stopped' if not state['running'] else 'filling' if pump_on else 'at setpoint'
        hub.set_many({
            'level': round(state['level'], 1),
            'pump_starts': state['pump_starts'],
            'status': status,
            'high_level': state['level'] > 95,
        })
        time.sleep(0.5)
except KeyboardInterrupt:
    hub.stop()
