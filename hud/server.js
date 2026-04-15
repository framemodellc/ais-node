'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const path      = require('path');

// ─── SSH config (set values in .env — see .env.example) ─────────────────────
const SSH = {
  host:              process.env.SSH_HOST || '192.168.86.2',
  port:              parseInt(process.env.SSH_PORT || '22'),
  username:          process.env.SSH_USER || 'ais',
  password:          process.env.SSH_PASS,
  readyTimeout:      15000,
  keepaliveInterval: 10000,
};

const LOG_PATH = process.env.LOG_PATH || '/var/log/ais-forwarder.log';
const PORT     = process.env.PORT || 3000;

// ─── Antenna location (optional) ────────────────────────────────────────────
// Set these if you know the exact position of your AIS antenna.
// If null, the HUD will estimate location from received vessel centroids.
const ANTENNA_LAT = null;
const ANTENNA_LON = null;

// ─── HTTP + WebSocket setup ──────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── State ───────────────────────────────────────────────────────────────────
const clients      = new Set();
let   connStatus   = 'OFFLINE';
let   totalMsgs    = 0;
let   rxRate       = '0.000';
const multipartBuf = new Map();
let   antennaFromIP  = null;   // { lat, lon, city, country } from IP geolocation
let   msgThisSecond  = 0;      // per-second message counter for chart
const seenMMSI     = new Set(); // unique vessel counter (this session)

// Broadcast per-second rate tick for the live chart
setInterval(() => {
  broadcast({ type: 'rate_tick', rate: msgThisSecond });
  msgThisSecond = 0;
}, 1000);

function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(str);
  }
}

// ─── AIS 6-bit payload decoder ───────────────────────────────────────────────
function decodePayload(payload, fillBits = 0) {
  const bits = [];
  for (const ch of payload) {
    let v = ch.charCodeAt(0) - 48;
    if (v > 39) v -= 8;
    for (let i = 5; i >= 0; i--) bits.push((v >> i) & 1);
  }

  const totalBits = bits.length - fillBits;
  const binaryStr = bits.slice(0, totalBits).join('');

  // Valid position: within range AND not Null Island (0°N 0°E) —
  // transponders without GPS lock broadcast (0,0) by default.
  const validPos = (lat, lon) =>
    Math.abs(lat) < 90.5 && Math.abs(lon) < 180.5 &&
    !(Math.abs(lat) < 0.5 && Math.abs(lon) < 0.5);

  const uint = (s, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | (bits[s + i] ?? 0);
    return v;
  };
  const sint = (s, n) => {
    const v = uint(s, n);
    return v & (1 << (n - 1)) ? v - (1 << n) : v;
  };
  const text = (s, chars) => {
    let out = '';
    for (let i = 0; i < chars; i++) {
      const c = uint(s + i * 6, 6);
      out += c < 32 ? String.fromCharCode(c + 64) : String.fromCharCode(c);
    }
    return out.replace(/@+$/, '').trim();
  };

  const mt   = uint(0, 6);
  const mmsi = uint(8, 30).toString().padStart(9, '0');
  const base = { mt, mmsi, binaryStr };

  if ([1, 2, 3].includes(mt)) {
    const lon = sint(61, 28) / 600000;
    const lat = sint(89, 27) / 600000;
    return {
      ...base,
      navStatus: uint(38, 4),
      rot:  sint(42, 8),
      sog:  (uint(50, 10) / 10).toFixed(1),
      lat:  validPos(lat, lon) ? lat.toFixed(5) : null,
      lon:  validPos(lat, lon) ? lon.toFixed(5) : null,
      cog:  (uint(116, 12) / 10).toFixed(1),
      hdg:  uint(128, 9),
    };
  }

  if (mt === 4) {
    return { ...base, stationType: 'BASE_STATION' };
  }

  if (mt === 5 && totalBits >= 426) {
    return {
      ...base,
      callsign: text(70, 7),
      name:     text(112, 20),
      shipType: uint(232, 8),
      dest:     text(302, 20),
      draught:  (uint(294, 8) / 10).toFixed(1),
    };
  }

  if (mt === 18) {
    const lon = sint(57, 28) / 600000;
    const lat = sint(85, 27) / 600000;
    return {
      ...base,
      sog: (uint(46, 10) / 10).toFixed(1),
      lat: validPos(lat, lon) ? lat.toFixed(5) : null,
      lon: validPos(lat, lon) ? lon.toFixed(5) : null,
      cog: (uint(112, 12) / 10).toFixed(1),
      hdg: uint(124, 9),
    };
  }

  if (mt === 21) {
    const lon = sint(57, 28) / 600000;
    const lat = sint(85, 27) / 600000;
    return {
      ...base,
      name: text(43, 20),
      lat:  validPos(lat, lon) ? lat.toFixed(5) : null,
      lon:  validPos(lat, lon) ? lon.toFixed(5) : null,
    };
  }

  if (mt === 24) {
    const part = uint(38, 2);
    if (part === 0) return { ...base, part, name: text(40, 20) };
    return { ...base, part, callsign: text(90, 7), shipType: uint(136, 8) };
  }

  return base;
}

