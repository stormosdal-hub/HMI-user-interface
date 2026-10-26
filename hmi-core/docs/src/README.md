# Diagramkilder

Diagrammene lages av disse skriptene (Python 3, ingen pakker trengs):

```bash
python arch.py       # skriver ../architecture.svg
python plc.py        # skriver ../plc-ouc.svg
python tcplink.py    # skriver ../tcplink.svg
python tcplink_history.py   # skriver ../tcplink-history.svg (historikken fra PLS-ens ringbuffer)
python examples.py   # skriver ../../adapters/example-adapters/example-adapters.svg og adapter-messages.svg
python replay.py     # skriver ../replay.svg (forslag: opplasting og avspilling etter strømbrudd)
```

`svgkit.py` inneholder den felles fargepaletten og hjelpefunksjonene for bokser, piler og
tekst. Boksene bryter teksten sin og vokser så den får plass, så når du endrer en setning,
trenger du ikke nye koordinater.
