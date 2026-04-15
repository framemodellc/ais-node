# Raspberry Pi Setup

This directory contains everything you need to turn a Raspberry Pi + RTL-SDR dongle into a live AIS receiver that feeds the `ais-node` HUD.

## What's in here

| File | Purpose |
|------|---------|
| `setup.sh` | One-command installer: installs rtl-sdr, builds AIS-catcher, registers the systemd service |
| `ais-forwarder-loop.sh` | The daemon script: detects the dongle, runs `rtl_ais`, falls back to AIS-catcher |
| `ais-forwarder.service` | systemd unit file for auto-start on boot |

## Prerequisites

- Raspberry Pi 4B (2GB+ RAM recommended) running **Raspberry Pi OS / Debian**
- RTL-SDR dongle (Realtek RTL2832U, USB ID `0bda:2838`) plugged in
- AIS antenna connected (162 MHz dual-channel)
- SSH access to the Pi
- Internet access on the Pi (to install packages and forward to AISHub)

## Quick setup (one command)

SSH into your Pi, then:

```bash
# Clone the repo (or copy just the raspberry-pi/ folder)
git clone https://github.com/yourusername/ais-node.git
cd ais-node/raspberry-pi

# Run the installer as root
sudo bash setup.sh
```

The script will:
1. Install `rtl-sdr` and dependencies via apt
2. Blacklist conflicting DVB kernel modules
3. Build [AIS-catcher](https://github.com/jvde-github/AIS-catcher) from source (~3 min on Pi 4)
4. Install and enable the `ais-forwarder` systemd service
5. Print the live log so you can confirm signals are being received

## Manual setup (if you prefer)

```bash
# 1. Install rtl-sdr
sudo apt-get update && sudo apt-get install -y rtl-sdr

# 2. Copy script and service
sudo install -m 0755 ais-forwarder-loop.sh /usr/local/bin/
sudo install -m 0644 ais-forwarder.service /etc/systemd/system/

# 3. Enable and start
sudo systemctl daemon-reload
sudo systemctl enable --now ais-forwarder
```

## Verify it's working

```bash
# Check service status
sudo systemctl status ais-forwarder

# Watch live log
sudo journalctl -u ais-forwarder -f

# Or tail the log file directly
tail -f /var/log/ais-forwarder.log
```

You should see NMEA sentences like:
```
!AIVDM,1,1,,B,15M67N0000G?Uf6E?...
```

If you see `rtl_ais exited rc=1` in a loop, the dongle isn't being picked up. Try unplugging and replugging, or run `lsusb | grep 0bda:2838` to confirm it's detected.

## AISHub forwarding (optional but recommended)

The forwarder sends decoded AIS data to [AISHub](https://www.aishub.net/) by default (`data.aishub.net:3919`). This contributes your vessel data to the global AIS network.

To change the target, edit the `TARGET_HOST` / `TARGET_PORT` variables at the top of `ais-forwarder-loop.sh`, or override via the systemd environment:

```bash
sudo systemctl edit ais-forwarder
# Add:
# [Service]
# Environment=AIS_TARGET_HOST=your.server.com
# Environment=AIS_TARGET_PORT=12345
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `lsusb` doesn't show `0bda:2838` | Try a different USB port; check the dongle is fully seated |
| `rtl_ais: usb_open error -3` | Reboot. DVB modules may be loaded; the blacklist file handles this on next boot |
| No NMEA sentences in the log | Antenna may not be connected or on wrong frequency (AIS is 161.975 / 162.025 MHz) |
| `permission denied` on `/var/log/ais-forwarder.log` | Service runs as root; if you ran the script as non-root, re-run with `sudo` |
| Build fails for AIS-catcher | Install `cmake`, `build-essential`, `librtlsdr-dev` manually, then re-run `setup.sh` |