// ─── NMEA line handler ───────────────────────────────────────────────────────
function handleLine(line) {
  if (!line.startsWith('!AIVDM') && !line.startsWith('!AIVDO')) return null;

  const f = line.split(',');
  if (f.length < 7) return null;

  const count   = parseInt(f[1]);
  const partNum = parseInt(f[2]);
  const seqId   = f[3] || '0';
  const payload = f[5];
  const fill    = parseInt(f[6]) || 0;

  if (count === 1) {
    try {
      return { raw: line, payload, decoded: decodePayload(payload, fill) };
    } catch { return { raw: line, payload, decoded: null }; }
  }

  // Multi-part assembly
  const key = `${seqId}:${count}:${fill}`;
  if (!multipartBuf.has(key)) multipartBuf.set(key, { parts: new Array(count), fill, ts: Date.now() });
  const buf = multipartBuf.get(key);
  buf.parts[partNum - 1] = payload;

  if (buf.parts.every(Boolean)) {
    multipartBuf.delete(key);
    const full = buf.parts.join('');
    try {
      return { raw: line, payload: full, decoded: decodePayload(full, buf.fill), multi: true };
    } catch { return { raw: line, payload: full, decoded: null, multi: true }; }
  }
  return null;
}

// Prune stale multipart entries every 30s
setInterval(() => {
  const cutoff = Date.now() - 30000;
  for (const [k, v] of multipartBuf) if (v.ts < cutoff) multipartBuf.delete(k);
}, 30000);

// ─── SSH connection + tail ────────────────────────────────────────────────────
function startSSH() {
  const conn = new Client();

  conn.on('ready', () => {
    connStatus = 'ONLINE';
    broadcast({ type: 'status', status: 'ONLINE' });
    console.log('[SSH] connected — tailing', LOG_PATH);

    // tail -n 0 means only NEW lines from now on
    conn.exec(`tail -n 0 -f ${LOG_PATH}`, (err, stream) => {
      if (err) { console.error('[SSH] exec error:', err.message); conn.end(); return; }

      let buf = '';

      stream.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;

          // AIS-catcher stats line  e.g.: received: 22 msgs, total: 413891 msgs, rate: 7.316 msg/s
          const m = line.match(/total:\s*(\d+)\s*msgs.*rate:\s*([\d.]+)/);
          if (m) {
            totalMsgs = parseInt(m[1]);
            rxRate    = parseFloat(m[2]).toFixed(2);
            broadcast({ type: 'stats', total: totalMsgs, rate: rxRate });
            continue;
          }

          const result = handleLine(line);
          if (result) {
            totalMsgs++;
            msgThisSecond++;
            if (result.decoded?.mmsi && result.decoded?.lat !== null) {
              seenMMSI.add(result.decoded.mmsi);
            }
            broadcast({ type: 'msg', ...result, uniqueVessels: seenMMSI.size });
          }
        }
      });

      stream.stderr.on('data', () => {/* ignore */});
      stream.on('close', () => {
        connStatus = 'OFFLINE';
        broadcast({ type: 'status', status: 'OFFLINE' });
        conn.end();
        console.log('[SSH] stream closed — reconnecting in 3s');
        setTimeout(startSSH, 3000);
      });
    });
  });

  conn.on('error', (err) => {
    console.error('[SSH] error:', err.message);
    connStatus = 'ERROR';
    broadcast({ type: 'status', status: 'ERROR' });
    setTimeout(startSSH, 5000);
  });

  conn.on('end', () => {
    connStatus = 'OFFLINE';
    setTimeout(startSSH, 3000);
  });

  conn.connect(SSH);
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', status: connStatus, host: SSH.host }));
  ws.send(JSON.stringify({ type: 'stats',  total: totalMsgs, rate: rxRate, uniqueVessels: seenMMSI.size }));
  // Push best known antenna position to new clients
  if (ANTENNA_LAT !== null && ANTENNA_LON !== null) {
    ws.send(JSON.stringify({ type: 'antenna', lat: ANTENNA_LAT, lon: ANTENNA_LON, exact: true, source: 'config' }));
  } else if (antennaFromIP) {
    ws.send(JSON.stringify({ type: 'antenna', ...antennaFromIP, exact: false, source: 'ip' }));
  }
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ─── IP geolocation (best-effort, non-blocking) ──────────────────────────────
function fetchIPLocation() {
  http.get('http://ip-api.com/json', (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const d = JSON.parse(body);
        if (d.status === 'success' && d.lat && d.lon) {
          console.log(`[ANTENNA] IP geo: ${d.lat}, ${d.lon} (${d.city}, ${d.countryCode})`);
          antennaFromIP = { lat: d.lat, lon: d.lon, city: d.city, country: d.countryCode };
          broadcast({ type: 'antenna', lat: d.lat, lon: d.lon, exact: false, source: 'ip',
                      city: d.city, country: d.countryCode });
        }
      } catch(e) { console.error('[ANTENNA] parse error:', e.message); }
    });
  }).on('error', err => console.error('[ANTENNA] geo error:', err.message));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║   AIS-NODE HUD v1.0              ║`);
  console.log(`╚══════════════════════════════════╝`);
  console.log(`  http://localhost:${PORT}\n`);
  fetchIPLocation();   // geolocate this machine's public IP → antenna position
  startSSH();
});
