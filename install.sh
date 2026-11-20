#!/bin/bash
# install.sh - setter opp en Raspberry Pi i et kjøreverk, så alt starter av seg selv:
#
#   kjøreverkets navn   /etc/kjoreverk/vehicle
#   tjenestene          /etc/systemd/system/kjoreverk@.service og /etc/kjoreverk/instances/*.env:
#                       hub, tcplink-adapter, plcdiag-adapter og recorder
#   recorderen          /etc/kjoreverk/recorder.json: serveren og nøkkelen for dette kjøreverket
#   klokka              tidsserveren, i systemd-timesyncd eller chrony
#   loggene             i RAM, så journald ikke skriver til SD-kortet (ikke med --disk-logs)
#   Bluetooth           HMI-et for nettbrett på http://192.168.1.<kjøreverksnummer>:8080, paret med en
#                       PIN-kode per kjøreverk: bluetooth/ i /usr/local/lib/kjoreverk-bt og
#                       /etc/kjoreverk/bt.json (ikke med --no-bluetooth)
#   LCD-editoren        skjermbilder til displayer på Pi-en, med taggene fra huben: lcd-editor/ som
#                       kjoreverk-lcd.service (bare med --lcd, og så til --no-lcd)
#
# Den kjøres fra prosjektmappen, helst /opt/kjoreverk, og setter opp tjenestene for mappen den
# ligger i:
#
#   sudo bash /opt/kjoreverk/install.sh                 spør etter det som mangler
#   sudo bash /opt/kjoreverk/install.sh --vehicle kv_52 --plc 10.0.123.51:2000 \
#        --server http://dbserver:8090 --token <nøkkelen> --yes
#
# Den kan kjøres på nytt, for eksempel etter en oppdatering: det som står fra før, blir standard,
# og tjenestene startes på nytt. Den skriver bare filer som er endret. Se README_systemd-service.md.

set -euo pipefail
shopt -s lastpipe   # ... | put: put kjører i dette skallet, så CHANGED blir stående

PROJECT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
RECOMMENDED=/opt/kjoreverk
ETC=/etc/kjoreverk
UNIT=/etc/systemd/system/kjoreverk@.service
RECORDER_JSON=$ETC/recorder.json
OLD_RECORDER_JSON=/etc/hmi-recorder.json                # recorderens fil før install.sh
OPTIONS_JSON=$PROJECT/hmi-core/adapters/tcplink-options/kjoreverk-options.json
TIMESYNCD_CONF=/etc/systemd/timesyncd.conf.d/kjoreverk.conf
JOURNALD_CONF=/etc/systemd/journald.conf.d/kjoreverk.conf
CHRONY_MARK='# the time server for the kjøreverk (install.sh)'
DEFAULT_NTP=10.0.0.104
HUB_PORT=8080
BT_LIB=/usr/local/lib/kjoreverk-bt                    # programmene kjører som root, så de ligger ikke i prosjektmappen
BT_JSON=$ETC/bt.json
BT_UNIT=/etc/systemd/system/kjoreverk-bt.service
BT_DHCP_UNIT=/etc/systemd/system/kjoreverk-bt-dhcp.service
BT_POOL_FIRST=200                                     # nettbrettene får .200 og oppover (bluetooth/btnet.py)
DHCPCD_CONF=/etc/dhcpcd.conf
DHCP_HELPER_DEFAULT=/etc/default/dhcp-helper
LCD_DIR=$PROJECT/lcd-editor
LCD_UNIT=/etc/systemd/system/kjoreverk-lcd.service
OLD_LCD_SERVICE=oled-editor.service                   # LCD-editorens egen tjeneste, fra install-service.sh

VEHICLE_RX='^[A-Za-z_][A-Za-z0-9_.-]{0,31}$'            # som lib/vehicle.js
VEHICLE_RULE='a letter first, then letters, digits, _ . -; at most 32 characters'
PLC_RX='^[A-Za-z0-9._-]+:[0-9]{1,5}$'
SERVER_RX='^https?://[^/[:space:]]+[^[:space:]]*$'
HOST_RX='^[A-Za-z0-9._:-]+$'
PIN_RX='^[0-9]{4,16}$'

usage() {
  cat <<EOF
Sets up this Raspberry Pi for a kjøreverk: the vehicle's name, the services (hub, tcplink-adapter,
plcdiag-adapter, recorder), the recorder's server and key, the time server, the logs and the HMI over
Bluetooth. Run it from the project folder, preferably $RECOMMENDED:

  sudo bash $RECOMMENDED/install.sh [options]

  --vehicle NAME   the vehicle's name, e.g. kv_52 (alarm list, event log, central server)
  --plc IP:PORT    the PLC (default: what is set up already, else "connect" in kjoreverk-options.json);
                   plcdiag-adapter reads its diagnostic buffer from the web server at the same address
  --server URL     the central server for the recorder, e.g. http://dbserver:8090
  --token KEY      this vehicle's key, made on the central server
  --no-recorder    don't run the recorder (stops it if it runs)
  --user NAME      the user the services run as (default: the one already set up, else you)
  --ntp HOST       the time server (default $DEFAULT_NTP)
  --disk-logs      let journald keep the logs on the SD card (default: in RAM, gone after a restart)
  --no-bluetooth   no HMI over Bluetooth (stops it if it runs; it stays off when this is run again)
  --bluetooth      the HMI over Bluetooth on again after --no-bluetooth (it is on by default)
  --bt-pin PIN     the PIN a tablet types once to pair, 4-16 digits (default: the one set up, else a new one)
  --lcd            the LCD editor and the displays on this Pi (lcd-editor/); it stays on when this is run again
  --no-lcd         no LCD editor (stops it if it runs)
  -y, --yes       don't ask; use what is given and what is set up already
  -h, --help       this text

