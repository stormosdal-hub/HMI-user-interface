# Databaseleseren

En nettside for å se gjennom recorderens database på Pi-en, og for å bestemme hva recorderen
lagrer. Den trenger verken internett eller npm-pakker: kopier `hmi-core`, start den, og åpne
den i en hvilken som helst nettleser på nettverket.

Den viser:
- hva som lagres, per tag, og reglene som bestemmer det;
- dine egne navn på taggene;
- hver tabell, rad for rad;
- alt du spør om med SQL.

Den pauser også lagringen, tar sikkerhetskopi av databasen og eksporterer CSV-filer.

Andre halvdel av denne veiledningen forklarer recorderens database tabell for tabell, for den
som vil lese den direkte med SQL eller et annet verktøy.

## Innhold

1. [Starte den](#1-starte-den)
2. [Siden i korte trekk](#2-siden-i-korte-trekk)
3. [Recording: hva som lagres, og reglene](#3-recording-hva-som-lagres-og-reglene)
4. [Pause lagringen](#4-pause-lagringen)
5. [Tagnavn: dine egne navn på tagger](#5-tagnavn-dine-egne-navn-på-tagger)
6. [Tabeller: rader, struktur, endringer](#6-tabeller-rader-struktur-endringer)
7. [SQL](#7-sql)
8. [Sikkerhetskopi og eksport](#8-sikkerhetskopi-og-eksport)
9. [Recorderens database](#9-recorderens-database)
10. [Tabellene, én etter én](#10-tabellene-én-etter-én)
11. [Tider, kvalitet og sletting av gamle data](#11-tider-kvalitet-og-sletting-av-gamle-data)
12. [Filer ved siden av databasen](#12-filer-ved-siden-av-databasen)
13. [Nyttige spørringer](#13-nyttige-spørringer)
14. [Greit å vite](#14-greit-å-vite)

---

## 1. Starte den

Start den fra `hmi-core`, på datamaskinen som har databasen (Pi-en):

```bash
node db-browser.js
```

Åpne så `http://<the Pi's address>:8088` i en nettleser, eller trykk **⏺ Recording** i HMI-en
(Edit-modus). Den trenger **Node.js 22.13 eller nyere**, som recorderen.

| Valg | Standard | Hva det gjør |
|---|---|---|
| `--db <file>` | `data/recorder.db` i `hmi-core` | Databasen. Oppgi samme fil som recorderens `--db`. |
| `--port <n>` | `8088` | Webporten. |
| `--write` | av | Tillater endringer: redigere rader, og lage og endre tabeller. Uten det åpnes databasen skrivebeskyttet, og ingenting som skrives inn noe sted, kan endre den. |
| `--local` | av | Bare denne datamaskinen kan åpne siden. Uten det kan alle datamaskiner på nettverket det, som med huben. |
| `--hub <url>` | `http://localhost:8080` | Huben: for taglisten dens, sanntidsverdiene, tagnavnene og recorderens status. |

- **Ingen database, ingen start.** Hvis filen ikke finnes, stopper databaseleseren med en
  melding i stedet for å lage en tom: en feilskrevet sti skal aldri se ut som «ingen data».
  Recorderen lager databasen første gang den starter.
- **Uten huben** kan alt som er lagret, fortsatt leses, og reglene kan fortsatt settes. Det
  som trenger huben (tagger som ikke er lagret ennå, sanntidsverdier, å endre tagnavn,
  recorderens status), sier fra om det på siden.
- **Skrivebeskyttet er den vanlige måten å kjøre den på.** Å sette lagringsregler, pause og gi
  tagger navn trenger ikke `--write`: det endrer filer ved siden av databasen eller på huben,
  ikke selve databasen.

## 2. Siden i korte trekk

- **Topplinjen:**
  - databasefilen og størrelsen dens;
  - **Read-only** eller **Changes allowed** (`--write`);
  - **⏸ Recording paused** mens en pause er på (se [4](#4-pause-lagringen));
  - **Refresh**, som leser alt på nytt;
  - **Back up**.
- **Venstre side:**
  - **Recording**: hva som lagres, reglene og pausing (det står **⏸ paused** mens lagringen
    er pauset);
  - **Tag names**: dine egne navn;
  - **SQL**;
  - hver tabell og hvert view, med antall rader.
- **Startsiden** (filnavnet øverst til venstre): hver tabell med antall rader, plassen den tar
  på disken, og hva den inneholder.

Hver visning har sin egen adresse (`#/recording`, `#/names`, `#/table/sample/rows`, …), så
tilbakeknappen i nettleseren virker, og en visning kan bokmerkes.

## 3. Recording: hva som lagres, og reglene

**Recording**-siden viser:
- om recorderen kjører;
- når den tok i bruk reglene;
- hvor mange verdier som venter i RAM, og hvor mange MB i døgnet den lagrer akkurat nå.

**What is stored, per tag** lister hver tag huben eller databasen kjenner. For hver av dem:

| Kolonne | Betydning |
|---|---|
| Tag | Taggens navn, og ditt eget navn på den hvis den har et |
| Stored by | Regelen som bestemmer for denne taggen, eller *no rule: not stored* |
| Last hour, Last 24 h | Lagrede verdier |
| MB a day | Hva de siste 24 timene tar på disken |
| Share | Taggens andel av alle verdier lagret de siste 24 timene |
| Last stored | Når den siste verdien ble lagret |

De tyngste taggene kommer først, så de som lagres for ofte, skiller seg ut. **Rule…** setter
hvordan akkurat den taggen lagres.

Reglene under **Rules** sjekkes ovenfra: den første regelen der tagnavnene passer med en tag,
bestemmer for den. En tag som ingen regel passer med, lagres ikke.

| Regel | Lagrer |
|---|---|
| **Each change** | Når verdien endres, med valgfrie begrensninger: en minste endring (`30`, eller `2%`), bare noen bits i et ord eller alle unntatt noen, høyst én verdi per så mange sekunder, lagre på nytt etter så mange sekunder, og flimring (for mange endringer på kort tid). |
| **At a fixed interval** | Den siste verdien hvert så mange sekund, endret eller ikke. |
| **Nothing** | Lagres aldri. Sett den over en bredere regel for å utelate noen av taggene dens. |

- **Utkastet:** endringer er et utkast fram til **Save rules**, og **Discard** forkaster dem.
  Recorderen bruker lagrede regler innen noen få sekunder, uten omstart.
- **Estimate with the last hour:** spiller de lagrede verdiene fra den siste timen gjennom
  regelen du redigerer, og sier hvor mange den ville ha lagret.
- **Settings:** hvor ofte det skrives til SD-kortet (*Write every*, s), hvor lenge data
  beholdes (*Keep for*, dager), størrelsesgrense (*Size limit*, MB), og om hendelser lagres
  (*Store events*).

Reglene og pausene lagres i `recorder.rules.json`, ved siden av databasen (se
[12](#12-filer-ved-siden-av-databasen)). Avsnitt 8 i README har reglene i detalj, med eksempler.

## 4. Pause lagringen

Under vedlikehold eller tester stopper **⏸ Pause recording…** på Recording-siden recorderen fra
å lagre, så testverdier ikke blandes med ekte verdier.

1. **What** (hva): alle tagger, eller bare noen. **A whole device** fyller inn én enhet, f.eks.
   `kv_1.*`. Flere navn kan oppgis, skilt med komma, og `*` passer med hva som helst.
2. **For** (hvor lenge): fra 15 minutter opptil 24 timer, eller **Until I resume it**. En pause
   med sluttid slutter av seg selv.
3. **Why** (hvorfor, valgfritt): f.eks. *bremsetest på kv_1*. Det havner i hendelsesloggen.

Mens pausen er på:

- **Hva som stopper:** verdiene til de pausede taggene lagres ikke, og det gjør heller ikke
  hendelser og alarmer fra de pausede enhetene og taggene. Hendelsene til en enhet (kilde
  `kv_1`) og alarmene til taggene dens (kilde `kv_1.faultCode`) hører til `kv_1.*`.
- **Hva som fortsetter:** andre tagger lagres videre slik reglene deres sier. Recorderen følger
  fortsatt med på de pausede taggene, så den vet verdiene deres når pausen slutter.
- **Hvor det vises:**
  - Recording-siden viser et kort for hver pause, med **+30 min**, **+1 h**, **No end** og
    **▶ Resume now**;
  - siden sier **The recorder has paused: …** når recorderen har tatt pausen i bruk, innen
    noen få sekunder;
  - **⏸ Recording paused** vises i topplinjen på hver side her, og i HMI-en (også i
    Run-modus). I HMI-en åpner et klikk denne siden.
- **I databasen:**
  - der pausen begynner, får hver pauset tag én rad med kvalitet `3` (pauset) og ingen verdi,
    så en trend viser et hull i stedet for en linje over pausen;
  - når den slutter, lagres verdien til hver tag i det øyeblikket, endret eller ikke;
  - hendelsesloggen får `Recording paused: kv_1.* until 15:30 (bremsetest på kv_1)` og
    `Recording resumed: kv_1.*`, fra kilden `rec`.

**Pause more…** legger til en pause til, f.eks. for et kjøretøy til.

**Omstarter:** en pause lagres i regelfilen, så den står på også etter en omstart av
recorderen eller Pi-en. Hendelsesloggen sier da *The recorder started during a pause*.

**Tider** er Pi-ens egen klokke, både for databaseleseren og recorderen. Hvis Pi-ens klokke
stilles til en annen tid under en pause, slutter en tidsbegrenset pause like mye tidligere
eller senere.

## 5. Tagnavn: dine egne navn på tagger

PLS-en sender dataene sine som posisjoner: `bit00` … `bit63`, `ints_1`, `cmd_bit05`. For å gi
dem betydning skal du ikke endre PLS-programmet: gi hver tag ditt eget navn og en beskrivelse,
f.eks. `kv_1.bit05` = **Dør lukket**, *endebryter B12, venstre dør*.

Taggen beholder navnet sitt. Skjermbilder, lagringsregler og lagret historikk forblir som de
er, og et navn kan endres når som helst.

**Navn fra PLS-en.** Kjører PLS-en TcpLink-blokken, sender den navnene selv (`LinkNames`), og
`tcplink-adapter.js` gir taggene dem (se README, avsnittet
[TcpLink: navnene kommer fra PLS-en](../README.md#tcplink-navnene-kommer-fra-pls-en)). De vises
overalt der navnene dine vises, og står som forslag i navnefeltet her. Skriver du ditt eget
navn, går det foran; tømmer du feltet, gjelder navnet fra PLS-en igjen. Valget *With a name*
over listen tar med begge.

**Hvor du setter dem:**
- **Tag names**, til venstre på denne siden. Hver tag står oppført med navnet ditt,
  beskrivelsen din, verdien nå, og hva enheten sier om den (**From the device**: navnet fra
  PLS-en i anførselstegn, og beskrivelsen fra adapteren, f.eks. layoutfilens `description`). Skriv i feltene, og trykk så **Save names**. **Now**-kolonnen oppdateres
  hvert sekund, og en verdi som endres, blinker. For å finne en bit: få den til å endre seg
  (åpne døren, trykk på knappen) og se hvilken som blinker.
- **I HMI-en**, i Edit-modus: åpne tagoversikten (**Browse tags with live values**, eller
  listeknappen ved siden av et tagfelt) og trykk **✎ Name tags**. Et klikk på en tag åpner da
  navnet og beskrivelsen dens.

**Hvor de vises:**
- **I HMI-en:**
  - tagoversikten (og søket i den);
  - tegnforklaringen i trender;
  - etiketten til en widget: velg en navngitt tag for en widget som fortsatt har
    standardetiketten, og etiketten blir taggens navn.
- **Her:** Recording-siden, Tag names, tabellrader (med **Readable values**) og taglisten over
  radene.
- **I databasen:** kolonnene `label` og `info` i `tag`-tabellen, og CSV-eksporter
  (`tag_label`).

**Hvordan de lagres:**
- **Hvor:** huben lagrer dem i `tagnames.json`, ved siden av prosjektfilen (`config/`), som
  kodetekstene. Huben må derfor kjøre for at du skal kunne endre dem.
- **Når de kommer fram:** hver HMI får en endring med en gang. Recorderen kopierer navnene på
  lagrede tagger inn i `tag`-tabellen sin innen sekunder. En tag som ikke er lagret ennå, får
  navnet sitt første gang den lagres.
- **Prosjektvariabler:** et navn lagres med prosjektets variabel når en variabel navngir
  enheten. Med `kv = kv_1` lagres navnet for `kv_1.bit05` som `${kv}.bit05`, så det følger
  variabelen: et kjøretøy der prosjektet sier `kv = kv_2`, viser de samme navnene for sine
  egne tagger.
- **Tomt navn og tom beskrivelse** fjerner navnet.

Filen, hvis du vil redigere den for hånd (huben leser den på nytt innen 2 sekunder):

```json
{
  "tags": {
    "${kv}.bit05": { "name": "Dør lukket", "info": "Endebryter B12, venstre dør", "updated": 1790630666358 },
    "${kv}.speedAct": { "name": "Motorturtall", "info": "normalisert, 16#4000 = p2000" }
  }
}
```

## 6. Tabeller: rader, struktur, endringer

Klikk på en tabell til venstre.

**Rows** viser tabellen én side om gangen, nyeste først.

- **Tag, From, To** (recorderens tabeller): velg en tag og et tidspunkt, og **Show** skriver
  betingelsen for deg.
- **Filter:** en hvilken som helst SQL-betingelse, f.eks. `value > 1000 AND q = 0`. Enter eller
  **Filter** tar den i bruk.
- **Readable values** (lesbare verdier): viser tider som datoer, tagnumre som navn (og dine
  navn), og `q` som *good / uncertain / stale / paused*. Pek på en celle for å se den lagrede
  verdien.
- **Sider:** 50 til 1000 rader per side, **Next** og **Previous**.
- **Sortering:** klikk på en kolonneoverskrift for å sortere etter den.
- **En rad:** klikk på den for å se hele raden (og, med `--write`, endre eller slette den).
- **The SQL for this page:** spørringen som ble kjørt.

**Structure** viser kolonnene og typene deres, indeksene, triggerne og
`CREATE TABLE`-setningen.

**Manage** (bare med `--write`): gi tabellen nytt navn, legg til, gi nytt navn til eller fjern
en kolonne, legg til eller fjern en indeks, tøm tabellen, slett den. Hver endring vises som SQL
og bekreftes før den kjøres, og de som sletter, ber deg skrive inn tabellnavnet. Ikke endre
recorderens egne tabeller mens den kjører: stopp den og ta sikkerhetskopi først.

**+ New table** (med `--write`) lager en egen tabell i samme database. Recorderen lar den være
i fred.

## 7. SQL

Alt SQLite forstår. **Examples…** har ferdige spørringer for recorderens database, og
**Earlier…** de 20 siste du kjørte. **Ctrl+Enter** kjører spørringen.

- Resultatene viser de første 1000 radene. Snevre inn større resultater med `WHERE` eller
  `LIMIT`.
- Skrivebeskyttet (standard): bare spørsmål virker, og ingenting kan endres.
- Med `--write` kjøres endringer med en gang. Flere setninger skilt med `;` kjøres sammen,
  uten at resultater vises.

Se [13](#13-nyttige-spørringer) for spørringer å starte fra.

## 8. Sikkerhetskopi og eksport

- **Back up** (topplinjen) lager en kopi av hele databasen ved siden av den, med navn som
  `recorder-backup-2026-09-28_14-30.db`.
  - Kopien er konsistent selv mens recorderen skriver (SQLites `VACUUM INTO`).
  - Den sjekker først at det er plass til kopien.
  - Kopier sikkerhetskopien, ikke selve `recorder.db`, for å ta dataene ut av Pi-en: filen som
    er i bruk, kan være midt i en skriving.
- **Export CSV** (over radene i en tabell) laster ned hver rad som passer med filteret, uansett
  hvor mange det er.
  - Med **Readable values** på legger den til lesbare kolonner ved siden av de lagrede:
    `tag_name`, `tag_label` og `ts_time` (en dato for hver tidskolonne).
  - CSV-filer kan åpnes i Excel eller LibreOffice.

## 9. Recorderens database

Én SQLite-fil (`recorder.db`), skrevet av `recorder.js`. Slik henger tabellene sammen:

```
                              tag
                    id · name · label · info
                      ▲                  ▲
            sample.tag│                  │rollup.tag
                      │                  │
   boot ◄──────── sample             rollup
   id ·           id · ts · boot ·   tag · minute · lo · hi ·
   boot_key ·     mono · tag ·       n · bad · rows
   first_seen     value · text · q   (én rad per tag og minutt)
     ▲
     │event.boot
     │
   event ◄─────────── batch ──────────► sample
   id · ts · boot ·   id · written ·    (first_sample … last_sample)
   mono · source ·    first_ts · last_ts ·
   severity ·         rows            (first_event … last_event)
   message

   meta: key · value     (databasens id, når den ble laget, versjonen av tabelloppsettet)
```

- **Tall viser til rader:**
  - `sample.tag` og `rollup.tag` er en `tag.id`;
  - `sample.boot` og `event.boot` er en `boot.id`;
  - en `batch` holder de lagrede verdiene og hendelsene som har id mellom dens `first_…` og
    `last_…`.

  Databasen håndhever ikke disse som fremmednøkler: recorderen holder dem riktige.
- **Hva som lagres når:** en verdi lagres når en lagringsregel sier det, og ingenting lagres
  for en tag som ingen regel passer med. Verdiene venter i RAM og skrives samlet, i én
  transaksjon, med intervallet i *Write every* (30 sekunder som standard). Én skriving er én
  `batch`-rad.
- **Størrelse:** omtrent 47 byte per lagret verdi, indeksen medregnet.

## 10. Tabellene, én etter én

### `sample`: én rad per lagret verdi

Den store tabellen: nesten all plassen.

| Kolonne | Type | Betydning |
|---|---|---|
| `id` | INTEGER, primærnøkkel | Teller opp for hver lagret verdi; rekkefølgen de ble lagret i |
| `ts` | INTEGER | Når verdien ble tatt: millisekunder siden 1970-01-01 UTC, etter Pi-ens klokke (se [11](#11-tider-kvalitet-og-sletting-av-gamle-data)) |
| `boot` | INTEGER | Hvilken oppstart av Pi-en (`boot.id`) |
| `mono` | INTEGER | Millisekunder siden den oppstarten, fra en klokke som aldri stilles |
| `tag` | INTEGER | Hvilken tag (`tag.id`) |
| `value` | REAL | Verdien hvis den er et tall. På/av-verdier er `1` og `0`. |
| `text` | TEXT | Verdien hvis den er tekst (f.eks. PLS-ens tid, `kv_1.ts`), ellers NULL |
| `q` | INTEGER | Kvalitet: `0` god, `1` usikker, `2` foreldet, `3` pauset (se [11](#11-tider-kvalitet-og-sletting-av-gamle-data)) |

- **Bare endringer, ikke hvert tikk:** en tag som lagres ved endring, har én rad per endring.
  Verdien mellom to rader er verdien i den tidligste raden. For å vite verdien til en tag i et
  gitt øyeblikk, ta den siste raden for taggen før det øyeblikket.
- **Indeksen `sample_tag` (tag, id)** gjør «én tag over et tidsrom» raskt uansett hvor mye
  annet som er lagret, mot omtrent en tredjedel mer plass.

### `tag`: taggene

| Kolonne | Type | Betydning |
|---|---|---|
| `id` | INTEGER, primærnøkkel | Nummeret `sample` og `rollup` bruker |
| `name` | TEXT, unik | Taggens navn på huben, f.eks. `kv_1.bit05` |
| `label` | TEXT | Ditt eget navn på den (se [5](#5-tagnavn-dine-egne-navn-på-tagger)), eller NULL |
| `info` | TEXT | Din beskrivelse av den, eller NULL |

En tag får raden sin første gang en verdi av den lagres. Rader fjernes aldri, så numrene
forblir de samme.

### `event`: alarmer, advarsler og meldinger

Hendelsesloggen slik HMI-en viste den. Lagres når **Store events** er på.

| Kolonne | Type | Betydning |
|---|---|---|
| `id` | INTEGER, primærnøkkel | Teller opp |
| `ts`, `boot`, `mono` | INTEGER | Når, som i `sample` |
| `source` | TEXT | Hvem som utløste den: en enhet (`kv_1`), en tag med alarm (`kv_1.faultCode`), en beregning, `rec` (recorderen selv) eller en HMI (f.eks. hvem som kvitterte en alarm) |
| `severity` | TEXT | `info`, `warning` eller `alarm` |
| `message` | TEXT | Teksten, f.eks. `No data from the PLC`, `Cleared: …`, `Acknowledged: …` |

### `rollup`: minuttsammendrag for hver tag

Holdes oppdatert av recorderen ved hver skriving, så trender over dager og uker leser én rad
per minutt i stedet for hver verdi, og Recording-siden teller verdier raskt.

| Kolonne | Type | Betydning |
|---|---|---|
| `tag` | INTEGER | Hvilken tag (`tag.id`) |
| `minute` | INTEGER | Hvilket minutt: minutter siden 1970-01-01 UTC (`ts / 60000`) |
| `lo`, `hi` | REAL | Det laveste og høyeste gode eller usikre tallet i det minuttet |
| `n` | INTEGER | Hvor mange gode eller usikre tall |
| `bad` | INTEGER | Hvor mange markeringer for foreldet eller pauset |
| `rows` | INTEGER | Hvor mange verdier som ble lagret i alt (tekst også) |

Primærnøkkelen er (`tag`, `minute`), og tabellen har ingen rowid (`WITHOUT ROWID`). Recorderen
bygger den fra `sample` hvis den mangler, f.eks. i en database fra en eldre versjon.

### `batch`: én rad per skriving

| Kolonne | Type | Betydning |
|---|---|---|
| `id` | INTEGER, primærnøkkel | Teller opp |
| `written` | INTEGER | Når den ble skrevet (ms siden 1970) |
| `first_sample`, `last_sample` | INTEGER | `sample`-id-ene den holder (NULL hvis ingen) |
| `first_event`, `last_event` | INTEGER | `event`-id-ene den holder (NULL hvis ingen) |
| `first_ts`, `last_ts` | INTEGER | Den tidligste og seneste `ts` i den |
| `rows` | INTEGER | Verdier og hendelser i den |

Den lar recorderen finne hvor et tidsrom starter uten å lese hver rad, og slette gamle data
én hel skriving om gangen.

### `boot`: hver oppstart av Pi-en

| Kolonne | Type | Betydning |
|---|---|---|
| `id` | INTEGER, primærnøkkel | Nummeret `sample.boot` og `event.boot` bruker |
| `boot_key` | TEXT, unik | Linux' id for denne oppstarten (på en PC: én per oppstart av recorderen) |
| `first_seen` | INTEGER | Når recorderen først så den (ms siden 1970) |

### `meta`: om selve databasen

| key | value |
|---|---|
| `db_id` | En tilfeldig id for denne databasefilen |
| `created` | Når den ble laget |
| `schema` | Versjonen av tabelloppsettet (`1`) |

### `sqlite_sequence`

SQLites egne tellere for id-ene ovenfor. La den være i fred.

## 11. Tider, kvalitet og sletting av gamle data

**Tider:**
- `ts` er millisekunder siden 1970-01-01 UTC. I SQL:
  `datetime(ts / 1000, 'unixepoch', 'localtime')`.
- Pi-en har ingen batteridrevet klokke, så etter et strømbrudd kan klokken gå feil til den blir
  stilt. Derfor har hver rad også `boot` og `mono`: de kommer fra en klokke som aldri stilles.
  Innenfor én oppstart gir `mono` den sanne tiden mellom to rader. Når den sanne tiden for ett
  øyeblikk i en oppstart er kjent, kan hver tid i den oppstarten regnes ut.

**Kvalitet (`q`):**

| q | Navn | Betydning |
|---|---|---|
| 0 | good (god) | En normal verdi |
| 1 | uncertain (usikker) | Huben hadde ennå ingen bekreftet verdi fra enheten, f.eks. rett etter at den koblet til |
| 2 | stale (foreldet) | Enheten ble frakoblet, eller forbindelsen ble brutt. `value` er den siste den hadde. En trend viser et hull herfra. |
| 3 | paused (pauset) | Lagringen av denne taggen ble pauset her (se [4](#4-pause-lagringen)). Ingen verdi. En trend viser et hull fram til neste rad. |

Den første verdien til en tag, og hver endring av kvalitet, lagres alltid, uansett regel.

**Sletting av gamle data:**
- **Keep for** (standard 7 dager): hvert 10. minutt sletter recorderen hele skrivinger
  (`batch`-rader, med verdiene og hendelsene deres) der alle verdiene er eldre enn det.
- **Size limit** (standard 1000 MB): hvis databasen vokser forbi grensen, slettes de eldste
  skrivingene til den er på 90 %. En hendelse av typen advarsel sier fra når til når.
- **Sammendraget følger med:** `rollup`-rader for de slettede minuttene slettes også.
- **Filen krymper ikke:** SQLite gjenbruker den frigjorte plassen til nye rader.

## 12. Filer ved siden av databasen

| Fil | Hva det er |
|---|---|
| `recorder.db` | Databasen |
| `recorder.db-wal`, `recorder.db-shm` | SQLites write-ahead-logg: nylige skrivinger som ennå ikke er flettet inn i databasen. De hører til den. Ikke slett dem mens recorderen kjører. |
| `recorder.rules.json` | Lagringsreglene, innstillingene og pausene. Skrives av denne siden, leses av recorderen hvert 2. sekund. |
| `recorder-backup-….db` | Kopier laget med **Back up** |
| `….unreadable-<time>` | En regelfil som ikke kunne leses, tatt vare på da siden lagret en ny |

Og ved siden av prosjektfilen (`config/`), holdt av huben:

| Fil | Hva det er |
|---|---|
| `tagnames.json` | Dine egne navn og beskrivelser for tagger |
| `codes.json` | Tekster for feil- og alarmkoder |

## 13. Nyttige spørringer

Bytt ut tagnavnene med dine egne. Alle virker i databaseleseren i skrivebeskyttet modus.

**De siste verdiene til én tag, med tider:**

```sql
SELECT datetime(s.ts / 1000, 'unixepoch', 'localtime') AS time, s.value, s.text, s.q
FROM sample s JOIN tag t ON t.id = s.tag
WHERE t.name = 'kv_1.speedAct'
ORDER BY s.id DESC
LIMIT 100;
```

**En tag mellom to tidspunkter, funnet med ditt navn på den:**

```sql
SELECT datetime(s.ts / 1000, 'unixepoch', 'localtime') AS time, s.value
FROM sample s JOIN tag t ON t.id = s.tag
WHERE t.label = 'Dør lukket'
  AND s.ts BETWEEN strftime('%s', '2026-09-28 08:00', 'utc') * 1000
               AND strftime('%s', '2026-09-28 16:00', 'utc') * 1000
ORDER BY s.id;
```

**Hvor mye hver tag lagrer, flest først:**

```sql
SELECT t.name, t.label, SUM(r.rows) AS values_stored,
  datetime(MIN(r.minute) * 60, 'unixepoch', 'localtime') AS first,
  datetime(MAX(r.minute) * 60, 'unixepoch', 'localtime') AS last
FROM rollup r JOIN tag t ON t.id = r.tag
GROUP BY r.tag
ORDER BY values_stored DESC;
```

**Laveste og høyeste verdi per time for en tag:**

```sql
SELECT strftime('%Y-%m-%d %H:00', r.minute * 60, 'unixepoch', 'localtime') AS hour,
  MIN(r.lo) AS lowest, MAX(r.hi) AS highest, SUM(r.n) AS values_stored
FROM rollup r JOIN tag t ON t.id = r.tag
WHERE t.name = 'kv_1.speedAct'
GROUP BY hour
ORDER BY hour DESC
LIMIT 48;
```

**Alarmer og advarsler de siste 24 timene:**

```sql
SELECT datetime(ts / 1000, 'unixepoch', 'localtime') AS time, source, severity, message
FROM event
WHERE severity IN ('alarm', 'warning') AND ts > (strftime('%s', 'now') - 86400) * 1000
ORDER BY id DESC;
```

**Når lagringen ble pauset, og hvorfor:**

```sql
SELECT datetime(ts / 1000, 'unixepoch', 'localtime') AS time, message
FROM event
WHERE source = 'rec'
  AND (message LIKE 'Recording paus%' OR message LIKE 'Recording resumed%' OR message LIKE '%during a pause%')
ORDER BY id DESC;
```

**Hull: når tagger ble foreldet (forbindelsen brutt), pauser ikke medregnet:**

```sql
SELECT datetime(s.ts / 1000, 'unixepoch', 'localtime') AS time, t.name, t.label
FROM sample s JOIN tag t ON t.id = s.tag
WHERE s.q = 2
ORDER BY s.id DESC
LIMIT 200;
```

**Plass per tabell og indeks:**

```sql
SELECT name, ROUND(SUM(pgsize) / 1e6, 1) AS megabytes
FROM dbstat GROUP BY name ORDER BY SUM(pgsize) DESC;
```

## 14. Greit å vite

- **To samtidig går fint.** Databaseleseren leser mens recorderen skriver: SQLites
  write-ahead-logg lar begge jobbe samtidig. Hvis recorderen er midt i en stor skriving,
  venter en spørring opptil 5 sekunder i stedet for å feile.
- **Store tabeller:** en tabell med mer enn 5 millioner rader viser *omtrent* hvor mange rader
  den har (ut fra id-ene), fordi det tar en stund å telle dem nøyaktig på en Pi.
- **Å endre recorderens tabeller** (`--write`) kan stoppe lagringen eller ødelegge trender:
  stopp recorderen og ta **Back up** først. Dine egne tabeller er trygge å endre.
- **Alle på nettverket kan åpne den** med mindre du starter den med `--local`. Det finnes ikke
  noe passord, som med huben. Med `--write` kan alle på nettverket også endre databasen.
- **En annen SQLite-fil** virker også: `node db-browser.js --db other.db` viser tabellene i
  den. Sidene Recording og Tag names vises bare for recorderens database.
