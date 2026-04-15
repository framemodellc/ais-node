#!/usr/bin/env bash
set -u

TARGET_HOST="data.aishub.net"
TARGET_PORT="3919"
AIS_CATCHER_BIN="/home/ais/AIS-catcher/build-us/AIS-catcher"
LOG_FILE="/var/log/ais-forwarder.log"

mkdir -p /var/log
: > "$LOG_FILE"
chmod 644 "$LOG_FILE"

log() {
  local msg="$1"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$msg" | tee -a "$LOG_FILE"
  logger -t ais-forwarder "$msg"
}

ensure_usb_power() {
  for dev in /sys/bus/usb/devices/*; do
    [ -f "$dev/idVendor" ] || continue
    [ -f "$dev/idProduct" ] || continue
    vendor=$(cat "$dev/idVendor" 2>/dev/null || true)
    product=$(cat "$dev/idProduct" 2>/dev/null || true)
    if [ "$vendor" = "0bda" ] && [ "$product" = "2838" ]; then
      [ -w "$dev/power/control" ] && echo on > "$dev/power/control" || true
      [ -w "$dev/power/autosuspend" ] && echo -1 > "$dev/power/autosuspend" || true
    fi
  done
}

wait_for_rtl() {
  for _ in $(seq 1 20); do
    if lsusb | grep -qi '0bda:2838'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

while true; do
  ensure_usb_power

  if ! wait_for_rtl; then
    log "RTL dongle not present on USB bus; retrying in 5s"
    sleep 5
    continue
  fi

  modprobe -r dvb_usb_rtl28xxu rtl2832_sdr rtl2832 r820t rtl2830 2>/dev/null || true
  sleep 1

  log "Starting rtl_ais to ${TARGET_HOST}:${TARGET_PORT}"
  /usr/bin/rtl_ais -d 0 -h "$TARGET_HOST" -P "$TARGET_PORT" -n >> "$LOG_FILE" 2>&1
  rc=$?
  log "rtl_ais exited rc=${rc}"

  if [ -x "$AIS_CATCHER_BIN" ]; then
    log "Fallback: starting AIS-catcher to ${TARGET_HOST}:${TARGET_PORT}"
    "$AIS_CATCHER_BIN" -d:0 -u "$TARGET_HOST" "$TARGET_PORT" -n -v >> "$LOG_FILE" 2>&1
    rc=$?
    log "AIS-catcher exited rc=${rc}"
  fi

  sleep 3
done
