"""HD44780 character LCD behind a PCF8574 I2C backpack ("1602 IIC" / "2004 IIC").

The backpack's eight outputs drive the LCD in 4-bit mode:
P0 = RS, P1 = RW, P2 = E, P3 = backlight, P4–P7 = D4–D7.

Only the characters and custom glyphs that changed since the last frame are
sent, so a refresh is usually a handful of I2C writes and never flickers.
"""

import time

from smbus2 import SMBus, i2c_msg

from .lcdfont import CODE_SPACE, CUSTOM_SLOTS

RS, EN, BACKLIGHT = 0x01, 0x04, 0x08

CLEAR = 0x01
ENTRY_MODE = 0x06      # cursor moves right, no display shift
DISPLAY_ON = 0x0C      # display on, cursor and blink off
DISPLAY_OFF = 0x08
FUNCTION_SET = 0x20    # 4-bit bus, 5×8 dots
TWO_LINES = 0x08
SET_CGRAM = 0x40
SET_DDRAM = 0x80


class HD44780:
    def __init__(self, bus, address, cols, rows, backlight=True):
        self.address = address
        self.cols, self.rows = cols, rows
        self.row_offsets = [0x00, 0x40, cols, 0x40 + cols]
        self.backlight = backlight
        self._on = True
        self._bus = SMBus(bus)
        try:
            self.init()
        except OSError:
            self._bus.close()
            raise

    # --- low level -------------------------------------------------------

    @property
    def _bl(self):
        return BACKLIGHT if self.backlight and self._on else 0

    def _write(self, data):
        # One transaction per instruction. Each byte takes ≥ 22 µs on the bus
        # (400 kHz), which covers the LCD's enable pulse and setup times.
        self._bus.i2c_rdwr(i2c_msg.write(self.address, data))

    def _nibble(self, nibble, rs=0):
        d = (nibble << 4) | rs | self._bl
        return [d, d | EN, d]  # the LCD latches on the falling edge of E

    def _send(self, value, rs=0):
        self._write(self._nibble(value >> 4, rs) + self._nibble(value & 0x0F, rs))

    # --- API ---------------------------------------------------------------

    def init(self):
        """Datasheet "initialising by instruction": also recovers from a lost nibble."""
        self._write([self._bl])
        time.sleep(0.05)
        for delay in (0.0045, 0.0045, 0.00015):
            self._write(self._nibble(0x3))  # 8-bit mode, three times
            time.sleep(delay)
        self._write(self._nibble(0x2))  # now 4-bit
        self._send(FUNCTION_SET | (TWO_LINES if self.rows > 1 else 0))
        self._send(DISPLAY_OFF)
        self._send(CLEAR)
        time.sleep(0.002)
        self._send(ENTRY_MODE)
        self._send(DISPLAY_ON if self._on else DISPLAY_OFF)
        self._ddram = [[CODE_SPACE] * self.cols for _ in range(self.rows)]
        self._cgram = [None] * CUSTOM_SLOTS

    def display(self, frame):
        """Shows a charrender.Frame."""
        # Reuse slots that already hold the same glyph, so they don't flicker.
        slot = {i: self._cgram.index(g) for i, g in enumerate(frame.glyphs) if g in self._cgram}
        free = [s for s in range(CUSTOM_SLOTS) if s not in slot.values()]
        for i, glyph in enumerate(frame.glyphs):
            if i in slot:
                continue
            s = slot[i] = free.pop(0)
            self._send(SET_CGRAM | s << 3)
            for row in glyph:
                self._send(row, RS)
            self._cgram[s] = glyph

        for r in range(min(self.rows, frame.rows)):
            want = [slot[c] if c < CUSTOM_SLOTS else c for c in frame.codes[r][:self.cols]]
            have = self._ddram[r]
            changed = [i for i, c in enumerate(want) if c != have[i]]
            if not changed:
                continue
            # One address command and a run of characters beats many address commands.
            start, end = changed[0], changed[-1] + 1
            self._send(SET_DDRAM | (self.row_offsets[r] + start))
            for c in want[start:end]:
                self._send(c, RS)
            have[start:end] = want[start:end]

    def show(self):
        self._on = True
        self._send(DISPLAY_ON)

    def hide(self):
        self._on = False
        self._send(DISPLAY_OFF)

    def set_backlight(self, on):
        self.backlight = bool(on)
        self._write([self._bl])

    def close(self):
        self._bus.close()
