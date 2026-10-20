# Kjøreverk-tjenester — oppsett med systemd

Dette beskriver hvordan monorail-programmene startes og holdes i gang på Raspberry Pi-en. De
kjører som **systemd-tjenester**, slik at de:

- starter av seg selv ved oppstart (også etter strømbrudd)
- starter på nytt av seg selv hvis de krasjer
- kjører uten internett (systemd er helt lokalt)

Oppsettet bruker **én malenhet** (`kjoreverk@.service`) som alle programmene deler, pluss en
liten **konfigurasjonsfil per instans** med argumentene til hvert program. Et nytt program
trenger derfor **ikke** en ny enhetsfil — se [Legge til et nytt program](#legge-til-et-nytt-program)
nedenfor.

## Nøkkeltall for denne maskinen

| Hva | Verdi |
|---|---|
| Node-programmet | `/usr/bin/node` |
| Arbeidsmappe | `/home/stormpi5/Documents/kjoreverk_telemetry` |
| Tjeneste 1 | `kjoreverk@hub.service` |
| Tjeneste 2 | `kjoreverk@binary-adapter.service` (KjoreverkLink), eller `kjoreverk@tcplink-adapter.service` (TcpLink, se [Bytte til TcpLink](#bytte-til-tcplink)) |
| Valgfritt | `kjoreverk@recorder.service`, `kjoreverk@db-browser.service` (se [Legge til et nytt program](#legge-til-et-nytt-program)) |
| Malenhet | `/etc/systemd/system/kjoreverk@.service` |
| Konfigurasjon per instans | `/etc/kjoreverk/instances/*.env` |

> Installerer du Node på nytt, kjør `which -a node` igjen og oppdater `ExecStart` i
> malenheten. systemd bruker ikke `PATH` fra skallet ditt, så stien må alltid stå skrevet ut
> (se [Merknader og fallgruver](#merknader-og-fallgruver)). Recorderen og databaseleseren
> trenger Node 22.13 eller nyere; sjekk med `/usr/bin/node -v`.

## Slik virker det

- `kjoreverk@.service` er en **mal**: `@` betyr at den kan startes flere ganger under
  forskjellige instansnavn (`%i`).
- Hvert instansnavn (`hub`, `binary-adapter`, ...) hører til en fil
  `/etc/kjoreverk/instances/<navn>.env` med én linje: `SCRIPT_ARGS=...` — nøyaktig det du
  ellers ville skrevet etter `node`.
- Stiene i `SCRIPT_ARGS` er relative til arbeidsmappen (`WorkingDirectory`), så
  `hmi-core/hub.js` betyr `/home/stormpi5/Documents/kjoreverk_telemetry/hmi-core/hub.js`.
- Linjen `ExecStart=/usr/bin/node $SCRIPT_ARGS` i malen lar systemd dele strengen opp i
  separate argumenter, akkurat som en `$VAR` uten anførselstegn i bash.
- Hver instans følges, logges og startes på nytt **hver for seg** — å drepe eller starte én
  på nytt påvirker ikke de andre.

## Fullt oppsett (fra bunnen av)

Bruk dette når du setter opp et nytt SD-kort eller en ny Pi.

### 1. Lag konfigurasjonsfilene for instansene

```bash
sudo mkdir -p /etc/kjoreverk/instances

echo 'SCRIPT_ARGS=hmi-core/hub.js' | sudo tee /etc/kjoreverk/instances/hub.env

echo 'SCRIPT_ARGS=hmi-core/adapters/binary-adapter.js hmi-core/adapters/binary-layouts/kjoreverk-layout.json --plc=10.0.123.51:2000' | sudo tee /etc/kjoreverk/instances/binary-adapter.env
```

Layoutfilen kan også utelates: uten den bruker `binary-adapter.js`
`adapters/binary-layouts/kjoreverk-layout.json` i `hmi-core`. `--plc=` overstyrer adressen i
layouten.

> **Oppdaterer du fra en eldre `hmi-core`:** layouten het før `adapters/layouts/kjoreverk.json`.
> Står den gamle stien fortsatt i `/etc/kjoreverk/instances/binary-adapter.env`, finner ikke
> adapteren layouten, og loggen sier `Layout ...: ENOENT`. Skriv filen på nytt med linjen over,
> og kjør `sudo systemctl restart kjoreverk@binary-adapter.service`.

### 2. Lag malenheten

```bash
sudo nano /etc/systemd/system/kjoreverk@.service
```

Innhold:

```ini
[Unit]
Description=Kjoreverk service: %i
After=multi-user.target

[Service]
Type=simple
EnvironmentFile=/etc/kjoreverk/instances/%i.env
ExecStart=/usr/bin/node $SCRIPT_ARGS
WorkingDirectory=/home/stormpi5/Documents/kjoreverk_telemetry
User=stormpi5
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

> Sjekk at `User=` er kontoen programmene skal kjøre som (den som har hjemmemappen
> `/home/stormpi5/...`), og at den har lov til å lese prosjektfilene og nå PLS-en på
> nettverket.

### 3. Slå på og start begge tjenestene

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kjoreverk@hub.service
sudo systemctl enable --now kjoreverk@binary-adapter.service
```

`enable` lager lenken som starter tjenesten ved oppstart (uten den starter tjenestene **ikke**
etter en omstart, selv om `start` får dem til å kjøre akkurat nå). `--now` gjør begge deler i
én kommando.

### 4. Kontroller

```bash
systemctl status kjoreverk@hub.service
systemctl status kjoreverk@binary-adapter.service
```

Begge skal vise `Active: active (running)` og `Loaded: ... enabled`.

## Bytte til TcpLink

Kjører PLS-en TcpLink-blokken i stedet for KjoreverkLink, bytter du `binary-adapter` med
`tcplink-adapter`. Den trenger ingen layoutfil: navnene og størrelsene kommer fra PLS-en.

```bash
echo 'SCRIPT_ARGS=hmi-core/adapters/tcplink-adapter.js --plc=10.0.123.51:2000' | sudo tee /etc/kjoreverk/instances/tcplink-adapter.env
sudo systemctl disable --now kjoreverk@binary-adapter.service
sudo systemctl enable --now kjoreverk@tcplink-adapter.service
```

- **Stopp den gamle først** (`disable --now`): PLS-en tar imot én klient per port, og
  `binary-adapter.js` snakker det gamle formatet.
- **Resten av innstillingene** (tagprefikset, alarmene og hold-for-å-kjøre) står i
  `hmi-core/adapters/tcplink-options/kjoreverk-options.json`. `--plc=` overstyrer adressen
  der.
- **Tilbake til KjoreverkLink:** de samme to `systemctl`-kommandoene, med navnene byttet om.
- **I kommandoene nedenfor** står `binary-adapter`: bruk `tcplink-adapter` i stedet.

## Legge til et nytt program

Ingen ny enhetsfil trengs — bare to kommandoer:

```bash
# 1. Lag konfigurasjonsfilen
echo 'SCRIPT_ARGS=path/to/new-script.js --some-flag=value' | sudo tee /etc/kjoreverk/instances/<navn>.env

# 2. Slå på og start den
sudo systemctl enable --now kjoreverk@<navn>.service
```

Bytt ut `<navn>` med en kort betegnelse (bare bokstaver, sifre og bindestrek, ingen
skråstrek). Den blir både filnavnet og delen etter `@` i tjenestenavnet.

**Recorderen og databaseleseren** startes på samme måte:

```bash
echo 'SCRIPT_ARGS=hmi-core/recorder.js' | sudo tee /etc/kjoreverk/instances/recorder.env
echo 'SCRIPT_ARGS=hmi-core/db-browser.js' | sudo tee /etc/kjoreverk/instances/db-browser.env
sudo systemctl enable --now kjoreverk@recorder.service
sudo systemctl enable --now kjoreverk@db-browser.service
```

- **Databasen** havner i `hmi-core/data/recorder.db`, og lagringsreglene i
  `hmi-core/data/recorder.rules.json`. Skal den ligge et annet sted, legg til
  `--db /sti/til/recorder.db` på begge linjene.
- **Rekkefølgen spiller ingen rolle:** recorderen prøver huben på nytt hvert 2. sekund til
  den svarer. Første gang, før recorderen har laget databasen, avslutter databaseleseren med
  en melding om det; systemd prøver igjen etter 2 sekunder, og da finnes den. Har systemd gitt
  opp (`start request repeated too quickly` i `systemctl status`), kjør
  `sudo systemctl restart kjoreverk@db-browser.service`.
- **Ved stopp** sender systemd `SIGTERM`. Recorderen skriver da det som venter i RAM til
  databasen før den avslutter, så ingenting går tapt ved `systemctl stop` eller `reboot`.

Trenger et senere program en **annen** arbeidsmappe eller bruker enn malen gir, ikke lag en
helt ny enhet — overstyr bare den instansen:

```bash
sudo systemctl edit kjoreverk@<navn>.service
```

Dette åpner en tilleggsfil (drop-in) der du bare skriver linjene som er annerledes; alt annet
kommer fortsatt fra malen.

## Sjekke at alt virker

**Sjekk at begge er slått på (overlever omstart) og kjører:**
```bash
systemctl is-enabled kjoreverk@hub.service kjoreverk@binary-adapter.service
systemctl status kjoreverk@hub.service kjoreverk@binary-adapter.service
```

**Bekreft at riktig Node-program faktisk kjører:**
```bash
systemctl status kjoreverk@hub.service   # merk deg Main PID
ls -l /proc/<PID>/exe                    # skal peke til /usr/bin/node
```

**Se loggene:**
```bash
journalctl -u kjoreverk@hub.service -n 50 --no-pager
journalctl -u kjoreverk@binary-adapter.service -n 50 --no-pager

# følg loggen live mens du tester:
journalctl -u kjoreverk@binary-adapter.service -f
```

**Test at den kommer seg etter et krasj** (simulerer et hardt krasj):
```bash
sudo systemctl kill -s SIGKILL kjoreverk@hub.service
systemctl status kjoreverk@hub.service   # skal kjøre igjen innen ~2 s, med ny PID
```

**Test at alt overlever en full omstart** (det virkelige tilfellet dette er laget for):
```bash
sudo reboot
# når den er oppe igjen:
systemctl status kjoreverk@hub.service kjoreverk@binary-adapter.service
```
Begge skal være `active (running)` uten at du har kjørt noen kommandoer for hånd.

## Merknader og fallgruver

- **systemd bryr seg ikke om `PATH`, `.bashrc` eller `.profile` fra skallet ditt.** Hver sti i
  en enhetsfil (`node`, programmene, arbeidsmappen) må være absolutt og skrevet ut.
- **Journalloggene overlever kanskje ikke et hardt strømbrudd** med mindre lagringen er
  permanent. Ser `journalctl` tom ut etter et ekte strømbrudd, kjør:
  ```bash
  sudo mkdir -p /var/log/journal
  sudo systemctl restart systemd-journald
  ```
- **Trenger et program litt tid etter oppstart før maskinvaren (seriell/I2C/USB/nettverk) er
  klar**, legg til `ExecStartPre=/bin/sleep 5` under `[Service]` i malen, eller som en
  overstyring for bare den instansen som trenger ventetiden.
- **Databaseservere** (PostgreSQL, MariaDB o.l.) bør ikke startes slik: de har sin egen
  tjeneste fra pakken sin. Recorderen er ikke en databaseserver; den bruker SQLite inne i seg
  selv og passer i denne malen (se [Legge til et nytt program](#legge-til-et-nytt-program)).
- **Etter enhver endring i malenheten eller en `.env`-fil**, kjør:
  ```bash
  sudo systemctl daemon-reload
  sudo systemctl restart kjoreverk@<navn>.service
  ```
  `daemon-reload` alene starter ikke tjenester som kjører, på nytt — den gjør bare systemd
  oppmerksom på endringen.

## Nyttige kommandoer

| Oppgave | Kommando |
|---|---|
| Start en tjeneste nå | `sudo systemctl start kjoreverk@<navn>.service` |
| Stopp en tjeneste | `sudo systemctl stop kjoreverk@<navn>.service` |
| Start en tjeneste på nytt | `sudo systemctl restart kjoreverk@<navn>.service` |
| Start ved oppstart | `sudo systemctl enable kjoreverk@<navn>.service` |
| Ikke start ved oppstart | `sudo systemctl disable kjoreverk@<navn>.service` |
| Se status | `systemctl status kjoreverk@<navn>.service` |
| Se de siste loggene | `journalctl -u kjoreverk@<navn>.service -n 50 --no-pager` |
| Følg loggen live | `journalctl -u kjoreverk@<navn>.service -f` |
| Last inn på nytt etter endringer i enheter | `sudo systemctl daemon-reload` |
