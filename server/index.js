import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer }  from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath }          from 'node:url';
import { randomUUID }             from 'node:crypto';
import { WebSocketServer }        from 'ws';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DIST_DIR   = join(__dirname, '../dist');
const CERT_DIR   = process.env.CERT_DIR   ?? '/certs';
const HTTP_PORT  = parseInt(process.env.HTTP_PORT  ?? '8080', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT ?? '8443', 10);

const EXT_RADIUS_KM     = parseInt(process.env.EXT_RADIUS_KM ?? '200', 10);

const EXT_RESEND_MS     = 5 * 60 * 1000;

const MESHMAP_URL     = 'https://meshmap.net/nodes.json';
const LIAMCOTTLE_URL  = 'https://meshtastic.liamcottle.net/api/v1/nodes?limit=5000';
const MAX_NODE_AGE_S  = 24 * 3600;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R   = 6371;
  const dLa = (lat2 - lat1) * Math.PI / 180;
  const dLo = (lon2 - lon1) * Math.PI / 180;
  const a   = Math.sin(dLa/2)**2
            + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180)
            * Math.sin(dLo/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function offsetGPS(lat, lon, bearingDeg, distKm) {
  const R  = 6371;
  const d  = distKm / R;
  const b  = bearingDeg * Math.PI / 180;
  const p1 = lat * Math.PI / 180;
  const l1 = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1)*Math.cos(d) + Math.cos(p1)*Math.sin(d)*Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(p1), Math.cos(d)-Math.sin(p1)*Math.sin(p2));
  return { lat: p2 * 180/Math.PI, lon: l2 * 180/Math.PI };
}

const _now = Math.floor(Date.now() / 1000);
const PHANTOM_NODES = [
  { num: 0xDEAD0001, shortName: 'SOBOL', longName: 'Matthew Sobol',           bearing: 15,  distKm: 12.7, snr: -4.2, lastHeard: 1136073600   },
  { num: 0xDEAD0002, shortName: 'SEBCK', longName: 'Det. Pete Sebeck',         bearing: 87,  distKm: 8.4,  snr: -7.1, lastHeard: _now - 864000  },
  { num: 0xDEAD0003, shortName: 'ROSS',  longName: 'Brian Ross',               bearing: 142, distKm: 15.2, snr: -5.8, lastHeard: _now - 1209600 },
  { num: 0xDEAD0004, shortName: 'MRRTT', longName: '"Tripwire" Merritt',        bearing: 220, distKm: 6.1,  snr: -8.3, lastHeard: _now - 259200  },
  { num: 0xDEAD0005, shortName: 'LOKI',  longName: 'Loki',                     bearing: 270, distKm: 20.0, snr: -3.6, lastHeard: _now - 172800  },
  { num: 0xDEAD0006, shortName: 'CYBST', longName: 'Cyberstorm Entertainment', bearing: 330, distKm: 9.8,  snr: -6.4, lastHeard: _now - 604800  },
];

function pushPhantomToClient(ws, client) {
  if (client.phantomsSent || !client.observerPos?.lat) return;
  const { lat, lon } = client.observerPos;
  for (const p of PHANTOM_NODES) {
    const pos = offsetGPS(lat, lon, p.bearing, p.distKm);
    safeSend(ws, { type: 'nodeUpdated', node: {
      ...p, lat: pos.lat, lon: pos.lon, alt: 0,
      source: 'daemon', positionSource: 'darknet',
    }});
  }
  client.phantomsSent = true;
}

const externalNodes = new Map();

