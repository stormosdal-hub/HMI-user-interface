# Beregninger og betingelser

En referanse for alt du kan skrive i **ƒ Calculations**: verdier regnet ut fra tagger,
betingelser, kontroller over tid og hendelsene de utløser.

Beregninger settes opp i nettleseren, men **kjører i huben**. De fortsetter å gi verdier selv
om alle nettlesere er lukket, alle HMI-er viser samme resultat, trender har historikk, og en
database kan lagre dem som en hvilken som helst annen tag.

## Innhold

1. [Kom i gang](#1-kom-i-gang)
2. [Editoren](#2-editoren)
3. [Verdier i en formel](#3-verdier-i-en-formel)
4. [Operatorer](#4-operatorer)
5. [Funksjoner](#5-funksjoner)
6. [Betingelser](#6-betingelser)
7. [Kontroller over tid](#7-kontroller-over-tid)
8. [Resultater, kvalitet og når de regnes ut](#8-resultater-kvalitet-og-når-de-regnes-ut)
9. [Hendelser](#9-hendelser)
10. [Bruke beregnede tagger](#10-bruke-beregnede-tagger)
11. [Eksempler etter oppgave](#11-eksempler-etter-oppgave)
12. [Fallgruver](#12-fallgruver)
13. [Feilmeldinger](#13-feilmeldinger)
14. [Hvordan beregninger lagres](#14-hvordan-beregninger-lagres)

---

## 1. Kom i gang

1. Bytt til **Edit** (skriv inn passkoden hvis prosjektet har en) og trykk
   **ƒ Calculations** i topplinjen.
2. Trykk **+ Add calculation** og gi beregningen et navn, for eksempel `motor_power`.
   Resultatet blir taggen `calc.motor_power`.
3. Skriv formelen og velg typen: **number** for tallverdier, **boolean** for
   ja/nei-betingelser.
4. Følg med på direktesjekken under formelen, og trykk så **Save & apply**. Huben begynner
   å bruke den med en gang.
5. Bind en hvilken som helst widget til `calc.motor_power`. Den viser en fiolett **ƒ**, og
   holder du musen over ƒ-en, vises formelen.

Tre typiske beregninger:

```
calc.kv_speed_rpm   number    ${kv}.speedAct / 16384 * 3000
calc.at_speed       boolean   ${kv}.speedAct > 5000 && ${kv}.zsw1_enabled && !${kv}.zsw1_fault
calc.cable_fault    boolean   changes(${kv}.bit06, 2) >= 6          event: warning "Loose cable?"
```

---

## 2. Editoren

Hver beregning er et kort med disse feltene:

| Felt | Betydning |
|---|---|
| **Navn** | Delen etter `calc.`. Bokstaver, sifre og `_`, og første tegn må være en bokstav eller `_`; punktum kan skille deler (`line1.power`). Må være unikt. |
| **Type** | *number* eller *boolean*. Se [Resultater](#8-resultater-kvalitet-og-når-de-regnes-ut). |
| **Måleenhet** | Vises sammen med taggen, for eksempel i tagoversikten. Widgeter bruker sin egen innstilling for måleenhet. |
| **Desimaler** | Hvor mange desimaler forhåndsvisningen i editoren viser. Widgeter har sin egen innstilling. |
| **Formel** | Det som skal regnes ut. |
| **Insert tag…** | Setter inn en tag ved markøren. Hvis en prosjektvariabel peker på enheten, settes den inn som `${kv}.speedAct`, slik at formelen følger variabelen. |
| **Insert example…** | Erstatter formelen med et mønster å starte fra. Bytt ut `device.*`-navnene med dine egne tagger. |
| **Note** (merknad) | Fritekst: hva dette er, og hvorfor. |
| **When it becomes true** | Valgfri hendelse: *Info*, *Warning* eller *Alarm*, med tekst. Se [Hendelser](#9-hendelser). |

Under formelen oppdateres to statuslinjer mens du skriver:

- **Direktesjekken** kommer fra hubens egen parser, så den viser nøyaktig det som vil kjøre.
  Den viser det nåværende resultatet (`= 2.71 kW`), taggene formelen bruker, feil med
  tegnposisjon, og tagger som ikke finnes på huben akkurat nå (for eksempel fra en enhet som
  ikke er tilkoblet). For formler med tidsfunksjoner står det at de begynner å måle først når
  de er lagret.
- **Running on hub** viser hva huben produserer nå for en beregning som allerede er lagret,
  og sier fra hvis du har endret den siden.

**Save & apply** lagrer hele prosjektet og laster beregningene på nytt i huben. Det trengs
ingen omstart. En beregning med feil blir lagret, men kjører ikke før feilen er rettet;
resultatet forblir foreldet (stale).

---

## 3. Verdier i en formel

### Tagger

| Form | Eksempel | Merknader |
|---|---|---|
| `device.name` | `kv_1.speedAct` | Et tagnavn med minst ett punktum. Delene etter den første kan begynne med et siffer: `kv_1.bit00`. |
| `${variable}.name` | `${kv}.speedAct` | Prosjektvariabelen fylles inn før formelen leses (`kv=kv_1`). Endre variabelen, så følger formelen etter. |
| `calc.name` | `calc.kv_speed_rpm` | Resultatet av en annen beregning. |
| `[any name]` | `[plc-2.motor-temp]` | Hakeparenteser for navn med `-` eller andre tegn. |

Et ord uten punktum, som `speed`, er ikke en tag. Det gir feilen *"speed" is not a tag*,
med mindre det er en av konstantene nedenfor.

### Tall og konstanter

| Skrevet | Verdi |
|---|---|
| `42`, `2.5`, `.5`, `1e3`, `2.5e-3` | Tall |
| `pi` | 3.14159… |
| `e` | 2.71828… |
| `true`, `false` | 1 og 0 |

### Hva tagverdier regnes som

| Taggen inneholder | Regnes som |
|---|---|
| Et tall | Det tallet |
| `true` / `false` | `1` / `0`, så `a + b + c` teller hvor mange av tre boolske verdier som er sanne |
| Tekst som er et tall (`"42"`) | Det tallet |
| Annen tekst (en DTL-tid som tekst, navn) | *Ikke et tall*. Se [Fallgruver](#12-fallgruver). |
| Ingenting ennå (enheten er ikke tilkoblet) | Beregningen venter, og resultatet er foreldet |

---

## 4. Operatorer

Fra løsest til sterkest binding. Operatorer på samme rad regnes ut fra venstre mot høyre,
bortsett fra der det står noe annet.

| Operatorer | Betydning | Resultat |
|---|---|---|
| `cond ? a : b` | Hvis cond, så a, ellers b (fra høyre mot venstre, så kjeder virker) | a eller b |
| `\|\|` | Eller | 1 eller 0 |
| `&&` | Og | 1 eller 0 |
| `==` `!=` `<` `<=` `>` `>=` | Sammenligning | 1 eller 0 |
| `+` `-` | Addisjon, subtraksjon | tall |
| `*` `/` `%` | Multiplikasjon, divisjon, rest | tall |
| `-x` `+x` `!x` | Negativ, positiv, ikke | tall, eller 1/0 for `!` |
| `^` | Potens (fra høyre mot venstre) | tall |
| `( )` | Gruppering | |

Verdt å vite:

- **Presedens:** `-2^2` er `-4`, `2^3^2` er `512` og `2^-1` er `0.5`.
- **Kortslutning:** `&&` og `||` stopper så snart svaret er kjent. Det gjør også `if()` og
  `? :`, som bare regner ut den grenen de velger.
- **`!` binder sterkt:** `!a && b` betyr `(!a) && b`.
- **Fortegn ved rest:** `%` beholder fortegnet til venstre side, så `-7 % 3` er `-1`.
- **Sammenligning:** skriv `==` for å sammenligne. Et enkelt `=` er en feil.

---

## 5. Funksjoner

| Funksjon | Resultat |
|---|---|
| `abs(x)` | Absoluttverdi |
| `sqrt(x)` | Kvadratrot |
| `pow(x, y)` | x opphøyd i y (samme som `x ^ y`) |
| `exp(x)`, `log(x)`, `log10(x)` | e^x, naturlig logaritme, logaritme med grunntall 10 |
| `sin(x)`, `cos(x)`, `tan(x)` | Trigonometri, **vinkler i radianer** (`deg * pi / 180`) |
| `asin(x)`, `acos(x)`, `atan(x)`, `atan2(y, x)` | Inverse trigonometriske funksjoner, i radianer |
| `floor(x)`, `ceil(x)` | Rund ned, rund opp |
| `round(x)`, `round(x, digits)` | Rund av til 0–12 desimaler. Halve rundes opp: `round(2.5)` er 3, `round(-2.5)` er -2 |
| `sign(x)` | -1, 0 eller 1 |
| `min(a, b, …)`, `max(a, b, …)` | Minste, største |
| `sum(a, b, …)`, `avg(a, b, …)` | Sum, gjennomsnitt |
| `hypot(a, b, …)` | √(a² + b² + …) |
| `clamp(x, lo, hi)` | x begrenset til området lo…hi |
| `if(cond, a, b)` | a når cond er sann, ellers b (bare grenen som velges, regnes ut) |
| `count(a, b, …)` | Hvor mange av argumentene som er sanne, altså ulik null |
| `between(x, lo, hi)` | 1 når lo ≤ x ≤ hi, begge endepunktene inkludert |

Det finnes ingen bitoperatorer. For å teste bit *n* i et ord, bruk `floor(x / 2^n) % 2 == 1`.
For eksempel tester `floor(${kv}.statusWord / 8) % 2 == 1` bit 3. For statusord som en
layoutfil allerede deler opp i navngitte biter, som `${kv}.zsw1_fault`, bruker du heller dem.

---

## 6. Betingelser

Velg typen **boolean** for en betingelse. Resultatet er `true` når formelen gir noe annet
enn 0, og ellers `false`.

| Du vil ha | Skriv |
|---|---|
| Alle sammen | `a && b && c` |
| Minst én av dem | `a \|\| b \|\| c` |
| Ikke | `!a` |
| Minst N av dem | `count(a, b, c) >= 2` |
| Nøyaktig N av dem | `count(a, b, c) == 1` |
| Ingen av dem | `count(a, b, c) == 0` eller `!(a \|\| b \|\| c)` |
| En verdi over, under | `x > 5000`, `x <= 20` |
| En verdi innenfor et bånd | `between(x, 900, 1100)` |
| En verdi utenfor et bånd | `!between(x, 900, 1100)` |
| En bestemt tilstand eller modus | `${kv}.ints_2 == 3` |
| Enhver tilstand unntatt én | `${kv}.ints_2 != 0` |

Betingelser kan kombineres fritt. For eksempel: kjører over 5000, sensor 1 og 3 på, sensor 2
av, og ingen feil:

```
${kv}.speedAct > 5000 && ${kv}.bit01 && ${kv}.bit03 && !${kv}.bit02 && !${kv}.zsw1_fault
```

**En verdi i stedet for sann/usann:** velg typen *number* og velg verdien med `if()` eller
`? :`.

```
if(${kv}.speedAct > 5000 && ${kv}.bit01, 1, 0)                 1 når oppfylt, ellers 0
${kv}.speedAct > 5000 ? 3 : ${kv}.speedAct > 1000 ? 2 : 1      et nivå fra 1 til 3
```

---

## 7. Kontroller over tid

Tidsfunksjoner husker inndataene sine, så en formel kan se bakover. Det siste argumentet er en
tid i sekunder. Det må være et rent tall fra `0.05` til `3600`, ikke en tag.

| Funksjon | Svarer på |
|---|---|
| `changes(x, s)` | Hvor mange ganger x har endret seg de siste s sekundene |
| `rate(x, s)` | Hvor fort x endrer seg, per sekund, målt over de siste s sekundene |
| `delta(x, s)` | Hvor mye x har endret seg de siste s sekundene |
| `held(cond, s)` | Sann når cond har vært sann i s sekunder uten avbrudd |
| `stretch(cond, s)` | Sann mens cond er sann, og i s sekunder etter at den slutter |
| `avgOver(x, s)` | Gjennomsnittet av x de siste s sekundene, vektet etter tid |
| `minOver(x, s)` | Laveste verdi av x de siste s sekundene |
| `maxOver(x, s)` | Høyeste verdi av x de siste s sekundene |

### I detalj

- **`changes(x, s)`** teller hver verdiendring. En puls (av, på, av) teller som 2. Den
  første verdien etter lagring er ikke en endring.
- **`rate(x, s)`** er verdien nå minus verdien for s sekunder siden, delt på s: måleenheter
  per sekund. En hastighet i rpm gir rpm per sekund. Før det har gått s sekunder siden
  lagring, måler den over tiden som er tilgjengelig.
- **`delta(x, s)`** er verdien nå minus verdien for s sekunder siden. Før det har gått så
  lang tid, er den endringen siden lagring.
- **`held(cond, s)`** slår seg på etter s sekunder med cond uten avbrudd, og av i det
  øyeblikket cond brytes. Den er en *påslagsforsinkelse* (on-delay): glitcher kortere enn s
  når aldri fram til resultatet.
- **`stretch(cond, s)`** slår seg på sammen med cond, og blir stående på i s sekunder etter at
  cond slutter. Den er en *avslagsforsinkelse* (off-delay): den holder en kort hendelse
  synlig lenge nok til at den kan ses og lagres.
- **`avgOver`, `minOver`, `maxOver`** dekker de siste s sekundene, inkludert verdien
  inngangen hadde da vinduet startet. Gjennomsnittet er vektet etter hvor lenge hver verdi
  varte.

### Hvordan de får dataene sine

- **Når det første argumentet er en tag** (`changes(${kv}.bit06, 2)`), sender huben hver
  endring av taggen til funksjonen i det øyeblikket den kommer. Ingen endring går tapt, heller
  ikke flere mellom to kontroller. `stretch` fanger da også opp pulser kortere enn en tidel av
  et sekund.
- **Når det første argumentet er et uttrykk** (`held(a && b, 3)`), leses det hver gang
  beregningen regnes ut: når en inngang endres, og ti ganger i sekundet.
- **Beregninger med tidsfunksjoner kontrolleres på nytt ti ganger i sekundet,** så `held`
  slår seg på i riktig øyeblikk, og `changes` faller tilbake når endringene stopper.
- **De kan nøstes:** `stretch(changes(${kv}.bit06, 2) >= 6, 10)`.

### Når de starter på nytt

En tidsfunksjon glemmer alt og begynner å måle på nytt:
- **når beregningen lagres,** eller huben starter;
- **når en av beregningens innganger blir foreldet,** for eksempel når PLS-forbindelsen faller
  ut. Uten dette ville verdihoppet når dataene kommer tilbake, se ut som en brå endring, for
  eksempel en falsk kollisjonsalarm.

Hver tidsfunksjon tar vare på høyst 20 000 endringer. Bare et signal som endrer seg oftere enn
20 000 ganger per vindu, ville nå den grensen.

---

## 8. Resultater, kvalitet og når de regnes ut

### Type

| Type | Resultat |
|---|---|
| **number** | Formelens verdi, avrundet til 12 gjeldende sifre. Et resultat som ikke er et endelig tall (divisjon med null, tekst som inndata), er **foreldet**, med en merknad om hvorfor. |
| **boolean** | `true` når formelen gir et tall ulik null, ellers `false`. |

### Kvalitet

Et resultat er aldri bedre enn den dårligste inngangen:

| Situasjon | Resultat |
|---|---|
| Alle innganger er gode | God |
| En inngang er usikker | Usikker |
| En inngang er foreldet (enheten er frakoblet) | **Foreldet**: siste verdi blir stående, vist i grått |
| En inngang har ingen verdi ennå | Foreldet, med merknaden "waiting for …" |
| Formelen har en feil | Foreldet, med feilen |
| Divisjon med null, eller ikke et tall | Foreldet (typen number), med merknaden |

Foreldet er konservativt. I `if(cond, a, b)` er resultatet foreldet hvis *noen* inngang er
foreldet, også en i grenen som ikke brukes.

### Når huben regner dem ut

- **Når en inngang endres.** En serie endringer som kommer samtidig, regnes ut én gang, i
  riktig rekkefølge: en beregning som bruker en annen, kommer etter den.
- **Ti ganger i sekundet** for beregninger med tidsfunksjoner.
- **Uendrede resultater sendes ut høyst én gang i sekundet.** Det er nok til at trender får
  ett punkt per sekund uten at historikken oversvømmes.

---

## 9. Hendelser

Enhver beregning kan utløse en hendelse når resultatet blir **sant** (for tall: blir ulik
null). Velg en alvorlighetsgrad under *When it becomes true* og skriv teksten.

| Når | Hendelse |
|---|---|
| Resultatet blir sant | Teksten din, med valgt alvorlighetsgrad (*info*, *warning* eller *alarm*) |
| Det blir usant igjen | *info*: "Cleared: " fulgt av teksten din |
| Resultatet er allerede sant når huben starter | Teksten din: det er en reell tilstand, så den logges |
| Du lagrer prosjektet mens det er sant | Ingenting nytt: lagringen husker hva som allerede er logget |

Kilden til hendelsen er beregningens tag, for eksempel `calc.kv_crash`.

- **Hva som ikke teller:** foreldede resultater utløser eller fjerner aldri hendelser.
- **Frekvensgrense:** høyst én hendelse per beregning per sekund. Endringer i mellomtiden
  holdes tilbake og slås sammen med neste hendelse, som "(2 more changes in the second
  before)". Sluttilstanden logges alltid, og blir aldri forkastet.
- **Hvor hendelsene havner:** hendelser vises i hver Event log-widget og går til hver klient
  av huben. En database som er koblet til huben, kan derfor lagre dem sammen med taggene, slik
  at uønskede tilstander kan søkes opp senere: løse kabler, kollisjoner, kjøring med feil.

For signaler som kan flimre av og på, legg til `held` eller `stretch`, så hver forekomst gir
én tydelig hendelse, ikke en byge.

---

## 10. Bruke beregnede tagger

- **Hvor de passer inn:** en beregnet tag er en vanlig tag som **bare kan leses**, med navnet
  `calc.<name>`. Bind den til en hvilken som helst widget, tegningskobling, animasjonsinngang
  eller trend. Widgeter som viser en, har en fiolett **ƒ**.
- **Kjeding:** beregninger kan bruke andre beregninger (`calc.kv_power_w` bruker
  `calc.kv_speed_rpm`). Huben finner rekkefølgen selv, og rapporterer sirkulære referanser
  (`a` bruker `b` bruker `a`) som feil.
- **Reserverte navn:** enheter og adaptere kan ikke publisere tagger under `calc.`, så en
  beregnet verdi kan aldri bli overskrevet.
- **Finne dem:** tagoversikten (tag browser) lister dem under *calc*, med formlene, og kan
  filtrere slik at bare beregnede tagger vises.

---

## 11. Eksempler etter oppgave

I disse eksemplene er `${kv}` Kjoreverk-PLS-en (`kv=kv_1`). Bytt ut taggene med dine egne.

### Omregninger og avledede verdier

```
Hastighet i rpm (16#4000 = p2000 = 3000 rpm)   ${kv}.speedAct / 16384 * 3000
Moment i Nm (16#4000 = p2003 = 1.00 Nm)        ${kv}.torqueAct / 16384 * 1.0
Akseleffekt i W                                calc.kv_torque_nm * calc.kv_speed_rpm * 2 * pi / 60
Temperatur fra tideler av en grad              ${kv}.ints_1 / 10
Virkningsgrad i %, tåler 0 som inndata         if(calc.power_in > 0, calc.power_out / calc.power_in * 100, 0)
Begrenset til et område                        clamp(${kv}.ints_0, 0, 3000)
```

### Betingelser

```
Normal kjøring                      boolean   abs(calc.kv_speed_rpm) > 100 && ${kv}.zsw1_enabled && !${kv}.zsw1_fault
Minst 2 av 3 sensorer               boolean   count(${kv}.bit01, ${kv}.bit02, ${kv}.bit03) >= 2
Hastighet innenfor arbeidsbåndet    boolean   between(calc.kv_speed_rpm, 1400, 1600)
Et bestemt steg i en sekvens        boolean   ${kv}.ints_2 == 4
Bit 3 i et ord, uten navngitt bit   boolean   floor(${kv}.words_0 / 8) % 2 == 1
Et tilstandsnummer for en lampe     number    ${kv}.zsw1_fault ? 2 : ${kv}.zsw1_alarm ? 1 : 0
```

### Kontroller over tid

```
Løs kabel: sensoren flimrer                     boolean   changes(${kv}.bit06, 2) >= 6
Kollisjon: farten endres raskere enn rampen     boolean   abs(rate(calc.kv_speed_rpm, 0.3)) > 4000
Hold en kollisjon synlig i 10 s                 boolean   stretch(calc.kv_crash, 10)
Jevn fart: stabil i 3 s                         boolean   held(abs(calc.kv_speed_rpm) > 1000 && ${kv}.zsw1_enabled, 3)
Ignorer glitcher under 0.5 s                    boolean   held(${kv}.bit07, 0.5)
Ignorer glitcher, og hold så på i 2 s           boolean   stretch(held(${kv}.bit07, 0.5), 2)
Frossen sensor: ingen endring på 60 s i drift   boolean   held(${kv}.bit01, 60) && changes(${kv}.ints_1, 60) == 0
Pulser det siste minuttet                       number    changes(${kv}.bit08, 60) / 2
Akselerasjon i rpm per sekund                   number    rate(calc.kv_speed_rpm, 0.5)
Strekning den siste timen, i m                  number    delta(${kv}.dints_0, 3600) / 1000
Gjennomsnittstemperatur over 10 minutter        number    avgOver(${kv}.ints_1, 600) / 10
Høyeste moment det siste minuttet               number    maxOver(calc.kv_torque_nm, 60)
Energi den siste timen, kWh (effekt i kW)       number    avgOver(calc.power_kw, 3600)
```

Noen av disse trenger en forklaring:

- **Frossen sensor:** en verdi som ikke endrer seg i det hele tatt på et minutt mens
  kjøretøyet kjører, er i seg selv mistenkelig. Det gjelder bare signaler som alltid beveger
  seg litt under kjøring, som en analog verdi med støy. En verdi som helt legitimt står
  stille i et minutt, ville utløse den.
- **Energi:** gjennomsnittseffekten over én time, i kW, er lik energien i kWh. Den er bare
  riktig når huben har kjørt i en hel time; før det er den gjennomsnittet over kortere tid.
- **Totaler:** tidsfunksjoner ser høyst en time bakover. For totaler siden starten av dagen
  eller skiftet, tell i PLS-en, eller spør databasen.

---

## 12. Fallgruver

| Fallgruve | Hvorfor | Gjør heller |
|---|---|---|
| `1 < x < 2` | Leses som `(1 < x) < 2`, og det er alltid sant | `between(x, 1, 2)` eller `x > 1 && x < 2` |
| `0.1 + 0.2 == 0.3` | Desimalbrøker er ikke eksakte i binær form; resultatet er usant | `abs(a - b) < 0.001` |
| `x = 3` | Et enkelt `=` er ikke en sammenligning | `x == 3` |
| Bruke en teksttag | Tekst er ikke et tall: et *number*-resultat blir foreldet, et *boolean*-resultat blir usant | Bruk en numerisk tag, eller gjør teksten om til et tall i PLS-en |
| `rate(x, 0.3)` rett etter lagring | Tidsfunksjoner har ingen historikk ennå | Vent ett vindu før du vurderer resultatet |
| `rate(x, calc.window)` | Tiden må være et fast tall | `rate(x, 2)` |
| Sammenligne hastigheter med `==` | Målte verdier treffer sjelden et eksakt tall | `between()`, eller `abs(x - target) < tolerance` |
| Vinkler i grader i `sin()` | Trigonometriske funksjoner bruker radianer | `sin(deg * pi / 180)` |
| `round(-2.5)` | Halve rundes opp, og det gir -2 | Greit for visning, men husk det |
| En flimrende betingelse med hendelse | Én hendelse per endring, opptil én gang i sekundet | Pakk den inn i `held()` eller `stretch()` |

---

## 13. Feilmeldinger

| Melding | Betydning |
|---|---|
| *use == to compare* | Et enkelt `=` i formelen |
| *"speed" is not a tag (tags look like device.name) or a known constant* | Et ord uten punktum. Legg til enhetsdelen, eller bruk `${var}.speed` |
| *unknown function foo()* | En feilstavet funksjon; navnene skiller mellom store og små bokstaver (`avgOver`, ikke `avgover`) |
| *unknown variable ${dev}* | Prosjektet har ingen variabel `dev`. Sjekk *Variables* i prosjektpanelet |
| *sqrt() takes 1 argument*, *if() takes 3 arguments* | Feil antall verdier i parentesen |
| *rate(): the time must be a number of seconds from 0.05 to 3600* | Tiden er en tag, et uttrykk eller utenfor området |
| *rate() takes an input and a time in seconds, like rate(x, 2)* | Tiden mangler |
| *formula ends too early*, *expected ")"* | En parentes eller verdi mangler på slutten |
| *unexpected "…"* | Noe står på feil plass ved den posisjonen |
| *missing ] after tag name* | En `[` uten tilhørende `]` |
| *circular reference: calc.a → calc.b → calc.a* | Beregninger som bruker hverandre i en løkke |
| *uses calc.x, which is not defined* | Formelen bruker en beregning som ikke finnes |
| *calc.x is defined more than once* | To beregninger med samme navn |
| *the name may only use letters, digits and _ (dots between parts)* | Et ugyldig navn |
| *waiting for kv_1.speedAct* (en merknad, ikke en feil) | Den inngangen har ingen verdi ennå: enheten er ikke tilkoblet |
| *result is infinite (division by zero?)* | En divisjon med null; beskytt den med `if(b != 0, a / b, 0)` |
| *result is not a number* | Som regel tekst som inndata, eller `sqrt` eller `log` av et negativt tall |

Feil vises i rødt under formelen, med tegnposisjonen. **ƒ**-en på widgeter blir rød så lenge
en beregning de bruker, har en feil.

---

## 14. Hvordan beregninger lagres

Beregninger lagres i prosjektfilen, `hmi.json`, under `calcs`:

```json
"calcs": [
  {
    "name": "kv_crash",
    "formula": "abs(rate(calc.kv_speed_rpm, 0.3)) > 4000",
    "type": "boolean",
    "unit": "",
    "decimals": 0,
    "description": "The drive ramps at 1500 rpm/s; faster changes mean a collision.",
    "event": { "severity": "alarm", "text": "Speed changed faster than the drive can ramp: crash?" }
  }
]
```

`event` utelates når en beregning ikke har noen. Filen kan redigeres for hånd. Huben laster
beregningene når den starter, og laster dem på nytt hver gang prosjektet lagres.
