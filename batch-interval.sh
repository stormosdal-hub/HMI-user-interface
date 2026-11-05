#!/bin/bash
# batch-interval.sh - hvor ofte recorderen sender en batch til den sentrale serveren (sendSeconds).
#
#   bash /opt/kjoreverk/batch-interval.sh             viser intervallet
#   sudo bash /opt/kjoreverk/batch-interval.sh 60     en batch hvert 60. sekund, med en gang
#   sudo bash /opt/kjoreverk/batch-interval.sh 10     tilbake til standard
#
# Skriver sendSeconds i /etc/kjoreverk/recorder.json. Resten av filen blir stående, og install.sh
# lar sendSeconds stå når den kjøres på nytt. Kjører recorderen, får den SIGHUP og leser intervallet
# på nytt uten å starte på nytt: det som venter i køen, blir stående, og nedtellingen på
# skjermbildet Opplasting følger med. Se recorderen i hmi-core/README.md.

set -euo pipefail

RECORDER_JSON=/etc/kjoreverk/recorder.json
SERVICE=kjoreverk@recorder.service
DEFAULT=10            # som recorder.js
MAX=3600

usage() {
  cat <<EOF
How often the recorder sends a batch to the central server (sendSeconds in $RECORDER_JSON):

  bash $0            shows it
  sudo bash $0 60    a batch every 60 s, from now on
  sudo bash $0 $DEFAULT    back to the default

Whole seconds, 1 to $MAX. A running recorder takes it at once, without a restart: what is
waiting in its queue stays there.
EOF
}

say() { printf '%s\n' "$*"; }
die() { printf 'batch-interval.sh: %s\n' "$*" >&2; exit 1; }

[ $# -le 1 ] || die "give one number of seconds (see --help)"
arg=${1:-}
case $arg in -h|--help) usage; exit 0 ;; esac

NODE=$(command -v node || true)
[ -n "$NODE" ] || die "Node.js isn't installed (or not in /usr/local/bin or /usr/bin)"
[ -f "$RECORDER_JSON" ] || die "the recorder isn't set up: $RECORDER_JSON is missing (install.sh --server sets it up)"
[ -r "$RECORDER_JSON" ] || die "$RECORDER_JSON can only be read by root and the service's user: sudo bash $0 $arg"

# sendSeconds i filen, eller '' når den ikke står der
cur=$("$NODE" -e '
  const fs = require("fs");
  let s;
  try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^﻿/, "")); }
  catch (e) { console.error(process.argv[1] + ": " + e.message); process.exit(1); }
  if (s && s.sendSeconds !== undefined) process.stdout.write(String(s.sendSeconds));
' "$RECORDER_JSON") || die "$RECORDER_JSON can't be read"

if [ -z "$arg" ]; then
  if [ -n "$cur" ]; then say "a batch every $cur s (sendSeconds in $RECORDER_JSON)"
  else say "a batch every $DEFAULT s (the default: sendSeconds isn't in $RECORDER_JSON)"; fi
  exit 0
fi

[[ $arg =~ ^[0-9]{1,5}$ ]] && [ $((10#$arg)) -ge 1 ] && [ $((10#$arg)) -le $MAX ] ||
  die "\"$arg\": give whole seconds from 1 to $MAX, e.g. 60"
n=$((10#$arg))
[ "$(id -u)" -eq 0 ] || die "run it as root: sudo bash $0 $n"

if [ "$cur" = "$n" ]; then
  say "unchanged  sendSeconds is $n in $RECORDER_JSON"
else
  # en ny fil ved siden av, med samme eier og rettigheter (nøkkelen står i den), og så bytte
  tmp=$(mktemp "$RECORDER_JSON.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  "$NODE" -e '
    const fs = require("fs");
    const [file, n] = process.argv.slice(1);
    const s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    s.sendSeconds = Number(n);
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
  ' "$RECORDER_JSON" "$n" > "$tmp"
  chmod --reference="$RECORDER_JSON" "$tmp"
  chown --reference="$RECORDER_JSON" "$tmp"
  mv -f "$tmp" "$RECORDER_JSON"
  trap - EXIT
  say "wrote      sendSeconds $n in $RECORDER_JSON (it was ${cur:-$DEFAULT, the default})"
fi

if systemctl is-active --quiet "$SERVICE"; then
  pid=$(systemctl show -p MainPID --value "$SERVICE")
  [ -n "$pid" ] && [ "$pid" != 0 ] || die "$SERVICE runs, but systemd doesn't give its process"
  kill -HUP "$pid"
  say "the recorder sends a batch every $n s from now on (the countdown on Opplasting follows)"
else
  say "the recorder isn't running: it takes $n s from the file when it starts"
fi
