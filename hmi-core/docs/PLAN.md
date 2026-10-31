# Plan: recorderen og den sentrale databasen

> **Status:** Pi-siden er bygd: ringen i PLS-en, gjenopprettingen gjennom adapteren og huben, og
> `recorder.js` med `lib/record-rules.js`. Recorderen er testet mot en falsk server som følger
> [PROTOKOLL.md](PROTOKOLL.md). Serveren er ikke bygd.
>
> **Tre filer hører sammen:**
> - **Denne filen:** helheten, og Pi-siden (`recorder.js` i dette prosjektet).
> - **[SERVER-PLAN.md](SERVER-PLAN.md):** den sentrale serveren og databasen, som bygges i et eget
>   prosjekt.
> - **[PROTOKOLL.md](PROTOKOLL.md):** grensesnittet mellom recorderen og serveren. Den skal være
>   lik i begge prosjektene.
>
> **Den forrige planen** (en lokal SQLite-database som kø, `uploader.js`, `replay.js`) ligger i
> git-historikken, i c7120eb. Den gjelder ikke lenger, og heller ikke [replay.svg](replay.svg)
> og `src/replay.py`, som tegnet det første utkastet.

## Innhold

1. [Mål](#1-mål)
2. [Det som finnes i dag](#2-det-som-finnes-i-dag)
3. [Beslutningene](#3-beslutningene)
4. [Etter et strømbrudd eller en omstart](#4-etter-et-strømbrudd-eller-en-omstart)
5. [Det som skal bygges her](#5-det-som-skal-bygges-her)
6. [Rekkefølgen](#6-rekkefølgen)
7. [Åpne spørsmål](#7-åpne-spørsmål)
8. [Begrensninger vi lever med](#8-begrensninger-vi-lever-med)

---

## 1. Mål

1. **Dataene fra alle 42 kjøreverkene havner i én database på en sentral server.** Hvert
   kjøreverk har én PLS (S7-1200) og én Raspberry Pi.
2. **Pi-ene i kjøreverkene skriver aldri til SD-kortet under drift.** Det som ikke har nådd
   serveren når strømmen går, er tapt. Det godtar vi heller enn å risikere et ødelagt kort.
3. **Det som mangler, synes.** Serveren vet hvor det er hull, og hvorfor.
4. **Alle tider er riktige**, og like på tvers av kjøreverkene.
5. **Hva som lagres, og hvordan, styres fra serveren**, for alle kjøreverkene på ett sted.
6. **HMI-en merker ingenting**, bortsett fra at trender, Timeline og tidsstripen rekker lenger
   tilbake.

## 2. Det som finnes i dag

| Del | I dag |
|---|---|
| PLS | TcpLink logger bitene og ordene som er valgt med `histMask`, i en remanent ring (`LinkHistory`, 200 poster à 20 byte som standard). Den sendes som kind 2 ved hver tilkobling. Bare digitale data |
| `tcplink-adapter.js` | Gjør ringen om til `restore` til huben, med en ref (`løpenummer@PLS-tid`) per post. Postene plasseres etter Pi-klokka, med klokkeforskjellen fra siste datamelding. Sanntidsverdier sendes uten `ts`, så huben stempler dem med Pi-klokka |
| `hub.js` | Historikk i RAM: de siste 600 endringene per tag, for tall og av/på (tekst har ingen). Fletter inn gjenopprettede punkter, hopper over refs den har sett, og sender `restored` til HMI-ene. Sender `historyRange` videre til en klient med `serves: ['history']` når minnet ikke rekker |
| HMI | Trend, Timeline og tidsstripen spør med `historyRange`. Svarer ingen database, viser de *No history database is connected* |
| `lib/record-rules.js` | Lagringsreglene fra den gamle recorderen. Fjernet i 4a25d00, og ligger hel i 4443ef8. Tar tiden som argument |

## 3. Beslutningene

### 3.1 Ingenting skrives til SD-kortet

- **Recorderen holder alt i RAM.** Den har ingen database, ingen kø-fil, og skriver heller ingen
  regelfil.
- **Oppsettet legges inn én gang, ved installasjonen:** kjøreverkets id, nøkkelen og serverens
  adresse. Det ligger i en fil eller i systemd-tjenesten, og recorderen leser det bare.

**Hvorfor:** går strømmen midt i en skriving, kan filsystemet på kortet bli ødelagt, så Pi-en
ikke starter.

**Hva det koster:** er serveren utilgjengelig når strømmen går, er det som ventet i RAM, borte.
Ringen i PLS-en gir tilbake de siste digitale endringene (se [4](#4-etter-et-strømbrudd-eller-en-omstart)),
og hullet synes på serveren ([3.6](#36-hull-blir-synlige)).

**Recorderen er ikke den eneste som skriver.** `install.sh` legger loggene (journald) i RAM, men
`apt`, `fake-hwclock`, og huben når prosjektet lagres i Edit-modus, skriver fortsatt til kortet.
Se [åpne spørsmål](#7-åpne-spørsmål) om overlay-filsystemet.

### 3.2 En egen recorder på hver Pi

- **`recorder.js` er en egen systemd-tjeneste** ved siden av `hub.js` og adapteren. Stopper den,
  merker ikke HMI-en det.
- **To forbindelser til huben**, som den gamle recorderen. `hub.js` trenger ingen endring.
  - **En leser** (`role: 'hmi'`, `readonly: true`, `subscribe ['*']`). Den får alle verdiene,
    tagoversikten, hendelsene og `restored`.
  - **En historikktjeneste** (`role: 'adapter'`, `serves: ['history']`). Den svarer på
    trendenes spørsmål ([3.8](#38-trendene-i-hmi-en-henter-fra-databasen)), og melder recorderens
    status som tagger.
- **Den kjører på Node 10**, som huben. Den bruker ingen databasedriver, bare `ws` (som finnes
  fra før) og Nodes egne `http` og `zlib`.
- **Status som tagger,** så HMI-en kan vise den:
  - `rec.server`: om serveren svarer.
  - `rec.queue` og `rec.queue_pct`: punkter i køen, og hvor full den er.
  - `rec.last_ack`: når serveren sist bekreftet.
  - `rec.dropped`: punkter kastet fordi køen var full.
  - `rec.clock_synced`: om klokka er synkronisert.

### 3.3 Reglene lages på serveren og brukes på Pi-en

- **Regelmotoren er `lib/record-rules.js` fra 4443ef8**, med de samme reglene:
  - lagre ved endring, med dødbånd (`deadband`, også i prosent)
  - bare noen biter i et ord teller (`bits`, `ignoreBits`)
  - minste og største tid mellom to lagrede verdier (`minInterval`, `maxInterval`)
  - vern mot flimring (`flickerChanges`, `flickerSeconds`)
  - fast takt (`interval`) og utelating (`ignore`)
  - pauser, for eksempel under vedlikehold

  Filhåndteringen tas ut av den: reglene kommer som JSON fra serveren.
- **Reglene brukes før køen.** Det som ikke skal lagres, tar ikke plass i RAM eller på WiFi.
- **Reglene skrives på serverens web-side.** Et felles regelsett gjelder for alle, og et tillegg
  per kjøreverk går foran det. Første regel som treffer, gjelder.
- **Pi-en henter reglene fra serveren og holder dem i RAM.** Hvert svar fra serveren har
  regelversjonen, og er den ny, henter recorderen reglene på nytt.
- **Fra oppstart til reglene er hentet** holdes hver endring i køen som den er (bare
  endringer: huben sender alle verdiene fra PLS-en hver gang). Når reglene kommer, kjøres
  disse punktene gjennom dem. Regelmotoren tar tiden som argument, så resultatet
  blir det samme som om reglene hadde vært der fra start.
- **Punkter som kommer i etterkant** (`restored`, og hull som fylles fra hubens minne) går
  gjennom en egen kopi av regelmotoren. De er eldre enn sanntidsverdiene, og motoren må få
  punktene i rekkefølge.

**Hvorfor ikke bare reglene på serveren:** under et WiFi-brudd ville køen fylles med alt, også
det som aldri skal lagres.

### 3.4 Køen i RAM

- **Batcher hvert 10. sekund**, eller når en batch er full. Eldste først, én batch om gangen,
  med et løpenummer per oppstart (`boot`, `seq`).
- **En batch tas ut av køen først når serveren har svart OK.** Serveren svarer først etter
  COMMIT.
- **Hvert punkt lagres én gang.** Nøkkelen på serveren er kjøreverk, tag og tid, så en batch som
  sendes to ganger, er ufarlig.
- **Køen har et tak**, satt etter hvor mye minne Pi-en har (64 MB som utgangspunkt; et punkt
  tar 100–130 byte). Er den full, kastes de eldste punktene, og hullet meldes til serveren med
  tidsrom og grunn.
- **Det som fylles inn fra hubens minne, fortrenger aldri nyere verdier.** Er køen nesten full,
  hoppes resten over, og det meldes som et hull.
- **Etter et brudd sendes køen i biter.** Ber serveren om å vente (`retryAfter`), venter
  recorderen. Da tåler serveren at 42 kjøreverk kommer tilbake samtidig.
- **Detaljene,** som feilkoder, størrelser og hva som sendes på nytt, står i
  [PROTOKOLL.md](PROTOKOLL.md).

### 3.5 Klokka

- **Pi-klokka er fasiten for alt.** Huben stempler sanntidsverdiene med den, og adapteren
  plasserer ringen etter den. Alt lagres i UTC.
- **Tidsserveren er NTP-serveren på nettet, `10.0.0.104`.** Pi-ene og den sentrale serveren
  synkroniserer hver for seg mot den, med `systemd-timesyncd` eller `chrony`.
- **PLS-klokka trenger ikke være riktig:** adapteren plasserer ringen etter Pi-klokka. PLS-en kan
  likevel bruke `10.0.0.104` med den innebygde NTP-klienten, hvis den når den.
- **Problemet:** en Pi som starter uten nett (og uten batteri på RTC-en) har feil tid til
  den får kontakt med tidsserveren. Da hopper klokka.
- **Løsningen, uten disk:**
  - **Recorderen noterer en monoton tid for hvert punkt**, og følger med på forskjellen mellom
    veggklokka og den monotone klokka. Endrer forskjellen seg brått, har klokka hoppet, og
    punktene i køen flyttes like mye.
  - **Den sender ingenting før klokka er synkronisert.** Den spør systemet (`timedatectl` eller
    `chronyc`) hvert minutt. Serveren får aldri punkter med en tid ingen vet om er riktig.
  - **Svarer serveren, men klokka blir ikke synkronisert innen 10 minutter,** sendes punktene
    likevel, merket at klokka ikke var synkronisert.
- **Fra den forrige planen beholdes:** at lagrede tider aldri skrives om på serveren.
- **Fra den forrige planen droppes:**
  - Tjenesten som stilte Pi-klokka etter PLS-en. Den trengte root og mange sperrer, og hoppene
    rettes nå i køen.
  - GPS på serveren, og serveren som tidsserver for kjøreverkene. `10.0.0.104` er tidsserveren.

### 3.6 Hull blir synlige

- **Hver oppstart av recorderen har en egen id** (`boot`). Serveren ser hver økt, og tiden
  mellom to økter uten data er et hull.
- **Recorderen melder hull den vet om:**
  - punkter kastet fordi køen var full
  - en batch serveren avviste
  - pauser fra reglene
- **Serverens web-side viser hullene** per kjøreverk.

### 3.7 Hendelser og alarmer

Leseren får hendelsene og alarmene fra huben, og recorderen sender dem til serveren. Om de skal
med, og fra hvilken alvorlighetsgrad, står i reglene (`events`).

### 3.8 Trendene i HMI-en henter fra databasen

- **Historikktjenesten svarer på `query` fra huben** ved å spørre serveren (`POST /history`), og
  sender svaret tilbake som `queryResult`. Trend, Timeline og tidsstripen viser da det databasen
  har, uten endringer i HMI-en.
- **Den spør bare om sitt eget kjøreverk.**
- **Svarer ikke serveren innen 10 sekunder**, svarer recorderen med en feil. Huben bruker da sitt
  eget minne og viser feilen i trenden. Huben venter selv i 20 sekunder.

### 3.9 Sikkerhet

- **Hvert kjøreverk har sin egen nøkkel**, laget på serverens web-side og lagt inn på Pi-en ved
  installasjonen. En nøkkel kan trekkes tilbake, for eksempel for en Pi som er borte.
- **HTTP på det lokale nettet** til å begynne med. HTTPS kan komme senere uten at protokollen
  endres.

## 4. Etter et strømbrudd eller en omstart

1. **Strømmen er tilbake.** PLS-en er i gang etter noen sekunder. Det som lå i recorderens kø,
   er borte.
2. **Pi-en starter: huben, adapteren og recorderen.** Adapteren kobler seg til PLS-en, får ringen,
   og sender `restore` til huben. Er recorderen allerede koblet til, får den punktene som
   `restored`.
3. **Klokka:** til klokka er synkronisert, holder recorderen punktene og retter dem hvis klokka
   hopper ([3.5](#35-klokka)).
4. **Serveren svarer** (`POST /hello`) og sier hvilket tidspunkt den har nyeste data fra for dette
   kjøreverket.
5. **Recorderen fyller hullet fra hubens minne.** Den ber huben om alt etter dette tidspunktet,
   med noen minutters margin, og sender det merket som etterfylt. Serveren hopper over det den
   har fra før. Dette tar også med ringen fra PLS-en hvis recorderen startet etter at huben fikk
   den.
   - **Bruk `history`** (hubens rå minne, én tag om gangen), **ikke `historyRange`**:
     `historyRange` sender spørsmålet videre til historikktjenesten, altså til recorderen selv.
6. **Videre som vanlig.** Hullet mellom siste bekreftede batch og det ringen og hubens minne ga
   tilbake, er registrert som et hull på serveren.

Det samme skjer når bare recorderen startes på nytt (en oppdatering, eller et krasj). Da har huben
alle sine 600 endringer per tag, og hullet blir lite eller ingenting.

## 5. Det som skal bygges her

| Del | Hva | Ny eller endret |
|---|---|---|
| `lib/record-rules.js` | Tilbake fra 4443ef8. Uten filhåndteringen, med reglene som JSON fra serveren, pauser i ms, `eventsMin`, og regler for punkter i etterkant | bygd |
| `recorder.js` | De to forbindelsene til huben, reglene, køen i RAM, batcher til serveren, klokkehopp, hull fra hubens minne, svar på historikkspørsmål, status-taggene | bygd |
| Installasjon | `install.sh` i prosjektmappen (`/opt/kjoreverk`): kjøreverkets navn, systemd-tjenestene, oppsettfilen (server, nøkkel), klokka mot tidsserveren og loggene i RAM. Beskrevet i `README_systemd-service.md` | bygd |
| Test | En falsk server etter [PROTOKOLL.md](PROTOKOLL.md) og den falske PLS-en: køen, at en batch sendes på nytt og lagres én gang, brudd, 503, 400, 413, nye regler, pauser, stopp, klokkehopp, hull fra hubens minne og full kø | bygd |
| README | Avsnittet om recorderen, kommandolinjen og rader under Feilsøking | bygd |
| `hub.js`, adapteren, HMI-en | ingen endring | uendret |

## 6. Rekkefølgen

Hver fase virker alene.

1. **Protokollen** ([PROTOKOLL.md](PROTOKOLL.md), versjon 1) er lik i begge prosjektene.
2. **Recorderen mot en falsk server, her.** Samtidig lages mottaket og databasen i serverprosjektet.
3. **Recorderen mot den ekte serveren** på Pi 5-en, med ett kjøreverk.
4. **Reglene fra serveren.** Web-siden for reglene lages i serverprosjektet.
5. **Trendene fra databasen** ([3.8](#38-trendene-i-hmi-en-henter-fra-databasen)).
6. **Klokka:** serveren og Pi-ene mot tidsserveren `10.0.0.104`.
7. **Ut på alle 42 kjøreverkene.**

## 7. Åpne spørsmål

- **Hvilke Pi-modeller er i kjøreverkene, hvor mye minne har de, og har de batteri på RTC-en?**
  Det avgjør taket på køen, og hvor ofte klokka er feil ved oppstart.
- **Hvor lange kan WiFi-bruddene bli?** Med taket på køen avgjør det når de eldste punktene må
  kastes.
- **Når alle kjøreverkene serveren direkte**, og har serveren et fast navn eller en fast
  adresse?
- **Overlay-filsystem på Pi-ene i kjøreverkene?** I `raspi-config` (Performance Options →
  Overlay File System) blir rotfilsystemet skrivebeskyttet, og alt som skrives, havner i RAM.
  - **Fordelen:** det beskytter kortet mot alle skrivinger, ikke bare recorderens.
  - **Ulempen:** endringer i HMI-prosjektet som lagres på Pi-en, er borte etter en omstart. For
    å endre noe, slås overlayet av og Pi-en startes på nytt.
  - **Uten overlay** ligger i det minste loggene i RAM: `install.sh` setter `Storage=volatile` i
    journald.

## 8. Begrensninger vi lever med

- **Serveren utilgjengelig og et strømbrudd** koster det som lå i køen. Bare de digitale
  endringene ringen i PLS-en har (200 som standard), kommer tilbake.
- **Beregnede tagger (`calc.*`) regnes ikke ut på nytt** for et tidsrom som kommer tilbake fra
  ringen. Huben regner bare i sanntid.
- **Tekst-tagger** lagres bare i sanntid. Huben har ingen historikk for dem, så et hull kan ikke
  fylles for dem.
- **Et veldig langt brudd** fyller køen. De eldste punktene kastes, og hullet synes på serveren.
- **Startet recorderen etter at klokka hoppet**, kan punkter fra før hoppet (fra hubens minne)
  ikke rettes. Det skjer bare hvis recorderen startes lenge etter huben.
