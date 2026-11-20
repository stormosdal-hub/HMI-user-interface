# LCD-editoren: skjermbilder til displayer på Pi-en i kjøreverket

En nettleserbasert editor for å lage skjermbilder til SSD1306-displayer (og SH1106/SSD1309) og
1602/2004 tegn-LCD-er med I2C-adapter (PCF8574), koblet til Raspberry Pi over I2C, og ST7789 farge-TFT-er
over SPI. Legg til tekst, ikoner, figurer, stolper, grafer og bilder, koble dem til **taggene fra huben**
(de samme som i HMI-et: hastigheten, momentet, bitene fra PLS-en, beregningene …) eller til data fra
Pi-en (klokke, CPU-temp, IP …), og trykk **Deploy** for å vise layouten på displayet.

Forhåndsvisningen rendres på Pi-en med akkurat samme kode som driver displayet, så det du ser i
nettleseren er piksel for piksel det som havner på displayet.

En layout kan ha flere **faner**, og bryterne på inngangene INN0–INN7 på RaspiPower-kortet blar mellom
dem, se [Faner og innganger](#faner-og-innganger).

## Taggene fra huben

Editoren kobler seg til huben på samme Pi (`ws://127.0.0.1:8080`) som et HMI som bare leser, slik
recorderen gjør, og får alle taggene og hver endring. Den skriver aldri noe til huben eller PLS-en.

- **Under «Datakilder»** kommer hubens tagger først: `Hub: pls.*` (PLS-en), `Hub: calc.*`
  (beregningene i HMI-prosjektet) og `Hub: rec.*` (recorderen). Navnet som står, er ditt eget fra
  *Tag-list* i HMI-et, ellers navnet fra PLS-en. Linjen over listen sier om editoren har kontakt med
  huben, og hvor mange tagger den har.
- **Bruk dem som alle andre kilder:** klikk på en tag for å legge den til som verdi, eller skriv den i
  en tekst: `n = {calc.kv_speed_rpm:.0f} rpm`. Stolper og grafer tar også en tag.
- **Bitene** (true/false) vises som `1` og `0`. En verdi med en bit får i tillegg feltene *Tekst når 1*
  og *Tekst når 0*, for eksempel «Klar» og «Ikke klar». I en graf er en bit 0 og 1.
- **`--` i stedet for en frosset verdi:** mens forbindelsen til PLS-en er nede (taggen har dårlig
  kvalitet), og mens huben er borte, viser verdien `--`. `pls.link` er selv en bit som er `0` når
  forbindelsen er nede. Editoren kobler seg til igjen hvert 3. sekund.
- **Alarmene:** `alarms_active` er antallet aktive alarmer (med varslene), og `alarm_text` er
  teksten til den nyeste aktive, eller tom når ingen er aktive.
- **Grafene** har historikken fra editoren startet: ett punkt per sekund, opptil en time.
- **Variablene fra HMI-et** (`${pls}`) brukes ikke her: skriv `pls.reals_0`.
- **En annen hub**, eller ingen: `[hub]` i `config.toml`.

## 1. Koble til displayet

**I kjøreverket** sitter Pi-en på RaspiPower-kortet, som bruker nesten alle GPIO-ene til inngangene og
24 V-utgangene sine. **Koble displayene bare til pluggen X1** på kortet: den har strøm, I2C og SPI, og
ingen av pinnene går til en inngang eller utgang. X1 er en 2×5-kontakt med 2,54 mm avstand
(pinne 1 og 2 ved siden av hverandre, de odde pinnene på én rad):

| X1 | Signal | Raspberry Pi            |   | X1 | Signal | Raspberry Pi            |
|----|--------|-------------------------|---|----|--------|-------------------------|
| 1  | GND    | GND                     |   | 2  | 5 V    | 5 V                     |
| 3  | 3,3 V  | 3,3 V                   |   | 4  | SDA1   | GPIO 2 (pinne 3)        |
| 5  | MOSI   | GPIO 10 (pinne 19)      |   | 6  | SCL1   | GPIO 3 (pinne 5)        |
| 7  | MISO   | GPIO 9 (pinne 21)       |   | 8  | SCLK   | GPIO 11 (pinne 23)      |
| 9  | CE0    | GPIO 8 (pinne 24)       |   | 10 | CE1    | GPIO 7 (pinne 26)       |

Finn pinne 1 med et multimeter når kortet har strøm: 5 V mellom pinne 2 og 1, og 3,3 V mellom
pinne 3 og 1. X1 har bare én pinne for GND, 5 V og 3,3 V, så flere displayer samtidig trenger en
kabel som deler dem.

| SSD1306 | X1                 |
|---------|--------------------|
| GND     | 1 (GND)            |
| VCC     | 3 (3,3 V)          |
| SCL     | 6 (SCL1, GPIO 3)   |
| SDA     | 4 (SDA1, GPIO 2)   |

### 1602 LCD med I2C-adapter (PCF8574)

| LCD-adapter | X1                                      |
|-------------|-----------------------------------------|
| GND         | 1 (GND)                                 |
| VCC         | 2 (5 V)                                 |
| SDA         | 4 (SDA1, GPIO 2) – delt med OLED-en     |
| SCL         | 6 (SCL1, GPIO 3) – delt med OLED-en     |

LCD-et og OLED-en kan henge på samme I2C-buss, siden de har ulike adresser.
Adapteren har adresse **0x27** (eller **0x3F** med PCF8574A-brikke).

**Om 5 V:** LCD-et trenger 5 V. Adapteren har ofte pull-up-motstander til 5 V på SDA/SCL, mens Pi-ens
GPIO-pinner bare tåler 3,3 V. Mange kobler dette direkte uten problemer, men det trygge er en
I2C-nivåomformer, eller å fjerne de to pull-up-motstandene på adapteren.

**Ser du ingen tekst?** Skru på det blå kontrastpotmeteret bak på adapteren. Én rad med fylte firkanter
betyr at LCD-et har strøm, men ikke får kontakt (sjekk adresse og kabler).

### 2.25" farge-TFT 76×284 (ST7789, SPI)

Pinnene på modulen heter ofte SCL/SDA selv om det er **SPI**, ikke I2C – ikke koble dem til I2C-pinnene.

| TFT       | X1                                  |
|-----------|-------------------------------------|
| GND       | 1 (GND)                             |
| VCC       | 3 (3,3 V)                           |
| SCL / SCK | 8 (SCLK, GPIO 11)                   |
| SDA / DIN | 5 (MOSI, GPIO 10)                   |
| CS        | 9 (CE0, GPIO 8)                     |
| DC / RS   | 10 (CE1, GPIO 7)                    |
| BLK / BL  | 7 (MISO, GPIO 9) – lysstyrke        |
| RES / RST | 3 (3,3 V), sammen med VCC           |

X1 har ingen ledig GPIO til DC og BLK, så de bruker CE1 og MISO: TFT-en har bare én CS, og den sender
bare, så SPI trenger ingen av dem. **De blir vanlige GPIO-er med en linje i `config.txt`** (se 2.).
RES trenger ingen pinne: editoren sender en reset-kommando over SPI. `config.toml` har pinnene.

**Bruk ikke andre GPIO-er:** de går til kortets innganger og utganger. GPIO 18, 24 og 25, som mange
oppskrifter for ST7789 bruker, er utgangene UTL6, UTL2 og UTL1. Går BLK rett til 3,3 V eller GND, sett
`backlight_pin = -1` (da virker ikke lysstyrke, og «Slå av» slukker bare bildet).

Over SPI kan ikke Pi-en spørre displayet om det er der, så «Tilkoblet» betyr bare at SPI og GPIO-ene
virker. Derfor sendes oppsettet og hele bildet på nytt hvert 10. sekund: kobler du TFT-en fra og
til igjen mens editoren kjører, kommer bildet tilbake av seg selv. Ser du ingenting på skjermen:

- **Svart, men lyset er på:** sjekk SCL/SDA/DC/CS, eller senk `spi_mhz` (f.eks. til 16) med lange ledninger.
- **Negative farger** (svart blir hvitt): bytt `invert` (true ↔ false).
- **Lysstyrken går motsatt vei** (svart på full, hvitt på minimum): sett `backlight_active_low = true`.
- **Rødt og blått byttet om:** sett `bgr = true`.
- **Opp ned:** bytt `rotate = 1` til `rotate = 3` (eller `0`/`2` for stående 76×284).
- **Forskjøvet bilde eller støy i kanten:** sett `offset_x`/`offset_y` (standard 82 og 18 for 76×284).

## 2. Slå på I2C og SPI (én gang)

`install.sh --lcd` (se 3.) gjør dette. Den legger to linjer nederst i `/boot/firmware/config.txt`, i en
`[all]`-del, hvis de ikke står der fra før. Den sørger også for at `i2c-dev` lastes, med
`/etc/modules-load.d/kjoreverk-lcd.conf`.

```
dtparam=i2c_arm=on
dtoverlay=spi0-1cs,no_miso
```

Den andre linjen gir SPI med bare én CS og uten MISO, så CE1 og MISO blir vanlige GPIO-er til
TFT-ens DC og lys (se 1.). Står det `dtoverlay=spi0-1cs` uten `no_miso` fra før, endrer ikke skriptet
linjen, men sier fra. Uten `install.sh` legger du linjene inn selv.

Linjene virker etter en omstart, og `install.sh` sier fra til slutt når det trengs: `sudo reboot`.
Etterpå skal displayene dukke opp:

```bash
i2cdetect -y 1                        # OLED vanligvis som 3c, LCD som 27 eller 3f
ls /dev/spidev0.*                     # skal vise bare /dev/spidev0.0
```

Tips: for raskere oppdatering, legg `dtparam=i2c_arm_baudrate=400000` i `/boot/firmware/config.txt`.

Lysstyrken styres med programvare-PWM, som kan flimre litt på delvis lysstyrke. Maskinvare-PWM
finnes bare på GPIO 12, 13, 18 og 19, og i kjøreverket går alle fire til kortet.

## 3. Start editoren

Editoren er av som standard. `install.sh` setter den opp som tjenesten `kjoreverk-lcd` når du ber om
det, med pakkene den trenger og I2C og SPI på (se 2.), og så er den på til du slår den av:

```bash
sudo bash /opt/kjoreverk/install.sh --lcd       # på, også etter omstart
sudo bash /opt/kjoreverk/install.sh --no-lcd    # av
journalctl -u kjoreverk-lcd -f                  # loggen
```

Åpne **`http://<pi-ip>:8000`** i en nettleser på samme nett, eller `http://192.168.1.<kjøreverksnummer>:8000`
over Bluetooth. **HMI ↗** øverst til høyre åpner HMI-et på samme Pi. Den sist deployede layouten vises
igjen av seg selv etter en omstart.

**Pi-en trenger** Raspberry Pi OS Bookworm eller nyere (Python 3.11 eller nyere), og noen pakker fra
apt. `install.sh --lcd` installerer dem som mangler:

| Pakker | Til |
|---|---|
| `python3-flask python3-pil` | editoren (må være der) |
| `python3-psutil` | Pi-ens egne verdier: CPU, minne, IP … |
| `python3-smbus2` | displayene på I2C: OLED og LCD |
| `python3-lgpio` | inngangene INN0–INN7, og TFT-en |
| `python3-spidev python3-numpy` | TFT-en |
| `i2c-tools` | `i2cdetect`, som finner displayene på I2C |
| `luma.oled` (ikke i apt, se under) | OLED-ene |

Pakkene lastes ned, så Pi-en trenger internett første gang. Får apt ikke installert noen av dem, sier
`install.sh` hvilke, og du kan kjøre den igjen når Pi-en har nett. Uten flask og PIL setter den ikke
opp editoren; resten av kjøreverket settes opp som vanlig. Et display som mangler sin pakke, kjører
emulert, og editoren sier hvorfor.

**`luma.oled`** installeres i en `.venv` i `lcd-editor/`, som `install.sh` bruker når den finnes:

```bash
cd /opt/kjoreverk/lcd-editor
python3 -m venv --system-site-packages .venv
.venv/bin/pip install luma.oled
sudo bash /opt/kjoreverk/install.sh --lcd
```

Uten internett på Pi-en: kjør `pip download luma.oled -d wheels` på en Pi med samme Raspberry Pi OS
og internett, ta med `wheels/` på en minnepenn, og installer med
`.venv/bin/pip install --no-index --find-links /media/$USER/<minnepennen>/wheels luma.oled`.

- **Ingenting skrives til SD-kortet** mens kjøreverket går: layoutene og hva displayene viser
  (`layouts/`, `state/`) bare når noen trykker *Lagre* eller *Deploy*, eller endrer kontrasten, lyset
  eller av/på. Tjenesten kjører `python3 -B`, så Python skriver ingen `.pyc`-filer, og loggen er i
  RAM som de andre.
- **Har Pi-en LCD-editorens egen tjeneste** fra før (`oled-editor`, fra `install-service.sh`), bruker den
  samme port og displayer. Stopp den først: `sudo systemctl disable --now oled-editor`.
- **For hånd**, for eksempel for å se feilmeldinger: `sudo systemctl stop kjoreverk-lcd`, så
  `cd /opt/kjoreverk/lcd-editor && python3 -B -m app`.

## Bruke editoren

- **Legg til**-knappene lager nye elementer. Dra dem rundt på skjermen, dra i hjørnet for å endre
  størrelse (hold Shift for å beholde forholdet). Piltaster flytter 1 px, Shift+pil 8 px.
- **Verdi** viser én datakilde med desimaler, tekst foran/etter. Klikk på en kilde i panelet
  til høyre for å legge den til direkte.
- **Tekst** kan blande inn verdier med `{kilde}`, f.eks. `{calc.kv_speed_rpm:.0f} rpm`,
  `CPU {cpu_temp:.1f}°C` eller `{weekday} {time}` (Python-format etter kolon).
- **Stolpe** og **Graf** viser tallverdier. Grafen viser historikk – ett punkt per sekund, opptil en time.
- **Tegnemodus «Inverter (XOR)»** gjør at tekst oppå en stolpe eller fylt boks blir lesbar.
- **Fonter**: Silkscreen, Press Start 2P og VT323 er pikselfonter som blir skarpe i størrelsene som står
  i listen. Egne `.ttf`-fonter kan legges i `fonts/`.
- **Lagre** lagrer til `layouts/`. **Deploy** lagrer *og* sender layouten til displayet som er valgt
  øverst til høyre, med alle fanene. «På displayet nå» viser hva displayet faktisk viser.
- Kontrast/lysstyrke, «Slå av» og LCD-lyset huskes mellom omstarter. Verdiene i `config.toml`
  gjelder bare til du endrer dem i editoren (slett `state/settings-<id>.json` for å gå tilbake til dem).
- Displayfargen (hvit, blå, gul/blå) påvirker bare forhåndsvisningen.

### Tegn-LCD (1602/2004)

Velg LCD-et ved Deploy-knappen og trykk **Ny**. Editoren viser da et LCD med tegnruter i stedet for piksler:

- Elementene plasseres i kolonner og rader. Du har **Tekst**, **Verdi**, **Ikon**, **Stolpe** og **Graf**.
- Tekst og verdier kan få en **feltbredde** (dra i håndtaket til høyre) og justeres i feltet. Høyrejusterte
  tall står stille selv om antall siffer endres.
- LCD-et har en innebygd font med ASCII, `°`, `ä`, `ö`, `ü`, `µ`, `Ω`, `π`, `→` og `←`. **Æ, ø og å**,
  ikonene, stolper og grafer lages som egne tegn, og LCD-et har bare plass til **8 egne tegn** om gangen.
  Editoren sier fra når det blir for mange.
- Forhåndsvisningen etterligner LCD-ets innebygde font (A00, som nesten alle 1602-moduler har).
  Enkelte tegn kan se litt annerledes ut på ditt display.
- Kontrasten stilles med potmeteret på adapteren. Bakgrunnslyset slås av og på under «På displayet nå».

### Farge-TFT (ST7789)

Velg TFT-en ved Deploy-knappen og trykk **Ny**. Du har de samme elementene som på OLED-en, men hvert
element har sin egen **farge** (velg fra paletten eller fargevelgeren), og layouten har en **bakgrunnsfarge**.
Tekst i vanlige fonter (f.eks. DejaVuSans) tegnes med kantutjevning, pikselfonter forblir skarpe, og
bilder vises i farger. Glidebryteren «Lysstyrke» styrer bakgrunnslyset.

Hvis displayet ikke svarer, kjører alt videre i «emulert» modus, og editoren forteller hva som er feil.
Serveren prøver å koble til på nytt hvert 10. sekund.

## Faner og innganger

En layout kan ha flere **faner**, hver med sine egne elementer. Displayet viser alltid én av dem, og
bryterne på kortets innganger **INN0–INN7** blar mellom dem.

- **Fanene** står over skjermen. Klikk på en fane for å redigere den, og på **+ Ny fane** for å lage en
  ny. Under **Fane** til venstre gir du fanen et navn, flytter den, dupliserer den eller sletter den.
  Alle fanene har displayets størrelse, og layoutens oppdateringstid og bakgrunn.
- **Innganger** (under «På displayet nå»): velg hva hver inngang gjør når bryteren slås på.

  | Handling | Hva displayet viser |
  |---|---|
  | Neste fane | neste fane; etter den siste kommer den første |
  | Forrige fane | forrige fane; før den første kommer den siste |
  | Gå til fanen | fanen du velger. Én knapp per fane, eller en trinnbryter med én inngang per stilling |
  | Vis fanen mens den er på | fanen du velger, så lenge inngangen er på. Slås den av, kommer fanen fra før tilbake. Til en vippebryter, eller en knapp du holder inne |

  En inngang har én handling i en layout. Flere displayer kan bruke den samme inngangen.
- **Deploy** sender alle fanene og inngangene, og displayet viser fanen du står på i editoren. Under
  «På displayet nå» står hvilken fane displayet viser («Fane 2 av 3»), med piler som bytter den. Den
  grønne prikken i fanene over skjermen viser det samme.
- **Prøv uten brytere:** hold inne en INN-knapp i editoren, så er det som om bryteren var på. Lampen
  på knappen lyser når inngangen er på, enten det er bryteren eller knappen. Med den kan du også
  sjekke koblingen.
- **Vis fanen på displayet:** skriv `{tab}`, `{tab_count}` eller `{tab_name}` i en tekst, for eksempel
  `{tab}/{tab_count}` eller `{tab_name}`. Inngangene er også datakilder: `inn0`–`inn7` er 1 når
  inngangen er på.
- **Ingenting lagres når fanen byttes.** Etter en omstart viser displayet den første fanen, eller fanen
  til en inngang med «Gå til fanen» eller «Vis fanen mens den er på» som er på.
- En layout fra før fanene kom, er én fane.

### Koble til bryterne

Inngangene kommer inn på kontakten **SV2** på kortet. Hver har en gul lysdiode og en optokobler, som
gjør 24 V om til en GPIO som Pi-en leser. Koble bryteren mellom **+24 V** og inngangen. Bruk den samme
24 V-forsyningen som kortet får på SV2-23 (+24 V) og SV2-24 (GND). Lysdioden ved inngangen lyser når
inngangen er på. Hver inngang trekker omtrent 5 mA.

| Inngang   | INN0 | INN1 | INN2 | INN3 | INN4 | INN5 | INN6 | INN7 |
|-----------|------|------|------|------|------|------|------|------|
| SV2-pinne | 7    | 8    | 5    | 6    | 3    | 4    | 1    | 2    |
| GPIO      | 16   | 26   | 20   | 21   | 19   | 13   | 12   | 6    |

- **Editoren leser bare inngangene,** med `python3-lgpio`. Tjenesten er med i gruppen `gpio`.
- **Uten lgpio**, eller hvis et annet program har tatt GPIO-ene, står det under «Innganger». Knappene i
  editoren virker likevel.
- **En bryter teller** når den har ligget i ro i 30 ms. Den tiden er `debounce_ms` i `[inputs]` i
  `config.toml`.
- **`enabled = false`** i `[inputs]` lar GPIO-ene være i fred.

## Datakilder

**Huben:** alle taggene i kjøreverket, se [Taggene fra huben](#taggene-fra-huben).

**Innebygd:** klokke/dato/ukedag, vertsnavn, IP, CPU-temp/-bruk/-frekvens, last, minne, disk, oppetid,
nettverkstrafikk og viftehastighet (Pi 5).

**Egne kilder i `config.toml`** – en shell-kommando, en fil eller en URL:

```toml
[[source]]
name = "ute_temp"
label = "Utetemperatur"
unit = "°C"
type = "file"
path = "/sys/bus/w1/devices/28-*/temperature"
scale = 0.001
interval = 10
```

Se `config.toml` for flere eksempler (`command`, `http`, `json`, `regex`). Start tjenesten på nytt etter
endringer: `sudo systemctl restart kjoreverk-lcd`.

**Python-plugins** for sensorer (f.eks. BME280 på I2C): se `plugins/bme280.py.example`. En plugin er en
`.py`-fil i `plugins/` med en `read()`-funksjon som returnerer et dict.

**Push fra andre programmer** – nyttig fra cron-jobber, Node-RED, Home Assistant osv.:

```bash
curl -X POST http://localhost:8000/api/push/ute_temp -d 21.5
curl -X POST http://localhost:8000/api/push -H 'Content-Type: application/json' -d '{"dor": "åpen", "co2": 612}'
```

Verdiene dukker opp under «Pushet via API» og kan brukes som `{ute_temp}` osv. De finnes bare i
editoren: huben og HMI-et ser dem ikke.

## Flere displayer

Legg til flere `[[display]]`-blokker i `config.toml` (f.eks. ett på `0x3C` og ett på `0x3D`, eller
1,3"-moduler med `driver = "sh1106"`). Velg displayet ved Deploy-knappen.
Støttede SSD1306-størrelser: 128×64, 128×32, 96×16, 64×48, 64×32.

Et tegn-LCD legges til slik:

```toml
[[display]]
id = "lcd"
name = "LCD 1602"
driver = "hd44780"
address = 0x27     # eller 0x3F
cols = 16          # 20 og 4 for 2004
rows = 2
```

Og en farge-TFT (se `config.toml` for alle valg):

```toml
[[display]]
id = "tft"
name = "TFT 2.25\""
driver = "st7789"
dc_pin = 7         # CE1 på X1
reset_pin = -1     # RES til 3,3 V
backlight_pin = 9  # MISO på X1
width = 76         # panelets egen størrelse
height = 284
rotate = 1         # liggende: layouten blir 284×76
```

## Sikkerhet

Editoren har ingen innlogging, som HMI-et – alle på det lokale nettverket kan endre displayet, bytte
fane og pushe verdier. Den leser bare fra huben, så den kan ikke styre PLS-en. Shell-kommandoer og plugins kan bare
legges til via filer på Pi-en, ikke fra nettleseren. Sett `host = "127.0.0.1"` i `config.toml` hvis
editoren bare skal nås fra Pi-en selv.

## Filer

```
app/            Python-serveren (Flask)
  renderer.py   layout → 1-bit- eller fargebilde (brukes både til forhåndsvisning og display)
  charrender.py tegn-LCD-layout → tegnkoder og egne tegn
  hd44780.py    driver for tegn-LCD med PCF8574 I2C-adapter
  st7789.py     driver for farge-TFT på SPI
  lcdfont.py    LCD-ets innebygde font, æøå og LCD-ikoner
  display.py    oppdateringstråd, emulering, valg av driver, og fanen som vises
  tabs.py       fanene i en layout, og hva inngangene gjør med dem
  inputs.py     inngangene INN0–INN7 på RaspiPower-kortet (lgpio)
  gpio.py       GPIO-ene på 40-pinners-kontakten, for inngangene og TFT-en
  sources.py    datakilder, plugins og push
  hub.py        taggene fra huben (WebSocket, bare standardbiblioteket)
  icons.py      innebygde pikselikoner
static/         editoren (HTML/CSS/JS, ingen byggesteg)
fonts/          pikselfonter (SIL Open Font License, se OFL-*.txt)
layouts/        lagrede layouter (JSON)
plugins/        egne Python-datakilder
state/          hva som er deployet, og kontrast/lysstyrke og av/på, for hvert display (ikke fanen som vises)
config.toml     huben, displayene, inngangene og egne datakilder
```
