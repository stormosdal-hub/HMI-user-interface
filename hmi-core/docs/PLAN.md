# Plan: sentral database, gjenoppretting etter strømbrudd og riktig klokke

> **Status:** plan, ingenting av dette er bygd ennå. [replay.svg](replay.svg) viser det første
> utkastet. Der kartet og denne filen er uenige, gjelder denne filen. Kartet holder opplastingen
> i RAM, lar serveren svare på hva som mangler, og flytter beregningsmotoren ut av `hub.js`;
> alle tre er endret nedenfor.

## Innhold

1. [Mål](#1-mål)
2. [Det som finnes i dag](#2-det-som-finnes-i-dag)
3. [Beslutningene](#3-beslutningene)
4. [Etter et strømbrudd](#4-etter-et-strømbrudd)
5. [Det som skal bygges](#5-det-som-skal-bygges)
6. [Rekkefølgen](#6-rekkefølgen)
7. [Åpne spørsmål](#7-åpne-spørsmål)
8. [Begrensninger vi lever med](#8-begrensninger-vi-lever-med)

---

## 1. Mål

1. **Dataene fra alle 42 kjøretøyene havner i én database på en sentral server.**
2. **Et strømbrudd koster ingen data.** Det gjelder både det som var på vei til serveren, og
   tiden Pi-en bruker på å starte igjen.
3. **Alle tider er riktige, og like på tvers av kjøretøyene**, uten internett.

## 2. Det som finnes i dag

| Del | I dag |
|---|---|
| `tcplink-adapter.js` | Gjør meldingene fra TcpLink om til tagger. PLS-klokka står i headeren på hver melding (`kv_1.ts`) |
| `hub.js` | Holder taggene, som HMI-en kobler widgetene til, og regner ut beregningene i sanntid. Tar allerede imot et tidsstempel (`ts`) i `update` |
| `recorder.js` | Skriver de valgte taggene til `data/recorder.db` (SQLite, WAL) hvert 30. sekund (`flushSeconds`). Et strømbrudd koster høyst det siste halve minuttet. Stempler hver verdi med tiden fra huben |
| `recorder.db` | Har allerede en tilfeldig id per databasefil (`meta.db_id`), én rad per skriving (`batch`, laget med tanke på videresending) og én rad per oppstart av Pi-en (`boot`) |
| `lib/calc.js`, `lib/record-rules.js` | Formelspråket og lagringsreglene. Begge tar tiden som argument |

## 3. Beslutningene

### 3.1 Den lokale databasen er køen

- **`recorder.js` skriver til `recorder.db` som i dag.** Ingenting går rett fra RAM til
  serveren.
- **En ny `uploader.js` leser fra `recorder.db` og sender til serveren**, én eller flere
  `batch`-er om gangen. Den husker hvor langt serveren har bekreftet, i `recorder.db` (for
  eksempel `meta.uploaded_batch`), og fortsetter derfra etter en omstart.
- **Serveren svarer OK først etter COMMIT.** Hver rad har nøkkelen (kjøretøy, `db_id`, rad-id),
  så en batch som sendes to ganger, lagres én gang.
- **Oppryddingen (`keepDays`, `maxMB`) må aldri slette det serveren ikke har bekreftet.** Blir
  plassen for liten, må det bli en alarm, ikke stille sletting.

**Hvorfor:** en kø i RAM mister hele WiFi-bruddet hvis strømmen går mens WiFi er nede. Det kan
ingen ring i PLS-en dekke.

### 3.2 En liten ring i PLS-en

- **Hva den dekker:** de siste 30 sekundene før bruddet, som ikke rakk å bli skrevet, pluss tiden
  Pi-en bruker på å starte (omtrent ett minutt). Med margin: 2–3 minutter.
- **Fast takt**, for eksempel én post i sekundet, ikke en post ved hver endring. Da er
  tidsrommet kjent: 150 poster er 2½ minutt. Med en post ved hver endring kan 150 poster være
  brukt opp på 15 sekunder.
- **Remanent minne:** S7-1200 har så vidt vi vet 10 kB for hele programmet. Sjekk tallet for
  din CPU, og hvor mye som er brukt, under Program info → Resources i TIA. En post er
  loggtelleren (4 byte) + tiden (DTL, 12 byte) + signalene du velger. For eksempel 32 bits
  (4 byte), tre words (6 byte) og tre reals (12 byte) gir 38 byte; 150 poster blir da
  omtrent 6 kB.
- **Loggtelleren** (UDInt, remanent) øker med én per post. Den sendes også i sanntid, i en
  ledig dint i TcpLink, så den lokale databasen vet hvilken post hver verdi hører til.
- **En epoke ved siden av telleren.** En nedlasting med reinitialisering setter de remanente
  verdiene tilbake til startverdiene, og telleren begynner på nytt. En remanent epoke-verdi,
  satt når telleren starter fra 0 (for eksempel PLS-tiden i sekunder), skiller den nye
  rekken fra den gamle, så nøklene aldri kolliderer.
- **En egen OUC-blokk ved siden av TcpLink**, med egen `connId` (2) og port (2100). Den svarer
  på «HENT fra teller n» med postene den har. Ingen kvittering: PLS-en avhenger aldri av Pi-en.

### 3.3 Pi-en finner selv hva som mangler

- **Rett etter oppstart** sammenligner Pi-en den siste loggtelleren i `recorder.db` (fra før
  bruddet) med den første loggtelleren i sanntid etter oppstart. Det som ligger mellom, mangler.
- **Den henter med en gang**, før ringen skriver over postene.
- **Har epoken endret seg** (PLS-en er lastet ned på nytt i mellomtiden), henter den det ringen
  har i den nye epoken.
- **Virker uten WiFi**, og serveren trenger ikke svare på hva som mangler.

### 3.4 Gjenopprettede data lagres lokalt

- **`replay.js` skriver postene til `recorder.db`, merket som gjenopprettet** (for eksempel med
  en egen kilde på `batch`-raden). Den samme opplasteren sender dem, og serveren tar vare på
  merket.
- **De samme lagringsreglene** (`recorder.rules.json`, via `lib/record-rules.js`), så
  gjenopprettede data ser ut som sanntidsdata.
- **Aldri til huben.** Gamle verdier når aldri HMI-en, alarmlisten eller hendelsesloggen.

**Hvorfor lokalt:** holdes de bare i RAM til WiFi er oppe, forsvinner de igjen hvis strømmen går
en gang til.

### 3.5 En egen beregningsmotor i `replay.js`; `hub.js` røres ikke

- **Taggene og beregningene i sanntid blir i huben**, som i dag. HMI-en merker ingenting.
- **`replay.js` leser `calcs` fra `hmi.json`**: de samme beregningene som huben bruker. En endret
  beregning gjelder begge steder.
- **Den bruker `lib/calc.js` uendret**, med PLS-tiden fra hver post som klokke. Formelspråket og
  tidsfunksjonene (`changes`, `rate`, `held`, `stretch` …) ligger der, så formlene betyr det
  samme begge steder.
- **Bare rammen rundt formlene kopieres** (omtrent 100 linjer): rekkefølgen når en beregning
  bruker en annen, kvaliteten, og nullstillingen når inngangene blir foreldet. En beregning med
  en inngang ringen ikke har med, får ingen verdi, som i huben.
- **En test holder dem like:** de samme dataene gjennom huben og gjennom `replay.js`, og
  resultatene sammenlignes.

### 3.6 Klokka: GPS → server → Pi → PLS

| Ledd | Kilde | Hvordan |
|---|---|---|
| Serveren | GPS | En USB-mottaker (for eksempel u-blox) med `gpsd` og `chrony`. Aktiv antenne på kabel med fri sikt mot himmelen. `local stratum 10` holder alle på samme tid hvis GPS-en faller ut |
| Pi-en | Serveren | `chrony` med serveren som kilde. Stiller klokka i ett hopp bare ved oppstart (`makestep`), ellers gradvis. Er tidsserver for PLS-en på kjøretøyets nett |
| PLS-en | Pi-en | Den innebygde NTP-klienten i S7-1200, rettet mot Pi-en (eller mot serveren, hvis PLS-en når den). PLS-en går på UTC (`RD_SYS_T`) |
| Reserve | PLS-klokka | Etter et strømbrudd, når WiFi ikke er oppe ennå: Pi-en stiller seg etter PLS-en |

**Reserven har sperrer.** Pi-en stiller seg etter PLS-klokka bare når:
- Pi-en ikke allerede er synkronisert;
- året fra PLS-en virker riktig;
- tiden ikke er tidligere enn det nyeste tidsstempelet i `recorder.db`;
- huben og recorderen ikke har startet ennå. Etterpå justeres klokka bare gradvis.

TcpLink tar bare én klient, og den er adapteren. PLS-tiden må derfor komme via adapteren, som en
tallverdi. Å stille klokka krever root, så det gjør en liten egen tjeneste.

**Dataene stemples med PLS-tiden fra meldingen.** Adapteren sender tiden fra headeren som `ts` i
`update`. Huben og recorderen bruker den allerede. Da bruker sanntidsdata og data fra ringen samme
klokke uansett. Alt lagres i UTC.

**Lagrede tider skrives aldri om.** Hver gang Pi-en er synkronisert mot serveren, logges en
observasjon: PLS-tid, Pi-tid og serverens tid. Med de observasjonene kan en korreksjon regnes
ut senere for et tidsrom der klokkene gikk feil. Uten dem kan den ikke det.

## 4. Etter et strømbrudd

1. **Strømmen er tilbake.** PLS-en er i gang etter noen sekunder, og skriver videre i ringen.
   Det Pi-en ikke rakk å skrive (høyst 30 sekunder), er borte fra RAM.
2. **Klokka.** Pi-en starter. Er den ikke synkronisert, stiller den seg etter PLS-klokka (med
   sperrene i [3.6](#36-klokka-gps--server--pi--pls)).
3. **Sanntid igjen.** Huben, recorderen og opplasteren starter som vanlig. Den første meldingen
   fra PLS-en viser loggtelleren der sanntidsdataene begynner, for eksempel 1188.
4. **Finn og hent det som mangler.** Den siste loggtelleren i `recorder.db` er for eksempel 1158.
   `replay.js` henter 1159–1187 fra ringen med en gang.
5. **Spill av.** Postene går gjennom de samme beregningene og lagringsreglene, med PLS-tiden som
   klokke, og skrives til `recorder.db` merket som gjenopprettet.
6. **Send.** Når WiFi er oppe, sender opplasteren alt serveren ikke har bekreftet, både
   sanntidsdata og gjenopprettede data. Huben, HMI-en og alarmene har ikke merket noe.

## 5. Det som skal bygges

| Hvor | Del | Ny eller endret |
|---|---|---|
| PLS | Loggteller og epoke i en ledig dint i TcpLink | endret |
| PLS | Loggringen: remanent DB og en OUC-blokk på port 2100 | ny |
| PLS | NTP-klienten, rettet mot Pi-en | innstilling |
| Pi | `tcplink-adapter.js`: PLS-tiden som `ts` i `update`, PLS-tiden som tallverdi, loggtelleren som tag | endret |
| Pi | `recorder.js`: merket for gjenopprettet, en tabell for klokkeobservasjonene, opprydding som venter på serveren | endret |
| Pi | `uploader.js`: sender fra `recorder.db`, husker hvor langt serveren har bekreftet | ny |
| Pi | `replay.js`: henter fra ringen, egen beregningsmotor, lagringsreglene, skriver til `recorder.db` | ny |
| Pi | Tjenesten som stiller klokka etter PLS-en, med sperrene | ny |
| Pi | `chrony`: serveren som kilde, tidsserver for PLS-en | innstilling |
| Server | HTTP-API som tar imot batcher og svarer OK etter COMMIT, med unik nøkkel per rad | ny |
| Server | Databasen, med kilde per rad (sanntid eller gjenopprettet) og klokkeobservasjonene | ny |
| Server | GPS-mottaker, `gpsd`, `chrony` | ny |

## 6. Rekkefølgen

Hver fase virker alene, og de første er små og trygge.

1. **Klokka.** GPS og `chrony` på serveren, `chrony` på Pi-ene, NTP i PLS-en. Adapteren stempler
   med PLS-tiden. Klokkeobservasjonene begynner å logges. Dette gjør nytte fra første dag.
2. **Opplastingen.** Serverens API og database, og `uploader.js` som sender fra `recorder.db`.
   Oppryddingen venter på serveren.
3. **Ringen i PLS-en.** Loggtelleren og epoken i sanntid, og loggringen på port 2100.
4. **`replay.js`, taggene.** Finn hva som mangler, hent fra ringen, lagre lokalt merket som
   gjenopprettet. Uten beregninger.
5. **`replay.js`, beregningene.** Den egne motoren med `lib/calc.js`, og testen som sammenligner
   den med huben.

## 7. Åpne spørsmål

- **Hvilke signaler skal være med i ringen, og hvor ofte?** Det avgjør hvor mye remanent minne den
  bruker. Fasiten for minnet står under Program info i TIA.
- **Når PLS-en serveren selv, eller bare Pi-en?** Det avgjør hvor NTP-klienten i PLS-en peker.
- **Har Pi-ene batteri på RTC-en?** Pi 5 har en innebygd RTC, men holder bare tiden uten strøm med
  et batteri tilkoblet.
- **Hvor lange kan WiFi-bruddene bli?** Det avgjør hvor mye `recorder.db` må kunne holde (i dag:
  7 dager, høyst 1000 MB).
- **Databasen og API-et på serveren:** hvilken database (for eksempel PostgreSQL), og hvordan
  kjøretøyene identifiserer seg.
- **Alarmer og hendelser i et gjenopprettet tidsrom:** skal `replay.js` lagre dem som hendelser,
  merket som gjenopprettet?

## 8. Begrensninger vi lever med

- **Gjenopprettede data er aldri finere enn ringen.** Med én post i sekundet ses ikke en
  kollisjon som varer et halvt sekund, og beregningene i det tidsrommet blir grovere enn i
  sanntid.
- **Er Pi-en borte lenger enn ringen rekker** (for eksempel ødelagt), skrives de eldste postene
  over. Hullet synes likevel, fordi loggtelleren hopper.
- **PLS-klokka holder seg i omtrent 20 dager uten strøm** (kondensator), så vidt vi vet, og kan
  drive rundt 60 sekunder i måneden. Avviket vi har sett, er 8 minutter. Et batterikort
  (BB 1297) gir lengre backup. NTP-kjeden over holder den riktig når den er tilkoblet.
- **GPS trenger fri sikt mot himmelen.** Uten den holder `chrony` serverens klokke med den driften
  den har målt, og alle har fortsatt samme tid.
