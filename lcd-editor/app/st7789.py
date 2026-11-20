"""ST7789 colour TFT on SPI, e.g. the 2.25" 76×284 bar display.

The controller has memory for 240×320 pixels, and smaller panels show a window
of it, so the panel's offset in that memory matters. The panel is always driven
in its own (portrait) orientation and the image is rotated before it is sent,
so one offset fits every rotation.

Only the rectangle that changed since the last frame is sent. Nothing answers on
SPI, so a panel that was unplugged and plugged back in can't be noticed; instead
the setup and a whole frame are sent again every RESEND_SECONDS.

The backlight uses hardware PWM when an overlay has given its pin to a PWM
controller (on a Pi 5: dtoverlay=pwm,pin=18,func=2), else lgpio's software PWM.
"""

import logging
import os
import re
import subprocess
import time
from pathlib import Path

import lgpio
import numpy as np
import spidev
from PIL import Image, ImageChops

from .gpio import header_chip

RAM_W, RAM_H = 240, 320

SWRESET, SLPOUT, NORON = 0x01, 0x11, 0x13
INVOFF, INVON, DISPOFF, DISPON = 0x20, 0x21, 0x28, 0x29
CASET, RASET, RAMWR = 0x2A, 0x2B, 0x2C
MADCTL, COLMOD = 0x36, 0x3A
MADCTL_BGR = 0x08
RGB565 = 0x55

PWM_HZ = 1000  # software PWM; more would only add jitter
HW_PWM_PERIOD_NS = 200_000  # 5 kHz
PWM_SYSFS = Path("/sys/class/pwm")
RP1_PWM = {"PWM0": "1f00098000.pwm", "PWM1": "1f0009c000.pwm"}  # Pi 5, named as pinctrl names them
RESEND_SECONDS = 10
# rotate as in luma: 1 = the picture is turned 90° clockwise on the panel
TRANSPOSE = {1: Image.Transpose.ROTATE_270, 2: Image.Transpose.ROTATE_180, 3: Image.Transpose.ROTATE_90}

log = logging.getLogger(__name__)


def _pin_function(pin):
    """What the pin is muxed to, e.g. "PWM0_CHAN2", or None for a plain GPIO or without pinctrl."""
    try:
        out = subprocess.run(["pinctrl", "get", str(pin)], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"= (\S+)$", out.strip())
    return m[1] if m else None


class _HardwarePWM:
    """A PWM channel through sysfs, writable for the gpio group (Raspberry Pi OS udev rule)."""

    def __init__(self, path):
        self.path = path

    @classmethod
    def find(cls, pin):
        """The channel driving this pin, or None when the pin has no hardware PWM."""
        m = re.fullmatch(r"(PWM\d)_CHAN(\d)", _pin_function(pin) or "")
        if not m or m[1] not in RP1_PWM:
            return None
        for chip in PWM_SYSFS.glob("pwmchip*"):
            if (chip / "device").resolve().name != RP1_PWM[m[1]]:
                continue  # the chips are numbered in the order they were found at boot
            channel = chip / f"pwm{m[2]}"
            if not channel.exists():
                (chip / "export").write_text(m[2])
            for _ in range(40):  # udev makes the new files writable just after the export
                if os.access(channel / "enable", os.W_OK):
                    return cls(channel)
                time.sleep(0.05)
            raise OSError(f"kan ikke skrive til {channel}")
        return None

    def _write(self, name, value):
        (self.path / name).write_text(str(value))

    def set(self, fraction):
        if int((self.path / "period").read_text()) != HW_PWM_PERIOD_NS:
            self._write("duty_cycle", 0)  # it may never exceed the period
            self._write("period", HW_PWM_PERIOD_NS)
        self._write("duty_cycle", round(HW_PWM_PERIOD_NS * fraction))
        self._write("enable", 1)


def _rgb565(img):
    a = np.asarray(img, dtype=np.uint16)
    return ((a[..., 0] & 0xF8) << 8 | (a[..., 1] & 0xFC) << 3 | a[..., 2] >> 3).astype(">u2").tobytes()


