#!/usr/bin/env bash
# node-monitor Linux agent. Cron runs this once a minute; each run pushes
# SAMPLES metrics, one every INTERVAL seconds, then exits.
# Config: /etc/nodemon-agent.conf  (NODEMON_URL, NODEMON_TOKEN, optional INTERVAL, SAMPLES)
set -u
AGENT_VERSION="1.0.0"
CONF="${NODEMON_CONF:-/etc/nodemon-agent.conf}"
[ -r "$CONF" ] && . "$CONF"
: "${NODEMON_URL:?NODEMON_URL not set (see $CONF)}"
: "${NODEMON_TOKEN:?NODEMON_TOKEN not set (see $CONF)}"
INTERVAL="${INTERVAL:-5}"
SAMPLES="${SAMPLES:-12}"
ONCE=0
[ "${1:-}" = "--once" ] && { ONCE=1; SAMPLES=1; }

# One run at a time. If the previous minute's run still holds the lock, skip.
LOCK="${NODEMON_LOCK:-/run/nodemon-agent.lock}"
[ -w "$(dirname "$LOCK")" ] || LOCK="/tmp/nodemon-agent.$(id -u).lock"
exec 9>"$LOCK"
command -v flock >/dev/null 2>&1 && { flock -n 9 || exit 0; }

cpu_read() { # prints "busy total" from aggregate cpu line
  awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++) t+=$i; print t-idle, t; exit}' /proc/stat
}
net_read() { # prints "rx tx" bytes over physical-ish interfaces
  [ -r /proc/net/dev ] || { echo "0 0"; return; }
  awk -F'[: ]+' 'NR>2 { i=$2; if (i ~ /^(lo|docker|veth|br-|virbr|tailscale|tun|wg|cni|flannel|kube)/) next; rx+=$3; tx+=$11 }
                 END { printf "%d %d\n", rx, tx }' /proc/net/dev
}
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

HOSTNAME_V="$(json_str "$(hostname 2>/dev/null || cat /etc/hostname)")"
OS_V="$(. /etc/os-release 2>/dev/null; json_str "${PRETTY_NAME:-Linux}")"
KERNEL_V="$(json_str "$(uname -r)")"

read -r PB PT < <(cpu_read)
read -r PRX PTX < <(net_read)
PNOW=$(date +%s%N)
sleep 1   # first CPU/net delta window

for ((n = 1; n <= SAMPLES; n++)); do
  START=$(date +%s)
  read -r B T < <(cpu_read)
  read -r RX TX < <(net_read)
  NOW=$(date +%s%N)
  DT_MS=$(( (NOW - PNOW) / 1000000 )); [ "$DT_MS" -le 0 ] && DT_MS=1
  CPU=$(awk -v b=$((B - PB)) -v t=$((T - PT)) 'BEGIN { printf "%.1f", (t > 0 ? 100 * b / t : 0) }')
  NET_RX=$(( (RX - PRX) * 1000 / DT_MS )); [ "$NET_RX" -lt 0 ] && NET_RX=0
  NET_TX=$(( (TX - PTX) * 1000 / DT_MS )); [ "$NET_TX" -lt 0 ] && NET_TX=0
  PB=$B; PT=$T; PRX=$RX; PTX=$TX; PNOW=$NOW

  read -r MEM_TOTAL MEM_USED SWAP_TOTAL SWAP_USED < <(awk '
    /^MemTotal:/{mt=$2} /^MemAvailable:/{ma=$2} /^MemFree:/{mf=$2} /^Buffers:/{bu=$2} /^Cached:/{ca=$2}
    /^SwapTotal:/{st=$2} /^SwapFree:/{sf=$2}
    END { if (ma == "") ma = mf + bu + ca; printf "%d %d %d %d\n", mt*1024, (mt-ma)*1024, st*1024, (st-sf)*1024 }' /proc/meminfo)
  LOAD1=$(cut -d' ' -f1 /proc/loadavg)
  PROCS=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)
  UPTIME=$(cut -d. -f1 /proc/uptime)

  DISKS=$(df -P -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x fuse.snapfuse -x ramfs 2>/dev/null |
    awk 'NR>1 && $1 ~ /^\// && !seen[$1]++ {
           m=$6; gsub(/\\/,"\\\\",m); gsub(/"/,"\\\"",m)
           printf "%s{\"mount\":\"%s\",\"total\":%d,\"used\":%d}", (c++ ? "," : ""), m, $2, $3 }')

  BODY=$(printf '{"agent_version":"%s","hostname":"%s","os":"%s","kernel":"%s","cpu":%s,"load1":%s,"mem_total":%s,"mem_used":%s,"swap_total":%s,"swap_used":%s,"net_rx":%s,"net_tx":%s,"procs":%s,"uptime":%s,"disks":[%s]}' \
    "$AGENT_VERSION" "$HOSTNAME_V" "$OS_V" "$KERNEL_V" "$CPU" "$LOAD1" "$MEM_TOTAL" "$MEM_USED" \
    "$SWAP_TOTAL" "$SWAP_USED" "$NET_RX" "$NET_TX" "$PROCS" "$UPTIME" "$DISKS")

  CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 -X POST "${NODEMON_URL%/}/api/ingest" \
    -H "Authorization: Bearer $NODEMON_TOKEN" -H 'Content-Type: application/json' --data "$BODY" 2>/dev/null)
  if [ "$ONCE" = 1 ]; then
    echo "push -> HTTP $CODE"; [ "$CODE" = 204 ]; exit $?
  fi
  [ "$CODE" = 401 ] && { logger -t nodemon-agent "hub rejected token (401), stopping run" 2>/dev/null; exit 1; }

  [ "$n" -lt "$SAMPLES" ] || break
  ELAPSED=$(( $(date +%s) - START ))
  sleep $(( INTERVAL - ELAPSED > 0 ? INTERVAL - ELAPSED : 1 ))
done