Without options it asks for what is missing. Running it again keeps what is set up and restarts
the services.
EOF
}

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- valgene
vehicle='' plc='' server='' token='' user='' ntp='' no_recorder=0 disk_logs=0 yes=0 bt_flag='' bt_pin='' lcd_flag=''
while [ $# -gt 0 ]; do
  arg=$1; shift
  val=''
  case $arg in --*=*) val=${arg#*=}; arg=${arg%%=*} ;; esac
  case $arg in
    --vehicle|--plc|--server|--token|--user|--ntp|--bt-pin)
      if [ -z "$val" ]; then
        [ $# -gt 0 ] || die "$arg needs a value (see --help)"
        val=$1; shift
      fi
      case $arg in
        --vehicle) vehicle=$val ;;
        --plc)     plc=$val ;;
        --server)  server=$val ;;
        --token)   token=$val ;;
        --user)    user=$val ;;
        --ntp)     ntp=$val ;;
        --bt-pin)  bt_pin=$val ;;
      esac ;;
    --no-recorder) no_recorder=1 ;;
    --disk-logs)   disk_logs=1 ;;
    --bluetooth)    bt_flag=on ;;
    --no-bluetooth) bt_flag=off ;;
    --lcd)         lcd_flag=on ;;
    --no-lcd)      lcd_flag=off ;;
    -y|--yes)      yes=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option $arg (see --help)" ;;
  esac
done

# ---------------------------------------------------------------- forutsetningene
[ "$(id -u)" -eq 0 ] || die "run it as root: sudo bash $PROJECT/install.sh"
command -v systemctl >/dev/null 2>&1 || die "systemd is needed, and systemctl isn't here"
[ -f "$PROJECT/hmi-core/hub.js" ] || die "$PROJECT/hmi-core/hub.js is missing: install.sh must lie in the project folder, next to hmi-core"
case $PROJECT in
  /|/opt|/home|/root|/usr|/usr/local|/etc|/var|/srv|/tmp)
    die "install.sh must lie in its own project folder, e.g. $RECOMMENDED/install.sh, not in $PROJECT" ;;
  *[[:space:]]*)
    die "the project folder's path has a space in it ($PROJECT); move it to $RECOMMENDED" ;;
esac
NODE=$(command -v node || true)
[ -n "$NODE" ] || die "Node.js isn't installed (or not in /usr/local/bin or /usr/bin). See \"Installere uten internett\" in hmi-core/README.md"
NODE_VERSION=$("$NODE" -v)
node_major=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 10 ] || die "Node $NODE_VERSION is too old: 10 or newer is needed"
[ -f "$PROJECT/hmi-core/node_modules/ws/package.json" ] || die "hmi-core/node_modules/ws is missing: copy the whole project folder, node_modules too"

# Leser ett felt i en JSON-fil, eller '' (filen eller feltet finnes ikke).
json_field() {
  "$NODE" -e '
    const fs = require("fs");
    let s;
    try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^﻿/, "")); }
    catch (e) { if (e.code === "ENOENT") process.exit(0); console.error(process.argv[1] + ": " + e.message); process.exit(1); }
    const v = s && s[process.argv[2]];
    if (typeof v === "string" || typeof v === "boolean") process.stdout.write(String(v));
  ' "$1" "$2"
}

# ---------------------------------------------------------------- det som står fra før
cur_vehicle=''
[ -f "$ETC/vehicle" ] && cur_vehicle=$(tr -d '[:space:]' < "$ETC/vehicle")

cur_plc=''
for f in "$ETC/instances/tcplink-adapter.env" "$ETC/instances/binary-adapter.env"; do
  [ -f "$f" ] || continue
  cur_plc=$(sed -n 's/^SCRIPT_ARGS=.*--plc=\([^[:space:]"'\'']*\).*/\1/p' "$f")
  [ -z "$cur_plc" ] || break
done
[ -n "$cur_plc" ] || cur_plc=$(json_field "$OPTIONS_JSON" connect) || die "can't read $OPTIONS_JSON"

rec_file=''
if [ -f "$RECORDER_JSON" ]; then rec_file=$RECORDER_JSON
elif [ -f "$OLD_RECORDER_JSON" ]; then rec_file=$OLD_RECORDER_JSON
fi
cur_server='' cur_token=''
if [ -n "$rec_file" ]; then
  cur_server=$(json_field "$rec_file" server) || die "fix or remove $rec_file, then run install.sh again"
  cur_token=$(json_field "$rec_file" token)
fi

cur_user=''
[ -f "$UNIT" ] && cur_user=$(awk -F= '$1 == "User" { print $2; exit }' "$UNIT")

