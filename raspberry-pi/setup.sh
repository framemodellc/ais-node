#!/usr/bin/env bash
# ais-node Raspberry Pi setup script
# Tested on: Debian GNU/Linux 13 (trixie) on Raspberry Pi 4B
# Run as root: sudo bash setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[setup]${NC} $*"; }
success() { echo -e "${GREEN}[done]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()     { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash setup.sh"

# ─── 1. System dependencies ──────────────────────────────────────────────────
info "Updating package lists..."
apt-get update -qq

info "Installing rtl-sdr and tools..."
apt-get install -y --no-install-recommends \
  rtl-sdr \
  librtlsdr-dev \
  usbutils \
  git \
  cmake \
  build-essential \
  libairspy-dev \
  libhackrf-dev \
  libsdrplay-dev 2>/dev/null || \
apt-get install -y --no-install-recommends \
  rtl-sdr \
  librtlsdr-dev \
  usbutils \
  git \
  cmake \
  build-essential

success "System packages installed."

# ─── 2. Blacklist DVB kernel modules (they grab the dongle before rtl-sdr) ──
BLACKLIST=/etc/modprobe.d/rtlsdr-blacklist.conf
if [ ! -f "$BLACKLIST" ]; then
  info "Blacklisting DVB kernel modules..."
  cat > "$BLACKLIST" <<'EOF'
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
blacklist rtl2832_sdr
blacklist r820t
EOF
  success "Kernel modules blacklisted (reboot may be required)."
else
  info "DVB blacklist already exists, skipping."
fi

# ─── 3. Build AIS-catcher (fallback decoder) ─────────────────────────────────
AIS_CATCHER_DEST="/home/ais/AIS-catcher"
if [ ! -x "${AIS_CATCHER_DEST}/build-us/AIS-catcher" ]; then
  info "Building AIS-catcher from source (this takes ~3 min on a Pi 4)..."
  mkdir -p "$(dirname "$AIS_CATCHER_DEST")"
  if [ ! -d "$AIS_CATCHER_DEST" ]; then
    git clone --depth 1 https://github.com/jvde-github/AIS-catcher.git "$AIS_CATCHER_DEST"
  fi
  mkdir -p "${AIS_CATCHER_DEST}/build-us"
  cd "${AIS_CATCHER_DEST}/build-us"
  cmake .. -DCMAKE_BUILD_TYPE=Release -DFAIRMODE=ON -DSDRPLAY=OFF 2>/dev/null || cmake .. -DCMAKE_BUILD_TYPE=Release
  make -j"$(nproc)"
  cd "$SCRIPT_DIR"
  success "AIS-catcher built at ${AIS_CATCHER_DEST}/build-us/AIS-catcher"
else
  info "AIS-catcher already built, skipping."
fi

# ─── 4. Install forwarder script ─────────────────────────────────────────────
info "Installing ais-forwarder-loop.sh to /usr/local/bin/..."
install -m 0755 "${SCRIPT_DIR}/ais-forwarder-loop.sh" /usr/local/bin/ais-forwarder-loop.sh
success "Script installed."

# ─── 5. Install systemd service ──────────────────────────────────────────────
info "Installing systemd service..."
install -m 0644 "${SCRIPT_DIR}/ais-forwarder.service" /etc/systemd/system/ais-forwarder.service
systemctl daemon-reload
systemctl enable ais-forwarder
systemctl restart ais-forwarder
success "Service installed and started."

# ─── 6. Verify ───────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  AIS forwarder installed successfully!${NC}"
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo ""
systemctl status ais-forwarder --no-pager -l || true
echo ""
info "Tailing live log (Ctrl-C to exit)..."
sleep 2
tail -n 20 /var/log/ais-forwarder.log || journalctl -u ais-forwarder -n 20 --no-pager
echo ""
echo -e "${YELLOW}Next step:${NC} Point ais-node at this Pi:"
echo "  SSH_HOST=$(hostname -I | awk '{print $1}')"
echo "  SSH_USER=ais"
