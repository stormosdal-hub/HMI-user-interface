"""The inputs INN0–INN7 on the kjøreverk's RaspiPower board, read with lgpio.

Each input has an optocoupler: 24 V on INNx lights its yellow LED and pulls the
GPIO low against the board's 10 kΩ pull-up, so the GPIO reads 0 while the input
is on. The Pi's own pull-up is turned on too, so a Pi without the board reads
every input as off.

The GPIOs are read every POLL seconds, and a new level counts once it has held
for debounce_ms. The editor can press an input as well, to try a layout without
the switches; such a press lets go by itself after VIRTUAL_SECONDS in case the
browser never says so. Nothing here writes to disk.
"""

import logging
import threading
import time

try:
    import lgpio

    from .gpio import header_chip
except ImportError:  # sudo apt install python3-lgpio; without it, only the editor's buttons work
    lgpio = None

log = logging.getLogger(__name__)

POLL = 0.02  # 50 times a second: a switch counts some 50 ms after it is turned
RETRY_SECONDS = 10
VIRTUAL_SECONDS = 30


class Inputs:
    def __init__(self, cfg):
        self.enabled = bool(cfg.get("enabled", True))
        self.pins = [int(p) for p in cfg.get("gpio", [])]
        self.active_low = bool(cfg.get("active_low", True))
        self.debounce = max(0.0, float(cfg.get("debounce_ms", 30))) / 1000
        n = len(self.pins)
        self.names = [f"INN{i}" for i in range(n)]
        self.error = None if self.enabled else "slått av i config.toml"
        self._real = [False] * n      # the GPIOs, debounced
        self._virtual = [0.0] * n     # when a press from the editor lets go (time.monotonic)
        self._state = [False] * n     # on from either
        self._cand = [None] * n       # a new level being debounced, and since when
        self._since = [0.0] * n
        self._claimed = [False] * n
        self._pin_errors = [None] * n
        self._chip = None
        self._next_try = 0.0
        self._listeners = []
        self._lock = threading.Lock()
        self._fire = threading.Lock()  # one change at a time to the listeners, in order
        self._thread = threading.Thread(target=self._loop, daemon=True, name="inputs")

    def __len__(self):
        return len(self.pins)

    def subscribe(self, fn):
        """fn(index, on) for every change, from this module's thread or an API request."""
        self._listeners.append(fn)

    def open(self):
        """Claims the GPIOs and reads them once, so displays started next find the switches as they are."""
        if self.enabled and self.pins and lgpio is None:
            self.error = "lgpio mangler (sudo apt install python3-lgpio)"
            log.warning("Inngangene: %s", self.error)
            return
        self._claim()
        self._update()

    def start(self):
        self._thread.start()

    # --- GPIO --------------------------------------------------------------

    def _claim(self):
        if not self.enabled or lgpio is None or all(self._claimed):
            return
        self._next_try = time.monotonic() + RETRY_SECONDS
        old = self.error
        try:
            if self._chip is None:
                self._chip = header_chip()
        except (OSError, lgpio.error) as e:
            self.error = str(e)
        else:
            for i, pin in enumerate(self.pins):
                if self._claimed[i]:
                    continue
                try:
                    try:
                        lgpio.gpio_claim_input(self._chip, pin, lgpio.SET_PULL_UP)
                    except lgpio.error as e:
                        if "busy" in str(e).lower():
                            raise
                        lgpio.gpio_claim_input(self._chip, pin)  # a kernel that can't set the pull-up
                    level = self._read(i)
                except lgpio.error as e:
                    self._pin_errors[i] = f"GPIO{pin} ({self.names[i]}): {e}"
                    continue
                self._claimed[i], self._pin_errors[i] = True, None
                with self._lock:
                    self._real[i] = self._cand[i] = level  # the first reading needs no debouncing
            errors = [e for e in self._pin_errors if e]
            self.error = "; ".join(errors) or None
        if self.error and self.error != old:
            log.warning("Inngangene: %s – prøver igjen om %d s", self.error, RETRY_SECONDS)
        elif old and not self.error:
            log.info("Inngangene leses fra GPIO %s", ", ".join(map(str, self.pins)))

    def _read(self, i):
        level = lgpio.gpio_read(self._chip, self.pins[i])
        return level == 0 if self.active_low else level == 1

    def _poll(self, now):
        for i in range(len(self.pins)):
            if not self._claimed[i]:
                continue
            try:
                level = self._read(i)
            except lgpio.error as e:
                self._pin_errors[i] = f"GPIO{self.pins[i]} ({self.names[i]}): {e}"
                self.error = "; ".join(err for err in self._pin_errors if err)
                log.warning("Inngangene: %s", self._pin_errors[i])
                self._claimed[i] = False
                try:
                    lgpio.gpio_free(self._chip, self.pins[i])  # claimed again at the next try
                except lgpio.error:
                    pass
                continue
            with self._lock:
                if level == self._real[i]:
                    self._cand[i] = level
                    continue
                if self._cand[i] != level:
                    self._cand[i], self._since[i] = level, now
                if now - self._since[i] >= self.debounce:
                    self._real[i] = level

    def _loop(self):
        while True:
            now = time.monotonic()
            if not all(self._claimed) and now >= self._next_try:
                self._claim()
            self._poll(now)
            self._update()
            time.sleep(POLL if any(self._claimed) else 0.2)

    # --- state -------------------------------------------------------------

    def _update(self):
        """Tells the listeners about the inputs that went on or off."""
        with self._fire:
            now = time.monotonic()
            with self._lock:
                changes = []
                for i in range(len(self.pins)):
                    on = self._real[i] or self._virtual[i] > now
                    if on != self._state[i]:
                        self._state[i] = on
                        changes.append((i, on))
            for i, on in changes:
                log.debug("%s %s", self.names[i], "på" if on else "av")
                for fn in self._listeners:
                    try:
                        fn(i, on)
                    except Exception:  # a display's trouble must not stop the inputs
                        log.exception("%s: feil i håndteringen", self.names[i])

    def press(self, i, on):
        """A press from the editor, as if the switch was turned on (or off again)."""
        with self._lock:
            self._virtual[i] = time.monotonic() + VIRTUAL_SECONDS if on else 0.0
        self._update()

    def states(self):
        with self._lock:
            return list(self._state)

    def values(self):
        """inn0 … inn7 as data sources."""
        return {name.lower(): on for name, on in zip(self.names, self.states())}

    def meta(self):
        return {name.lower(): {"label": f"{name} (GPIO{pin})", "group": "Innganger", "type": "boolean"}
                for name, pin in zip(self.names, self.pins)}

    def status(self):
        now = time.monotonic()
        with self._lock:
            rows = [{"index": i, "name": self.names[i], "gpio": pin, "on": self._state[i],
                     "switch": self._real[i], "pressed": self._virtual[i] > now, "read": self._claimed[i]}
                    for i, pin in enumerate(self.pins)]
        return {"enabled": self.enabled, "error": self.error, "inputs": rows}