cur_ntp=''
[ -f "$TIMESYNCD_CONF" ] && cur_ntp=$(awk -F= '$1 == "NTP" { print $2; exit }' "$TIMESYNCD_CONF")

cur_bt_pin='' cur_bt_enabled='' cur_bt_address='' cur_bt_name=''
if [ -f "$BT_JSON" ]; then
  cur_bt_pin=$(json_field "$BT_JSON" pin) || die "fix or remove $BT_JSON, then run install.sh again"
  cur_bt_enabled=$(json_field "$BT_JSON" enabled)
  cur_bt_address=$(json_field "$BT_JSON" address)
  cur_bt_name=$(json_field "$BT_JSON" name)
fi

# ---------------------------------------------------------------- spørsmålene
interactive=0
[ $yes -eq 0 ] && [ -t 0 ] && interactive=1

# pick <variabel> <gitt> <fra før> <spørsmål> <regex> <regel> <kan være tom: 0|1>
pick() {
  local var=$1 given=$2 cur=$3 question=$4 rx=$5 rule=$6 optional=$7 v=''
  if [ -n "$given" ]; then
    v=$given
  elif [ $interactive -eq 1 ]; then
    while :; do
      read -r -p "$question${cur:+ [$cur]}: " v || die "no answer"
      v=${v:-$cur}
      { [ -z "$v" ] && [ "$optional" = 1 ]; } && break
      [[ $v =~ $rx ]] && break
      say "  $rule"
    done
  else
    v=$cur
  fi
  if [ -n "$v" ] && ! [[ $v =~ $rx ]]; then die "\"$v\": $rule"; fi
  printf -v "$var" '%s' "$v"
}

pick vehicle "$vehicle" "$cur_vehicle" "The vehicle's name, e.g. kv_52" "$VEHICLE_RX" "$VEHICLE_RULE" 0
[ -n "$vehicle" ] || die "the vehicle's name is missing: give --vehicle kv_52"

pick plc "$plc" "$cur_plc" "The PLC (address:port)" "$PLC_RX" "an address and a port, like 10.0.123.51:2000" 0
[ -n "$plc" ] || die "the PLC's address is missing: give --plc 10.0.123.51:2000"

recorder=0
if [ $no_recorder -eq 0 ]; then
  pick server "$server" "$cur_server" "The central server for the recorder, e.g. http://dbserver:8090 (empty: no recorder for now)" \
    "$SERVER_RX" "an address like http://dbserver:8090" 1
  if [ -n "$server" ]; then
    recorder=1
    if [ -z "$token" ] && [ $interactive -eq 1 ]; then
      if [ -n "$cur_token" ]; then read -r -p "This vehicle's key from the central server [Enter keeps the one set up]: " token || die "no answer"
      else read -r -p "This vehicle's key from the central server (empty: add it later): " token || die "no answer"
      fi
    fi
    [ -n "$token" ] || token=$cur_token
  fi
fi
[ -z "$token" ] || [ $recorder -eq 1 ] || [ $no_recorder -eq 1 ] || die "--token needs the central server too: give --server http://dbserver:8090"

ntp=${ntp:-${cur_ntp:-$DEFAULT_NTP}}
[[ $ntp =~ $HOST_RX ]] || die "\"$ntp\" isn't a time server's address"

# Brukeren tjenestene kjører som: --user, den som står i enheten fra før, den som kjører sudo,
# eller den som eier mappen.
if [ -z "$user" ]; then
  if [ -n "$cur_user" ]; then user=$cur_user
  elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then user=$SUDO_USER
  else
    owner=$(stat -c %U "$PROJECT")
    [ "$owner" = root ] || user=$owner
  fi
fi
[ -n "$user" ] || die "which user should the services run as? Give --user pi"
[ "$user" != root ] || die "the services shouldn't run as root; give --user pi"
id -u "$user" >/dev/null 2>&1 || die "there's no user called $user"
group=$(id -gn "$user")

# Bluetooth er på, med mindre --no-bluetooth er gitt nå eller sist ("enabled": false i bt.json).
# Mangler noe på Pi-en, settes det ikke opp, og resten av oppsettet går som før.
bluetooth=1
case $bt_flag in
  off) bluetooth=0 ;;
  '')  [ "$cur_bt_enabled" != false ] || bluetooth=0 ;;
