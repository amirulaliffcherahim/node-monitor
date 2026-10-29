#!/bin/sh
# node-monitor Linux installer. Run as root:
#   curl -fsSL http://HUB:8787/install.sh | sudo sh -s -- --url http://HUB:8787 --token nmn_xxx
#   ... | sudo sh -s -- --uninstall
set -eu
URL=""; TOKEN=""; UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

BIN=/usr/local/bin/nodemon-agent
CONF=/etc/nodemon-agent.conf
CRON=/etc/cron.d/nodemon-agent

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

if [ "$UNINSTALL" = 1 ]; then
  rm -f "$BIN" "$CONF" "$CRON"
  echo "nodemon-agent removed."
  exit 0
fi

[ -n "$URL" ] && [ -n "$TOKEN" ] || { echo "need --url and --token" >&2; exit 2; }
case "$TOKEN" in nmn_*) ;; *) echo "token must start with nmn_" >&2; exit 2 ;; esac
for c in curl awk bash; do command -v "$c" >/dev/null 2>&1 || { echo "missing dependency: $c" >&2; exit 1; }; done
[ -d /etc/cron.d ] || { echo "/etc/cron.d missing: install cron (apt install cron / dnf install cronie)" >&2; exit 1; }

URL="${URL%/}"
curl -fsSL "$URL/agent/nodemon-agent.sh" -o "$BIN.tmp"
chmod 0755 "$BIN.tmp" && mv "$BIN.tmp" "$BIN"

umask 077
printf 'NODEMON_URL="%s"\nNODEMON_TOKEN="%s"\nINTERVAL=5\nSAMPLES=12\n' "$URL" "$TOKEN" > "$CONF"
chmod 0600 "$CONF"

umask 022
printf '# node-monitor agent: one run per minute, 12 pushes x 5s\n* * * * * root %s >/dev/null 2>&1\n' "$BIN" > "$CRON"
chmod 0644 "$CRON"

if "$BIN" --once; then
  echo "nodemon-agent installed. Cron pushes every 5s starting next minute."
else
  echo "installed, but the test push failed. Check URL/token and that the hub is reachable." >&2
  exit 1
fi
