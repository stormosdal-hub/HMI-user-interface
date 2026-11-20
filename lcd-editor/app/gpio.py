"""The GPIO chip behind the 40-pin header, for the TFT's pins and the board's inputs."""

import lgpio


def header_chip():
    """A handle to the header's GPIOs: RP1 on a Pi 5, the SoC's own on older Pis."""
    for n in range(16):
        try:
            handle = lgpio.gpiochip_open(n)
        except lgpio.error:
            continue
        if lgpio.gpio_get_chip_info(handle)[3].startswith(("pinctrl-rp1", "pinctrl-bcm")):
            return handle
        lgpio.gpiochip_close(handle)
    raise OSError("fant ikke GPIO-ene på 40-pinners-kontakten")