esac
[ -z "$bt_pin" ] || [[ $bt_pin =~ $PIN_RX ]] || die "--bt-pin: the PIN is 4 to 16 digits"
bt_missing='' bt_address=$cur_bt_address bt_name=${cur_bt_name:-"$vehicle HMI"} bt_pin_note='as set up'
if [ $bluetooth -eq 1 ]; then
  if [ -z "$bt_address" ]; then
    n=''
    if [[ $vehicle =~ ([0-9]+)$ ]] && [ ${#BASH_REMATCH[1]} -le 3 ]; then n=$((10#${BASH_REMATCH[1]})); fi
    if [ -n "$n" ] && [ "$n" -ge 1 ] && [ "$n" -lt $BT_POOL_FIRST ]; then bt_address=192.168.1.$n
    else bt_missing="the address 192.168.1.<number> needs a vehicle name ending in a number 1-$((BT_POOL_FIRST - 1)) (or \"address\" in $BT_JSON)"
    fi
  fi
  if [ -n "$bt_missing" ]; then :
  elif [ ! -f "$PROJECT/bluetooth/bt-hmi.py" ]; then bt_missing="$PROJECT/bluetooth is missing: copy the whole project folder"
  elif [ ! -e /sys/class/bluetooth/hci0 ]; then bt_missing="this Pi has no Bluetooth adapter (hci0)"
  elif ! command -v btmgmt >/dev/null 2>&1 || ! systemctl cat bluetooth.service >/dev/null 2>&1; then bt_missing="BlueZ (btmgmt, bluetooth.service) isn't installed"
  elif ! python3 -c 'import dbus; from gi.repository import GLib' 2>/dev/null; then bt_missing="python3 with dbus and gi isn't installed (python3-dbus, python3-gi)"
  fi
  if [ -n "$bt_missing" ]; then
    bluetooth=0
  elif [ -n "$bt_pin" ]; then
    [ "$bt_pin" = "$cur_bt_pin" ] || bt_pin_note='new (shown at the end)'
  elif [ -n "$cur_bt_pin" ]; then
    bt_pin=$cur_bt_pin
  else
    bt_pin=$(python3 -c 'import secrets; print("".join(secrets.choice("0123456789") for _ in range(8)))')
    bt_pin_note='new (shown at the end)'
  fi
fi

# LCD-editoren er av, med mindre --lcd er gitt nå eller den er slått på fra før. Den er Python: den
# trenger 3.11 eller nyere med flask og PIL, fra lcd-editor/.venv eller systemets python3.
# LCD_CHECK skriver det som mangler (exit 1), eller hva displayene må klare seg uten.
LCD_CHECK='
import importlib.util, sys
def has(m):
    try:
        return importlib.util.find_spec(m) is not None
    except ImportError:
        return False
if sys.version_info < (3, 11):
    print("it needs Python 3.11 or newer, and this is %d.%d (Raspberry Pi OS Bookworm or newer has it)" % sys.version_info[:2])
    sys.exit(1)
need = [p for m, p in (("flask", "python3-flask"), ("PIL", "python3-pil")) if not has(m)]
if need:
    print("python3 needs %s: sudo apt install %s" % (" and ".join(need), " ".join(need)))
    sys.exit(1)
without = [w for m, w in (("psutil", "the system values (python3-psutil)"), ("smbus2", "I2C displays (python3-smbus2)"),
                          ("luma.oled", "OLEDs (luma.oled, see lcd-editor/README.md)")) if not has(m)]
tft = [p for m, p in (("spidev", "python3-spidev"), ("lgpio", "python3-lgpio"), ("numpy", "python3-numpy")) if not has(m)]
if not has("lgpio"):
    without.append("the inputs INN0-INN7 (python3-lgpio)")
if tft:
    without.append("the TFT (%s)" % " ".join(tft))
print(", ".join(without))
'
LCD_PORT='
import sys, tomllib
try:
    with open(sys.argv[1], "rb") as f:
        print(int(tomllib.load(f).get("server", {}).get("port", 8000)))
except (OSError, ValueError) as e:
    print("%s can not be read: %s" % (sys.argv[1], e))
    sys.exit(1)
'
lcd=0
case $lcd_flag in
  on)  lcd=1 ;;
  '')  if systemctl is-enabled --quiet kjoreverk-lcd.service 2>/dev/null; then lcd=1; fi ;;