async function fetchJSON(url) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal:  ctrl.signal,
      headers: { 'User-Agent': 'ar-tastic/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

async function fetchMeshmap() {
  try {
    const data  = await fetchJSON(MESHMAP_URL);
    const nowS  = Date.now() / 1000;
    let   count = 0;
    for (const [numStr, raw] of Object.entries(data)) {
      if (raw.latitude == null) continue;
      if (nowS - (raw.lastMapReport ?? 0) > MAX_NODE_AGE_S) continue;
      const num = parseInt(numStr, 10);
      externalNodes.set(num, {
        num,
        longName:       raw.longName  ?? `!${num.toString(16)}`,
        shortName:      raw.shortName ?? '????',
        hwModel:        raw.hwModel,
        lat:            raw.latitude  / 1e7,
        lon:            raw.longitude / 1e7,
        alt:            raw.altitude  ?? 0,
        lastHeard:      raw.lastMapReport,
        positionSource: 'gps',
        source:         'meshmap',
      });
      count++;
    }
    console.log(`[meshmap] ${count} nodes loaded`);
    pushExternalToAll();
  } catch (e) {
    console.warn('[meshmap] fetch failed:', e.message);
  }
}

async function fetchLiamcottle() {
  try {
    const data  = await fetchJSON(LIAMCOTTLE_URL);
    const nodes = Array.isArray(data) ? data : (data.nodes ?? []);
    const nowMs = Date.now();
    let   count = 0;
    for (const raw of nodes) {
      if (raw.latitude == null) continue;
      const updMs = raw.position_updated_at
        ? new Date(raw.position_updated_at).getTime()
        : 0;
      if (nowMs - updMs > MAX_NODE_AGE_S * 1000) continue;
      const num = parseInt(raw.node_id, 10);
      externalNodes.set(num, {
        num,
        longName:       raw.long_name  ?? `!${num.toString(16)}`,
        shortName:      raw.short_name ?? '????',
        hwModel:        raw.hardware_model,
        lat:            raw.latitude,
        lon:            raw.longitude,
        alt:            raw.altitude  ?? 0,
        lastHeard:      updMs ? Math.floor(updMs / 1000) : undefined,
        battery:        raw.battery_level,
        positionSource: 'gps',
        source:         'liamcottle',
      });
      count++;
    }
    console.log(`[liamcottle] ${count} nodes loaded`);
    pushExternalToAll();
  } catch (e) {
    console.warn('[liamcottle] fetch failed:', e.message);
  }
}

function pushExternalToClient(ws, client) {
  if (!client.observerPos?.lat) return;
  const { lat, lon } = client.observerPos;
  let sent = 0;
  for (const node of externalNodes.values()) {
    if (haversineKm(lat, lon, node.lat, node.lon) <= EXT_RADIUS_KM) {
      safeSend(ws, { type: 'nodeUpdated', node });
      sent++;
    }
  }
  client.externalSentAt = Date.now();
  if (sent) console.log(`[ext] pushed ${sent} external nodes to client`);
}

function pushExternalToAll() {
  for (const [ws, client] of clients) {
    if (client.observerPos?.lat) pushExternalToClient(ws, client);
  }
}

class NodeAggregator {
  constructor() {

    this._store = new Map();
  }

  observe(clientId, node, observerPos) {
    if (!node?.num) return null;
    if (!this._store.has(node.num)) {
      this._store.set(node.num, { nodeData: {}, clientObs: new Map() });
    }
    const entry = this._store.get(node.num);
    entry.nodeData = { ...entry.nodeData, ...node, num: node.num };
    if (observerPos?.lat != null) {
      entry.clientObs.set(clientId, { observerPos, snr: node.snr ?? 0, ts: Date.now() });
    }
    return this._compute(node.num);
  }

  snapshot() {
    return [...this._store.keys()].map(n => this._compute(n)).filter(Boolean);
  }

  pruneStale(maxAgeS) {
    const cutoffMs = Date.now() - maxAgeS * 1000;
    const cutoffS  = Math.floor(cutoffMs / 1000);
    const removed  = [];
    for (const [num, entry] of this._store) {
      for (const [clientId, obs] of entry.clientObs) {
        if (obs.ts < cutoffMs) entry.clientObs.delete(clientId);
      }
      if (entry.nodeData.lastHeard != null && entry.nodeData.lastHeard < cutoffS) {
        this._store.delete(num);
        removed.push(num);
      }
    }
    return removed;
  }

  _compute(num) {
    const entry = this._store.get(num);
    if (!entry) return null;
    const { nodeData, clientObs } = entry;

    if (nodeData.lat != null) return { ...nodeData, positionSource: 'gps' };

    const obs = [...clientObs.values()];
    if (!obs.length) return { ...nodeData, positionSource: 'unknown' };

    let wSum = 0, latSum = 0, lonSum = 0, altSum = 0;
    for (const o of obs) {
      const w = Math.exp(o.snr / 10);
      latSum += o.observerPos.lat * w;
      lonSum += o.observerPos.lon * w;
      altSum += (o.observerPos.alt ?? 0) * w;
      wSum   += w;
    }
    return {
      ...nodeData,
      lat: latSum / wSum,
      lon: lonSum / wSum,
      alt: altSum / wSum,
      positionSource: obs.length >= 3 ? 'triangulated' : 'estimated',
      observerCount:  obs.length,
    };
  }
}

const nodes   = new NodeAggregator();
const clients = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const fp = join(DIST_DIR, p);
  if (!fp.startsWith(DIST_DIR)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(fp)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    createReadStream(join(DIST_DIR, 'index.html')).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(fp)] ?? 'application/octet-stream' });
  createReadStream(fp).pipe(res);
}

function broadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(raw);
}

function pruneStaleNodes() {
  const removed = nodes.pruneStale(MAX_NODE_AGE_S);

  const cutoffS = Math.floor(Date.now() / 1000) - MAX_NODE_AGE_S;
  for (const [num, node] of externalNodes) {
    if (node.lastHeard != null && node.lastHeard < cutoffS) {
      externalNodes.delete(num);
      removed.push(num);
    }
  }

  for (const num of removed) broadcast({ type: 'nodeRemoved', num });
  if (removed.length) console.log(`[prune] removed ${removed.length} stale node(s)`);
}

function safeSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const client = clients.get(ws);
  if (!client) return;

  switch (msg.type) {
    case 'gps': {
      client.observerPos = msg.pos;

      if (Date.now() - (client.externalSentAt ?? 0) > EXT_RESEND_MS) {
        pushExternalToClient(ws, client);
      }
      pushPhantomToClient(ws, client);
      break;
    }
    case 'node': {
      const enriched = nodes.observe(client.id, msg.node, client.observerPos);
      if (enriched) broadcast({ type: 'nodeUpdated', node: enriched });
      break;
    }
  }
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', ws => {
    const client = { id: randomUUID(), observerPos: null, externalSentAt: 0, phantomsSent: false };
    clients.set(ws, client);
    console.log(`[ws] client connected (${clients.size} total)`);


    for (const node of nodes.snapshot()) {
      safeSend(ws, { type: 'nodeUpdated', node });
    }

    ws.on('message', raw => onMessage(ws, raw));
    ws.on('close',   ()  => {
      clients.delete(ws);
      console.log(`[ws] client disconnected (${clients.size} remaining)`);
    });
  });
}

const FALLBACK_CERT_DIR = process.env.FALLBACK_CERT_DIR ?? null;

function resolveCerts() {
  for (const dir of [CERT_DIR, FALLBACK_CERT_DIR].filter(Boolean)) {
    const cert = join(dir, 'cert.pem');
    const key  = join(dir, 'key.pem');
    if (existsSync(cert) && existsSync(key)) return { cert, key, dir };
  }
  return null;
}

const certFiles = resolveCerts();

if (certFiles) {
  const selfSigned = certFiles.dir !== CERT_DIR;
  const tls   = { cert: readFileSync(certFiles.cert), key: readFileSync(certFiles.key) };
  const https = httpsServer(tls, serveStatic);
  attachWebSocket(https);
  https.listen(HTTPS_PORT, '0.0.0.0', () =>
    console.log(`AR-tastic  ->  https://0.0.0.0:${HTTPS_PORT}  [Daemon active. Awaiting trigger event.]${selfSigned ? '  (self-signed)' : ''}`)
  );

  const http = httpServer(serveStatic);
  attachWebSocket(http);
  http.listen(HTTP_PORT, '0.0.0.0', () =>
    console.log(`AR-tastic  →  http://0.0.0.0:${HTTP_PORT}`)
  );
} else {
  console.warn('No TLS certs found - serving HTTP only');
  const http = httpServer(serveStatic);
  attachWebSocket(http);
  http.listen(HTTP_PORT, '0.0.0.0', () =>
    console.log(`AR-tastic  →  http://0.0.0.0:${HTTP_PORT}`)
  );
}

fetchMeshmap();
fetchLiamcottle();
setInterval(fetchMeshmap,    2 * 60 * 1000);
setInterval(fetchLiamcottle, 5 * 60 * 1000);
setInterval(pruneStaleNodes, 15 * 60 * 1000);