class ST7789:
    def __init__(self, spi_port, spi_device, dc, reset, backlight, width, height, rotate=0,
                 offset_x=None, offset_y=None, invert=True, bgr=False, speed_hz=32_000_000, brightness=255,
                 backlight_active_low=False):
        self.width, self.height = width, height
        self.offset = ((RAM_W - width) // 2 if offset_x is None else int(offset_x),
                       (RAM_H - height) // 2 if offset_y is None else int(offset_y))
        self.transpose = TRANSPOSE.get(rotate % 4)
        self.pins = {"dc": dc, "reset": reset, "backlight": backlight}
        self.invert, self.bgr = invert, bgr
        self.active_low = bool(backlight_active_low)  # some modules light up when BLK is low
        self.level = max(0, min(int(brightness), 255))
        self._on = True
        self._last = None
        self._set_up_at = 0
        self._gpio = None
        self._pwm = None
        self._spi = spidev.SpiDev()
        try:
            self._spi.open(spi_port, spi_device)
            self._spi.mode = 0
            self._spi.max_speed_hz = speed_hz
            if backlight >= 0:
                try:
                    self._pwm = _HardwarePWM.find(backlight)
                except OSError as e:
                    log.warning("Maskinvare-PWM på GPIO%d virker ikke (%s), bruker programvare-PWM", backlight, e)
            if self._pwm:  # backlight stays off until the panel holds a picture
                self._pwm.set(1.0 if self.active_low else 0.0)
                log.info("Bakgrunnslys med maskinvare-PWM: %s", self._pwm.path)
            try:
                self._gpio = header_chip()
                for name, pin in self._gpio_pins().items():
                    lgpio.gpio_claim_output(self._gpio, pin, int(self.active_low) if name == "backlight" else 1)
            except lgpio.error as e:
                raise OSError(f"GPIO: {e}") from None
            self.init()
        except Exception:
            self.close()
            raise

    # --- low level -------------------------------------------------------

    def _gpio_pins(self):
        return {name: pin for name, pin in self.pins.items()
                if pin >= 0 and not (name == "backlight" and self._pwm)}

    def _pin(self, name, level):
        if self.pins[name] >= 0:
            lgpio.gpio_write(self._gpio, self.pins[name], level)

    def _command(self, cmd, *params):
        self._pin("dc", 0)
        self._spi.writebytes([cmd])
        if params:
            self._data(bytes(params))

    def _data(self, data):
        self._pin("dc", 1)
        self._spi.writebytes2(data)  # split into spidev's buffer size by the library

    def _window(self, x0, y0, x1, y1):
        ox, oy = self.offset
        self._command(CASET, *(x0 + ox).to_bytes(2, "big"), *(x1 - 1 + ox).to_bytes(2, "big"))
        self._command(RASET, *(y0 + oy).to_bytes(2, "big"), *(y1 - 1 + oy).to_bytes(2, "big"))
        self._command(RAMWR)

    def _backlight(self):
        pin = self.pins["backlight"]
        if pin < 0:
            return
        duty = self.level / 2.55 if self._on else 0
        if self.active_low:
            duty = 100 - duty
        if self._pwm:
            self._pwm.set(duty / 100)  # stays as it is when the service stops
            return
        if 0 < duty < 100:
            lgpio.tx_pwm(self._gpio, pin, PWM_HZ, duty)
            return
        if lgpio.tx_busy(self._gpio, pin, lgpio.TX_PWM):
            lgpio.tx_pwm(self._gpio, pin, 0, 0)  # stops PWM, but fails with "bad PWM micros" when none runs
        lgpio.gpio_write(self._gpio, pin, 1 if duty else 0)

    def _setup(self, wake):
        """Wakes the panel and sets its pixel format; repeating it on a panel that is set up changes nothing."""
        self._command(SLPOUT)
        time.sleep(wake)  # 5 ms is enough for the next command, 120 ms after a reset
        self._command(COLMOD, RGB565)
        self._command(MADCTL, MADCTL_BGR if self.bgr else 0)
        self._command(INVON if self.invert else INVOFF)
        self._command(NORON)
        time.sleep(0.01)
        self._set_up_at = time.monotonic()

    # --- API ---------------------------------------------------------------

    def init(self):
        if self.pins["reset"] >= 0:
            self._pin("reset", 0)
            time.sleep(0.01)
            self._pin("reset", 1)
            time.sleep(0.12)
        self._command(SWRESET)
        time.sleep(0.15)
        self._setup(wake=0.12)
        self._window(0, 0, self.width, self.height)
        self._data(bytes(self.width * self.height * 2))  # the memory starts out as noise
        self._command(DISPON if self._on else DISPOFF)
        self._last = None
        self._backlight()

    def display(self, image):
        """Shows an RGB image of the layout's size (the panel's size, rotated)."""
        frame = image.convert("RGB")
        if self.transpose is not None:
            frame = frame.transpose(self.transpose)
        resend = time.monotonic() - self._set_up_at > RESEND_SECONDS
        if resend:
            self._setup(wake=0.01)
        if self._last is None or resend:
            box = (0, 0, *frame.size)
        else:
            box = ImageChops.difference(frame, self._last).getbbox()
        if box:
            self._window(*box)
            self._data(_rgb565(frame.crop(box)))
        if resend:  # after the frame, so a panel that just got power never shows its noise
            self._command(DISPON if self._on else DISPOFF)
        self._last = frame

    def show(self):
        self._on = True
        self._command(DISPON)
        self._backlight()

    def hide(self):
        self._on = False
        self._command(DISPOFF)
        self._backlight()

    def contrast(self, level):
        """Backlight brightness 0–255 (named like luma's, so it works like an OLED's contrast)."""
        self.level = max(0, min(int(level), 255))
        self._backlight()

    def close(self):
        if self._gpio is not None:
            for pin in self._gpio_pins().values():
                try:
                    lgpio.gpio_free(self._gpio, pin)
                except lgpio.error:
                    pass
            lgpio.gpiochip_close(self._gpio)
            self._gpio = None
        self._spi.close()