esac
lcd_missing='' lcd_python='' lcd_without='' lcd_port='' lcd_groups=''
if [ $lcd -eq 1 ]; then
  if [ ! -f "$LCD_DIR/app/__main__.py" ]; then lcd_missing="$LCD_DIR is missing: copy the whole project folder"
  elif systemctl is-active --quiet "$OLD_LCD_SERVICE" 2>/dev/null; then
    lcd_missing="the LCD editor's own service ${OLD_LCD_SERVICE%.service} runs, on the same port and displays: sudo systemctl disable --now ${OLD_LCD_SERVICE%.service}, then run this again with --lcd"
  else
    for py in "$LCD_DIR/.venv/bin/python3" /usr/bin/python3; do
      [ -x "$py" ] || continue
      # -I: bare Pythons egne mapper (ikke den vi står i), -B: ingen .pyc-filer
      if out=$("$py" -I -B -c "$LCD_CHECK" 2>&1); then lcd_python=$py; lcd_without=$out; break; fi
      lcd_missing=$out
    done
    if [ -n "$lcd_python" ]; then
      lcd_missing=''
      lcd_port=$("$lcd_python" -I -B -c "$LCD_PORT" "$LCD_DIR/config.toml" 2>&1) || { lcd_missing=$lcd_port; lcd_python=''; }
    elif [ -z "$lcd_missing" ]; then lcd_missing="python3 isn't installed"
    fi
  fi
  [ -z "$lcd_missing" ] || lcd=0
  # I2C, SPI og GPIO-ene: gruppene som finnes (Raspberry Pi OS har dem)
  for g in i2c spi gpio; do getent group "$g" >/dev/null 2>&1 && lcd_groups="$lcd_groups $g"; done
  lcd_groups=${lcd_groups# }
fi

# ---------------------------------------------------------------- oversikten
step "Setting up this Pi"
say "  project      $PROJECT"
say "  services     run as $user, with Node $NODE_VERSION ($NODE)"
say "  vehicle      $vehicle"
say "  PLC          $plc"
say "  diagnostics  https://${plc%:*}, the PLC's web server, when the PLC reports a fault"
if [ $recorder -eq 1 ]; then say "  recorder     $server, $([ -n "$token" ] && echo 'key set' || echo 'NO KEY YET: the server will refuse the data')"
else say "  recorder     not set up"
fi
say "  time server  $ntp"
say "  logs         $([ $disk_logs -eq 1 ] && echo 'on the SD card' || echo 'in RAM (gone after a restart)')"
if [ $bluetooth -eq 1 ]; then say "  Bluetooth    \"$bt_name\", HMI at http://$bt_address:$HUB_PORT, PIN $bt_pin_note"
elif [ -n "$bt_missing" ]; then say "  Bluetooth    NOT SET UP: $bt_missing"
else say "  Bluetooth    off (--no-bluetooth)"
fi
if [ $lcd -eq 1 ]; then
  say "  LCD editor   port $lcd_port, the displays in lcd-editor/config.toml, with $lcd_python"
  [ -z "$lcd_without" ] || say "               without $lcd_without"
elif [ -n "$lcd_missing" ]; then say "  LCD editor   NOT SET UP: $lcd_missing"
else say "  LCD editor   off (--lcd sets it up)"
fi
[ "$PROJECT" = "$RECOMMENDED" ] || say "  note         the recommended place for the project folder is $RECOMMENDED"
if LC_ALL=C grep -q '[^ -~]' <<<"$PROJECT"; then warn "the path $PROJECT has letters outside a-z (like ø); $RECOMMENDED is safer"; fi
if [ -n "$cur_vehicle" ] && [ "$cur_vehicle" != "$vehicle" ]; then warn "the vehicle's name changes from $cur_vehicle to $vehicle"; fi

if [ $interactive -eq 1 ]; then
  read -r -p "Continue? [Y/n] " answer || die "no answer"
  case $answer in ''|[Yy]*) ;; *) say "Nothing was changed."; exit 1 ;; esac
fi

# put <fil> <modus>: innholdet kommer på stdin. Skriver bare når innholdet er nytt, og setter
# CHANGED=1 når filen ble skrevet.
CHANGED=0
put() {
  local file=$1 mode=$2 tmp
  tmp=$(mktemp "$file.XXXXXX")
  cat > "$tmp"
  if [ -f "$file" ] && cmp -s "$tmp" "$file"; then
    rm -f "$tmp"; CHANGED=0; say "  unchanged  $file"
  else
    chmod "$mode" "$tmp"; mv -f "$tmp" "$file"; CHANGED=1; say "  wrote      $file"
  fi
}

# ---------------------------------------------------------------- kjøreverkets navn og instansene
step "The vehicle's name and the services"
mkdir -p "$ETC/instances"
printf '%s\n' "$vehicle" | put "$ETC/vehicle" 644

env_file() {   # env_file <instans> <SCRIPT_ARGS>
  printf '# Written by install.sh, which rewrites it each time it runs.\nSCRIPT_ARGS=%s\n' "$2" | put "$ETC/instances/$1.env" 644
}
env_file hub "hmi-core/hub.js"
env_file tcplink-adapter "hmi-core/adapters/tcplink-adapter.js --plc=$plc"
env_file plcdiag-adapter "hmi-core/adapters/plcdiag-adapter.js --plc=$plc"
env_file recorder "hmi-core/recorder.js"

put "$UNIT" 644 <<EOF
# Written by $PROJECT/install.sh, which rewrites it each time it runs.
# One instance per program; its command line is in /etc/kjoreverk/instances/<name>.env.
# A change for one instance only: sudo systemctl edit kjoreverk@<name>.service
[Unit]
Description=Kjoreverk service: %i
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=$ETC/instances/%i.env
ExecStart=$NODE \$SCRIPT_ARGS
WorkingDirectory=$PROJECT
User=$user
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

# Huben lagrer prosjektet i hmi-core/config, så brukeren må eie mappen.
chown -R "$user:$group" "$PROJECT" || die "$PROJECT can't be given to $user (on a USB stick? copy the folder to $RECOMMENDED first)"
say "  owner      $PROJECT belongs to $user"

# ---------------------------------------------------------------- recorderen
if [ $recorder -eq 1 ]; then
  step "The recorder"
  if [ ! -e "$RECORDER_JSON" ] && [ -f "$OLD_RECORDER_JSON" ]; then
    mv "$OLD_RECORDER_JSON" "$RECORDER_JSON"
    say "  moved      $OLD_RECORDER_JSON to $RECORDER_JSON"
  fi
  # Bare server og token endres; andre innstillinger i filen (queueMB ...) blir stående.
  settings=$("$NODE" -e '
    const fs = require("fs");
    const [file, server, token] = process.argv.slice(1);
    let s = {};
    if (fs.existsSync(file)) s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    s.server = server;
    if (token) s.token = token;
    process.stdout.write(JSON.stringify(s, null, 2));
  ' "$RECORDER_JSON" "$server" "$token")
  printf '%s\n' "$settings" | put "$RECORDER_JSON" 640
  chown "root:$group" "$RECORDER_JSON"
fi

# ---------------------------------------------------------------- klokka
step "The clock"
if systemctl is-active --quiet chrony 2>/dev/null || systemctl is-active --quiet chronyd 2>/dev/null; then
  if [ -d /etc/chrony/conf.d ] && grep -qs '^confdir /etc/chrony/conf.d' /etc/chrony/chrony.conf; then
    printf '%s\nserver %s iburst\n' "$CHRONY_MARK" "$ntp" | put /etc/chrony/conf.d/kjoreverk.conf 644
  else
    # linjen install.sh la til sist, byttes ut
    conf=$(sed "/^$CHRONY_MARK\$/{N;d;}" /etc/chrony/chrony.conf)
    printf '%s\n%s\nserver %s iburst\n' "$conf" "$CHRONY_MARK" "$ntp" | put /etc/chrony/chrony.conf 644
  fi
  if [ $CHANGED -eq 1 ]; then systemctl restart chrony 2>/dev/null || systemctl restart chronyd || warn "chrony didn't restart"; fi
  say "  chrony asks $ntp"
elif systemctl cat systemd-timesyncd.service >/dev/null 2>&1; then
  mkdir -p "$(dirname "$TIMESYNCD_CONF")"
  printf '# Written by install.sh: the time server on the network.\n[Time]\nNTP=%s\n' "$ntp" | put "$TIMESYNCD_CONF" 644
  timedatectl set-ntp true || warn "timedatectl set-ntp true failed"
  if [ $CHANGED -eq 1 ]; then systemctl restart systemd-timesyncd || warn "systemd-timesyncd didn't restart"; fi
  say "  systemd-timesyncd asks $ntp"
else
  warn "neither systemd-timesyncd nor chrony is here, so the clock isn't set from $ntp; the recorder waits for a synchronized clock"
fi

# ---------------------------------------------------------------- loggene
step "The logs"
if [ $disk_logs -eq 0 ]; then
  mkdir -p "$(dirname "$JOURNALD_CONF")"
  put "$JOURNALD_CONF" 644 <<EOF
# Written by install.sh: the logs stay in RAM, so journald doesn't write to the SD card.
# They are gone after a restart. install.sh --disk-logs removes this file.
[Journal]
Storage=volatile
EOF
  [ $CHANGED -eq 0 ] || systemctl restart systemd-journald || warn "systemd-journald didn't restart"
  say "  journald keeps the logs in RAM"
else
  if [ -f "$JOURNALD_CONF" ]; then
    rm -f "$JOURNALD_CONF"; say "  removed    $JOURNALD_CONF"
    systemctl restart systemd-journald || warn "systemd-journald didn't restart"
  fi
  say "  journald keeps the logs as the system is set up (on the SD card if /var/log/journal exists)"
fi

# ---------------------------------------------------------------- Bluetooth
# bt.json: PIN-koden og om Bluetooth er på. Bare de to endres; "name" og "address" blir stående.
write_bt_json() {   # write_bt_json <true|false>
  local settings
  settings=$("$NODE" -e '
    const fs = require("fs");
    const [file, pin, enabled] = process.argv.slice(1);
    let s = {};
    if (fs.existsSync(file)) s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (pin) s.pin = pin;
    s.enabled = enabled === "true";
    process.stdout.write(JSON.stringify(s, null, 2));
  ' "$BT_JSON" "$bt_pin" "$1")
  printf '%s\n' "$settings" | put "$BT_JSON" 600
}

# dhcpcd skal la Bluetooth-nettet være (pan0 og bnep*): navnene legges til i den første
# denyinterfaces-linjen, eller i en ny linje før den første interface- eller ssid-blokken.
dhcpcd_deny() {
  awk -v names='pan0 bnep*' '
    BEGIN { n = split(names, want, " "); note = "# install.sh: the Bluetooth network for the HMI (kjoreverk-bt) is not for dhcpcd" }
    function add(line,   i, j, k, f, have) {
      k = split(line, f, /[ \t]+/)
      for (i = 1; i <= n; i++) {
        have = 0
        for (j = 1; j <= k; j++) if (f[j] == want[i]) have = 1
        if (!have) line = line " " want[i]
      }
      return line
    }
    !done && /^[ \t]*denyinterfaces[ \t]/ { print add($0); done = 1; next }
    !done && tolower($1) ~ /^(interface|ssid|profile)$/ { print note; print "denyinterfaces " names; print ""; done = 1 }
    { print }
    END { if (!done) { print ""; print note; print "denyinterfaces " names } }
  ' "$DHCPCD_CONF"
}

dhcpcd_restart=0
if [ $bluetooth -eq 1 ]; then
  step "Bluetooth"
  write_bt_json true
  mkdir -p "$BT_LIB"
  for f in bt-hmi.py bt-dhcp.py btnet.py; do
    mode=644; [ "$f" = btnet.py ] || mode=755
    put "$BT_LIB/$f" $mode < "$PROJECT/bluetooth/$f"
  done

  put "$BT_UNIT" 644 <<EOF
# Written by $PROJECT/install.sh, which rewrites it each time it runs.
# The HMI over Bluetooth (PAN/NAP on pan0): $BT_LIB/bt-hmi.py, the PIN in $BT_JSON.
[Unit]
Description=Kjoreverk: HMI over Bluetooth (PAN/NAP on pan0)
Requires=bluetooth.service
After=bluetooth.service

[Service]
Type=simple
# the bridge the tablets join; nothing that comes in here is forwarded (only the HMI on this Pi)
ExecStartPre=-/sbin/ip link add pan0 type bridge
ExecStartPre=/sbin/sysctl -q -w net.ipv4.conf.pan0.forwarding=0 net.ipv6.conf.pan0.disable_ipv6=1
ExecStartPre=/sbin/ip link set pan0 up
ExecStart=/usr/bin/python3 $BT_LIB/bt-hmi.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  put "$BT_DHCP_UNIT" 644 <<EOF
# Written by $PROJECT/install.sh, which rewrites it each time it runs.
[Unit]
Description=Kjoreverk: DHCP for tablets on the Bluetooth network (pan0)
BindsTo=kjoreverk-bt.service
After=kjoreverk-bt.service

[Service]
ExecStart=/usr/bin/python3 $BT_LIB/bt-dhcp.py
Restart=always
RestartSec=5

[Install]
WantedBy=kjoreverk-bt.service
EOF

  # dhcpcd tar ellers pan0 og bnep* som sine; den startes på nytt helt til slutt (wifi blir borte noen sekunder)
  if [ -f "$DHCPCD_CONF" ]; then
    mode=$(stat -c %a "$DHCPCD_CONF"); grp=$(stat -c %G "$DHCPCD_CONF")
    dhcpcd_deny | put "$DHCPCD_CONF" "$mode"
    if [ $CHANGED -eq 1 ]; then chgrp "$grp" "$DHCPCD_CONF"; dhcpcd_restart=1; fi
  fi
  # dhcp-helper (reléet for PLS-siden) skal ikke sende nettbrettenes DHCP-spørsmål ut i tunnelnettet
  if [ -f "$DHCP_HELPER_DEFAULT" ] && grep -q '^DHCPHELPER_OPTS="[^"]*"$' "$DHCP_HELPER_DEFAULT"; then
    sed '/^DHCPHELPER_OPTS=/{/-e pan0/!s/"$/ -e pan0"/}' "$DHCP_HELPER_DEFAULT" | put "$DHCP_HELPER_DEFAULT" 644
    [ $CHANGED -eq 0 ] || systemctl restart dhcp-helper || warn "dhcp-helper didn't restart"
  fi
  say "  tablets pair with \"$bt_name\" and open http://$bt_address:$HUB_PORT"
else
  step "Bluetooth"
  for u in kjoreverk-bt.service kjoreverk-bt-dhcp.service; do
    if systemctl is-enabled --quiet "$u" 2>/dev/null || systemctl is-active --quiet "$u" 2>/dev/null; then
      systemctl disable --now --quiet "$u" || true
      say "  stopped    $u"
    fi
  done
  if [ -n "$bt_missing" ]; then
    warn "the HMI isn't set up on Bluetooth: $bt_missing"
  else
    write_bt_json false   # så det er av også neste gang skriptet kjøres
    bluetoothctl discoverable off >/dev/null 2>&1 || true
    ip link del pan0 2>/dev/null || true
    say "  the HMI isn't on Bluetooth: install.sh --bluetooth turns it on again"
  fi
fi

# ---------------------------------------------------------------- LCD-editoren
if [ $lcd -eq 1 ]; then
  step "The LCD editor"
  # deploy lagrer hva displayene viser i state/, når noen trykker på knappen; ellers skrives ingenting
  install -d -o "$user" -g "$group" "$LCD_DIR/state"
  {
    cat <<EOF
# Written by $PROJECT/install.sh, which rewrites it each time it runs (install.sh --no-lcd turns it off).
# The LCD editor ($LCD_DIR): screens for the displays on this Pi, with the hub's tags.
# The displays and the port are in $LCD_DIR/config.toml.
[Unit]
Description=Kjoreverk: the LCD editor and the displays (lcd-editor)
After=network.target kjoreverk@hub.service
StartLimitIntervalSec=0

[Service]
Type=simple
# -B: no .pyc files, so nothing is written to the SD card
ExecStart=$lcd_python -B -m app
WorkingDirectory=$LCD_DIR
User=$user
EOF
    [ -z "$lcd_groups" ] || printf 'SupplementaryGroups=%s\n' "$lcd_groups"
    cat <<EOF
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  } | put "$LCD_UNIT" 644
  say "  the editor on port $lcd_port drives the displays in lcd-editor/config.toml"
elif systemctl is-enabled --quiet kjoreverk-lcd.service 2>/dev/null || systemctl is-active --quiet kjoreverk-lcd.service 2>/dev/null; then
  step "The LCD editor"
  systemctl disable --now --quiet kjoreverk-lcd.service || true
  say "  stopped    kjoreverk-lcd.service"
fi
[ -z "$lcd_missing" ] || warn "the LCD editor isn't set up: $lcd_missing"

# ---------------------------------------------------------------- tjenestene
step "Starting the services"
# En instans fra før med et program som ikke lenger finnes (binary-adapter), stoppes.
for f in "$ETC"/instances/*.env; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .env)
  case $name in hub|tcplink-adapter|plcdiag-adapter|recorder) continue ;; esac
  script=$(awk -F= '$1 == "SCRIPT_ARGS" { sub(/^SCRIPT_ARGS=/, ""); gsub(/["'\'']/, ""); split($0, a, " "); print a[1]; exit }' "$f")
  [ -n "$script" ] || continue
  case $script in /*) path=$script ;; *) path=$PROJECT/$script ;; esac
  if [ ! -e "$path" ]; then
    systemctl disable --now --quiet "kjoreverk@$name.service" 2>/dev/null || true
    say "  stopped    kjoreverk@$name: $script isn't in the project any more ($f is left as it was)"
  fi
done

units=(kjoreverk@hub.service kjoreverk@tcplink-adapter.service kjoreverk@plcdiag-adapter.service)
if [ $recorder -eq 1 ]; then
  units+=(kjoreverk@recorder.service)
elif systemctl is-enabled --quiet kjoreverk@recorder.service 2>/dev/null || systemctl is-active --quiet kjoreverk@recorder.service 2>/dev/null; then
  systemctl disable --now --quiet kjoreverk@recorder.service || true
  say "  stopped    kjoreverk@recorder.service"
fi
[ $bluetooth -eq 0 ] || units+=(kjoreverk-bt.service kjoreverk-bt-dhcp.service)
[ $lcd -eq 0 ] || units+=(kjoreverk-lcd.service)
systemctl daemon-reload
systemctl enable --quiet "${units[@]}"
systemctl restart "${units[@]}"

# ---------------------------------------------------------------- kontrollen
sleep 3
ok=1
for u in "${units[@]}"; do
  if systemctl is-active --quiet "$u"; then say "  running    $u"
  else say "  NOT RUNNING  $u   see: journalctl -u $u -n 30 --no-pager"; ok=0
  fi
done
hub_ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if "$NODE" -e 'require("http").get("http://127.0.0.1:" + process.argv[1] + "/", r => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1))' "$HUB_PORT"; then
    hub_ok=1; break
  fi
  sleep 1
done
if [ $hub_ok -eq 1 ]; then say "  the hub answers on port $HUB_PORT"
else say "  the hub doesn't answer on port $HUB_PORT   see: journalctl -u kjoreverk@hub.service -n 30 --no-pager"; ok=0
fi
if [ $lcd -eq 1 ]; then
  # editoren svarer på /api/hub med om den har fått taggene fra huben (den prøver hvert 3. sekund)
  lcd_state=''
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    lcd_state=$("$NODE" -e '
      require("http").get("http://127.0.0.1:" + process.argv[1] + "/api/hub", r => {
        let b = ""; r.on("data", d => { b += d; });
        r.on("end", () => { try { const h = JSON.parse(b) || {}; process.stdout.write(h.connected ? "connected to the hub (" + h.tags + " tags)" : "not connected to the hub: " + (h.error || "no hub in config.toml")); } catch (e) { process.exit(1); } });
      }).on("error", () => process.exit(1))' "$lcd_port") || lcd_state=''
    case $lcd_state in connected*) break ;; esac
    sleep 1
  done
  if [ -n "$lcd_state" ]; then say "  the LCD editor answers on port $lcd_port, $lcd_state"
  else say "  the LCD editor doesn't answer on port $lcd_port   see: journalctl -u kjoreverk-lcd -n 30 --no-pager"; ok=0
  fi
fi
synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)
case $synced in
  yes) say "  the clock is synchronized" ;;
  no)  say "  the clock isn't synchronized yet: timedatectl timesync-status (the recorder waits for it)" ;;
esac

ip=$(hostname -I 2>/dev/null | awk '{ print $1 }')
step "$([ $ok -eq 1 ] && echo "Done: $vehicle is running" || echo "Set up, but something isn't running (above)")"
say "  HMI          http://${ip:-<this-pi>}:$HUB_PORT"
if [ $bluetooth -eq 1 ]; then
  say "  Bluetooth    pair with \"$bt_name\", PIN $bt_pin, turn on Internet access, then http://$bt_address:$HUB_PORT"
fi
[ $lcd -eq 0 ] || say "  LCD editor   http://${ip:-<this-pi>}:$lcd_port"
say "  logs         journalctl -u 'kjoreverk@*' -f"
say "  again        sudo bash $PROJECT/install.sh   (after an update, or to change something)"
# Etter alt annet, så et wifi-brudd ikke stopper skriptet midt i (over ssh)
if [ $dhcpcd_restart -eq 1 ]; then
  if systemd-run --quiet --collect --on-active=5 --unit=kjoreverk-dhcpcd-restart \
       systemctl restart --job-mode=ignore-dependencies dhcpcd.service; then
    say "  note         dhcpcd restarts in 5 s to leave the Bluetooth network alone: wifi is gone for a few seconds"
  else
    warn "dhcpcd wasn't restarted: it leaves the Bluetooth network alone after the Pi's next restart"
  fi
fi
[ $ok -eq 1 ]
