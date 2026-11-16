// VoXoV — two-way intercom between a browser and Sonos speakers.
//
//   station mic --ws--> [up mixer] --http wav/mp3--> Sonos speaker(s)
//   room-mic device --ws--> [down mixer] --ws--> station
//
// Sonos has no API for its built-in microphones, so the return path comes from
// a second device (phone/laptop) that opens this page in "Room mic" mode.

import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.PORT || 8090);       // Sonos fetches the stream here (plain HTTP)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443); // other devices need HTTPS for mic access
const RATE = 48000;
const FRAME = 960;            // 20 ms of mono 16-bit PCM
const FRAME_BYTES = FRAME * 2;
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// ───────────────────────── helpers ─────────────────────────

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (v) => String(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unesc(m[1]) : '';
};
const attr = (s, name) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s);
  return m ? unesc(m[1]) : '';
};
const isPrivateIPv4 = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m || m.slice(1).some((n) => Number(n) > 255)) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
};
const lanAddresses = () =>
  Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

// ───────────────────────── Sonos control (UPnP/SOAP) ─────────────────────────

const SERVICES = {
  avt: { path: '/MediaRenderer/AVTransport/Control', type: 'urn:schemas-upnp-org:service:AVTransport:1' },
  rc: { path: '/MediaRenderer/RenderingControl/Control', type: 'urn:schemas-upnp-org:service:RenderingControl:1' },
  zgt: { path: '/ZoneGroupTopology/Control', type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' },
};

async function soap(ip, svc, action, args = {}) {
  const s = SERVICES[svc];
  const params = Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const body =
    `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${s.type}">${params}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(`http://${ip}:1400${s.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${s.type}#${action}"` },
    body,
    signal: AbortSignal.timeout(5000),
  });
  const text = await r.text();
  if (!r.ok) {
    const code = tag(text, 'errorCode');
    throw new Error(`${action} failed (HTTP ${r.status}${code ? `, UPnP error ${code}` : ''})`);
  }
  return text;
}

// ───────────────────────── discovery ─────────────────────────

function ssdpSearch(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Set();
    const sockets = [];
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\n' +
        'ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n'
    );
    // One socket per network interface, otherwise Windows only searches the default one.
    for (const addr of lanAddresses()) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(sock);
      sock.on('error', () => {});
      sock.on('message', (data, rinfo) => {
        if (/ZonePlayer|Sonos/i.test(data.toString())) found.add(rinfo.address);
      });
      sock.bind(0, addr, () => {
        try {
          sock.setBroadcast(true);
          const send = () => {
            sock.send(msg, 1900, '239.255.255.250', () => {});
            sock.send(msg, 1900, '255.255.255.255', () => {});
          };
          send();
          setTimeout(send, 600).unref();
        } catch {}
      });
    }
    setTimeout(() => {
      for (const s of sockets) try { s.close(); } catch {}
      resolve([...found]);
    }, timeoutMs);
  });
}

/** Ask one speaker for the whole household: every room, its IP and its group coordinator. */
async function topology(ip) {
  const xml = tag(await soap(ip, 'zgt', 'GetZoneGroupState'), 'ZoneGroupState');
  const out = [];
  for (const g of xml.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const coordinator = attr(g[1], 'Coordinator');
    for (const m of g[2].matchAll(/<ZoneGroupMember\s([^>]*)>/g)) {
      if (attr(m[1], 'Invisible') === '1') continue; // bonded surrounds, stereo-pair slaves
      const host = /\/\/([^:/]+)/.exec(attr(m[1], 'Location'))?.[1];
      if (!host) continue;
      out.push({ uuid: attr(m[1], 'UUID'), name: attr(m[1], 'ZoneName'), ip: host, coordinator });
    }
  }
  return out;
}

const speakers = new Map(); // uuid -> { uuid, name, ip, coordinator, model }
const manualIps = new Set();
const models = new Map();

async function modelOf(sp) {
  if (models.has(sp.uuid)) return models.get(sp.uuid);
  try {
    const r = await fetch(`http://${sp.ip}:1400/xml/device_description.xml`, { signal: AbortSignal.timeout(2500) });
    const xml = await r.text();
    const model = tag(xml, 'displayName') || tag(xml, 'modelName');
    models.set(sp.uuid, model);
    return model;
  } catch {
    return '';
  }
}

async function discover() {
  const ips = new Set([...(await ssdpSearch()), ...manualIps]);
  const next = new Map();
  const covered = new Set();
  for (const ip of ips) {
    if (covered.has(ip)) continue; // already listed by another speaker's topology
    try {
      for (const sp of await topology(ip)) {
        next.set(sp.uuid, sp);
        covered.add(sp.ip);
      }
    } catch {}
  }
  await Promise.all([...next.values()].map(async (sp) => { sp.model = await modelOf(sp); }));
  speakers.clear();
  for (const [k, v] of next) speakers.set(k, v);
}

async function listSpeakers(rescan) {
  if (rescan || speakers.size === 0) await discover();
  const list = [...speakers.values()].sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    list.map(async (sp) => {
      let volume = null;
      try {
        volume = Number(tag(await soap(sp.ip, 'rc', 'GetVolume', { InstanceID: 0, Channel: 'Master' }), 'CurrentVolume'));
      } catch {}
      const group = list.filter((o) => o.coordinator === sp.coordinator && o.uuid !== sp.uuid).map((o) => o.name);
      return { uuid: sp.uuid, name: sp.name, ip: sp.ip, model: sp.model || '', group, volume };
    })
  );
}

// ───────────────────────── audio mixers ─────────────────────────

/** Sums 20 ms frames from any number of sources and emits one frame per 20 ms, silence included. */
class Mixer extends EventEmitter {
  constructor() {
    super();
    this.sources = new Map();
    let t0 = performance.now();
    let n = 0;
    setInterval(() => {
      const now = performance.now();
      if (now - t0 - n * 20 > 400) { t0 = now; n = 0; } // fell far behind (sleep/stall): resync
      while (n * 20 <= now - t0) { this.tick(); n++; }
    }, 5);
  }
  push(id, frame) {
    let s = this.sources.get(id);
    if (!s) this.sources.set(id, (s = { q: [], primed: false }));
    s.q.push(frame);
    if (s.q.length > 12) s.q.splice(0, s.q.length - 3); // source is ahead of real time: drop to catch up
  }
  remove(id) { this.sources.delete(id); }
  tick() {
    const out = new Int16Array(FRAME);
    let active = false;
    for (const s of this.sources.values()) {
      if (!s.primed) { if (s.q.length < 2) continue; s.primed = true; }
      const f = s.q.shift();
      if (!f) { s.primed = false; continue; }
      active = true;
      for (let i = 0; i < FRAME; i++) {
        const v = out[i] + f[i];
        out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
    }
    this.emit('frame', out, active);
  }
}

const up = new Mixer();   // station mics -> Sonos
const down = new Mixer(); // room mics -> stations

// ───────────────────────── stream served to Sonos ─────────────────────────

const wavListeners = new Set();
const mp3 = { proc: null, listeners: new Set() };

function wavHeader() {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(0xffffffff, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(0xffffffff - 44, 40);
  return h;
}

function writeOrDrop(res, chunk, set) {
  if (res.writableLength > 1_000_000) { set.delete(res); res.destroy(); return; } // stalled client
  res.write(chunk);
}

up.on('frame', (f) => {
  if (wavListeners.size) {
    const st = Buffer.alloc(FRAME * 4); // mono -> stereo
    for (let i = 0; i < FRAME; i++) { st.writeInt16LE(f[i], i * 4); st.writeInt16LE(f[i], i * 4 + 2); }
    for (const res of wavListeners) writeOrDrop(res, st, wavListeners);
  }
  if (mp3.proc && mp3.proc.stdin.writable) mp3.proc.stdin.write(Buffer.from(f.buffer));
});

function mp3Start() {
  const p = spawn('ffmpeg', ['-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0',
    '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '128k', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  p.stdin.on('error', () => {});
  p.stdout.on('data', (c) => { for (const res of mp3.listeners) writeOrDrop(res, c, mp3.listeners); });
  p.on('exit', () => {
    if (mp3.proc !== p) return;
    mp3.proc = null;
    for (const res of mp3.listeners) res.end();
    mp3.listeners.clear();
  });
  mp3.proc = p;
}

function handleStream(req, res, fmt) {
  if (fmt === 'mp3' && !HAS_FFMPEG) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    'Content-Type': fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'close',
    'transferMode.dlna.org': 'Streaming',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  req.socket.setNoDelay(true);
  if (fmt === 'mp3') {
    mp3.listeners.add(res);
    if (!mp3.proc) mp3Start();
    res.on('close', () => {
      mp3.listeners.delete(res);
      if (!mp3.listeners.size && mp3.proc) { const p = mp3.proc; mp3.proc = null; p.kill(); }
    });
  } else {
    res.write(wavHeader());
    wavListeners.add(res);
    res.on('close', () => wavListeners.delete(res));
  }
}

// ───────────────────────── intercom session ─────────────────────────

let session = null; // { format, targets: [{ uuid, name, ip, snap }] }
const localAddrCache = new Map();

/** Which of our addresses does this speaker see us on? */
function localAddrFor(ip) {
  if (localAddrCache.has(ip)) return Promise.resolve(localAddrCache.get(ip));
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: ip, port: 1400, timeout: 3000 }, () => {
      localAddrCache.set(ip, s.localAddress);
      resolve(s.localAddress);
      s.destroy();
    });
    s.on('timeout', () => { s.destroy(); reject(new Error('speaker unreachable')); });
    s.on('error', reject);
  });
}

async function snapshot(ip) {
  const I = { InstanceID: 0 };
  const state = tag(await soap(ip, 'avt', 'GetTransportInfo', I), 'CurrentTransportState');
  const mi = await soap(ip, 'avt', 'GetMediaInfo', I);
  const pi = await soap(ip, 'avt', 'GetPositionInfo', I);
  const uri = tag(mi, 'CurrentURI');
  if (uri.includes('/sonos/')) return { uri: '' }; // a leftover VoXoV stream — nothing worth restoring
  return { state, uri, meta: tag(mi, 'CurrentURIMetaData'), track: tag(pi, 'Track'), rel: tag(pi, 'RelTime') };
}

async function restore(ip, snap) {
  const I = { InstanceID: 0 };
  await soap(ip, 'avt', 'Stop', I).catch(() => {});
  if (!snap?.uri) return;
  await soap(ip, 'avt', 'SetAVTransportURI', { ...I, CurrentURI: snap.uri, CurrentURIMetaData: snap.meta || '' });
  if (snap.uri.startsWith('x-rincon-queue:')) {
    if (Number(snap.track) > 0) await soap(ip, 'avt', 'Seek', { ...I, Unit: 'TRACK_NR', Target: snap.track }).catch(() => {});
    if (/^\d+:\d\d:\d\d/.test(snap.rel)) await soap(ip, 'avt', 'Seek', { ...I, Unit: 'REL_TIME', Target: snap.rel }).catch(() => {});
  }
  if (snap.state === 'PLAYING') await soap(ip, 'avt', 'Play', { ...I, Speed: 1 });
}

async function startSession(uuids, format) {
  if (session) await stopSession();
  if (format === 'mp3' && !HAS_FFMPEG) throw new Error('MP3 needs ffmpeg on the server PATH');
  // A grouped speaker only obeys its coordinator, so target coordinators (the whole group plays).
  const targets = new Map();
  for (const id of uuids) {
    const sp = speakers.get(id);
    const co = sp && (speakers.get(sp.coordinator) || sp);
    if (co) targets.set(co.uuid, co);
  }
  if (!targets.size) throw new Error('No known speakers selected — scan again');

  const nonce = crypto.randomBytes(4).toString('hex');
  const I = { InstanceID: 0 };
  const results = await Promise.all([...targets.values()].map(async (sp) => {
    try {
      const host = `${await localAddrFor(sp.ip)}:${HTTP_PORT}/sonos/${nonce}/live.${format}`;
      const snap = await snapshot(sp.ip).catch(() => null);
      const httpUrl = `http://${host}`;
      const didl =
        '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
        'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="voxov" parentID="0" restricted="1">' +
        '<dc:title>VoXoV Intercom</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
        `<res protocolInfo="http-get:*:audio/wav:*">${esc(httpUrl)}</res></item></DIDL-Lite>`;
      const attempts = format === 'mp3' ? [[`x-rincon-mp3radio://${host}`, '']] : [[httpUrl, didl], [httpUrl, '']];
      let lastErr;
      for (const [uri, meta] of attempts) {
        try {
          await soap(sp.ip, 'avt', 'SetAVTransportURI', { ...I, CurrentURI: uri, CurrentURIMetaData: meta });
          await soap(sp.ip, 'avt', 'Play', { ...I, Speed: 1 });
          lastErr = null;
          break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr) throw lastErr;
      return { uuid: sp.uuid, name: sp.name, ip: sp.ip, snap, ok: true };
    } catch (e) {
      return { uuid: sp.uuid, name: sp.name, ok: false, error: e.message };
    }
  }));

  const ok = results.filter((r) => r.ok);
  session = ok.length ? { format, targets: ok } : null;
  broadcastState();
  return results.map(({ snap, ip, ...r }) => r);
}

async function stopSession() {
  const s = session;
  session = null;
  if (s) await Promise.all(s.targets.map((t) => restore(t.ip, t.snap).catch(() => {})));
  broadcastState();
}

// ───────────────────────── HTTP API ─────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const origin = req.headers.origin;
  if (origin && allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome: public page -> LAN
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  try {
    const stream = /^\/sonos\/[0-9a-f]+\/live\.(wav|mp3)$/.exec(p);
    if (stream && (req.method === 'GET' || req.method === 'HEAD')) return handleStream(req, res, stream[1]);

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(DIR, 'public', 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/info') {
      return json(res, 200, {
        secureUrls: httpsOk ? lanAddresses().map((a) => `https://${a}:${HTTPS_PORT}`) : [],
        mp3: HAS_FFMPEG,
        ...stateMsg(),
      });
    }
    if (req.method === 'GET' && p === '/api/speakers') {
      return json(res, 200, { speakers: await listSpeakers(url.searchParams.has('rescan')) });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (p === '/api/add') {
        if (!isPrivateIPv4(body.ip)) return json(res, 400, { error: 'Enter a local IPv4 address, e.g. 192.168.1.50' });
        await topology(body.ip).catch(() => { throw new Error(`No Sonos speaker answered at ${body.ip}`); });
        manualIps.add(body.ip);
        return json(res, 200, { speakers: await listSpeakers(true) });
      }
      if (p === '/api/start') {
        const uuids = Array.isArray(body.uuids) ? body.uuids.map(String) : [];
        return json(res, 200, { results: await startSession(uuids, body.format === 'mp3' ? 'mp3' : 'wav') });
      }
      if (p === '/api/stop') { await stopSession(); return json(res, 200, { ok: true }); }
      if (p === '/api/volume') {
        const sp = speakers.get(String(body.uuid));
        const v = Math.round(Number(body.volume));
        if (!sp || !(v >= 0 && v <= 100)) return json(res, 400, { error: 'Bad volume request' });
        await soap(sp.ip, 'rc', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: v });
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.destroy();
  }
}

// ───────────────────────── WebSocket audio ─────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
const clients = new Set(); // ws with .role and .id
let idleTimer = null;
let nextId = 1;

const count = (role) => [...clients].filter((c) => c.role === role).length;
const stateMsg = () => ({
  type: 'state',
  stations: count('console'),
  rooms: count('room'),
  active: session ? session.targets.map((t) => t.uuid) : [],
});
function broadcastState() {
  const msg = JSON.stringify(stateMsg());
  for (const c of clients) if (c.readyState === 1) c.send(msg);
  // Nobody at the station any more: give the speakers back after a short grace period.
  clearTimeout(idleTimer);
  if (session && count('console') === 0) idleTimer = setTimeout(() => stopSession().catch(() => {}), 15000);
}

wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'room' ? 'room' : 'console';
  ws.id = nextId++;
  clients.add(ws);
  const mixer = ws.role === 'room' ? down : up;
  ws.on('message', (data, isBinary) => {
    if (!isBinary || data.length !== FRAME_BYTES) return;
    mixer.push(ws.id, new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)));
  });
  ws.on('close', () => { clients.delete(ws); mixer.remove(ws.id); broadcastState(); });
  ws.on('error', () => {});
  broadcastState();
});

down.on('frame', (f, active) => {
  if (!active) return;
  const buf = Buffer.from(f.buffer);
  for (const c of clients) {
    if (c.role === 'console' && c.readyState === 1 && c.bufferedAmount < 200_000) c.send(buf, { binary: true });
  }
});

// Browsers on other sites (e.g. the GitHub Pages UI) may use this server; nobody else may.
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://joranlager.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);
function allowedOrigin(origin) {
  if (EXTRA_ORIGINS.includes(origin)) return true;
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || lanAddresses().includes(h);
  } catch {
    return false;
  }
}

function onUpgrade(req, socket, head) {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  if (req.headers.origin && !allowedOrigin(req.headers.origin)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

// ───────────────────────── boot ─────────────────────────

let httpsOk = false;

async function loadCert() {
  const dir = path.join(DIR, '.cert');
  const kp = path.join(dir, 'key.pem');
  const cp = path.join(dir, 'cert.pem');
  if (fs.existsSync(kp) && fs.existsSync(cp)) return { key: fs.readFileSync(kp), cert: fs.readFileSync(cp) };
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...lanAddresses().map((ip) => ({ type: 7, ip }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'VoXoV' }], {
    days: 825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(kp, pems.private);
  fs.writeFileSync(cp, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

const plain = http.createServer(handler);
plain.on('upgrade', onUpgrade);
plain.listen(HTTP_PORT, () => console.log(`VoXoV station:   http://localhost:${HTTP_PORT}`));

try {
  const secure = https.createServer(await loadCert(), handler);
  secure.on('upgrade', onUpgrade);
  secure.on('error', (e) => console.warn(`HTTPS disabled: ${e.message}`));
  secure.listen(HTTPS_PORT, () => {
    httpsOk = true;
    for (const a of lanAddresses()) console.log(`Room-mic device: https://${a}:${HTTPS_PORT}/#room  (accept the certificate warning)`);
  });
} catch (e) {
  console.warn(`HTTPS disabled (other devices cannot use their microphone): ${e.message}`);
}
if (!HAS_FFMPEG) console.log('ffmpeg not found — MP3 stream format unavailable, WAV only.');

let quitting = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (quitting) process.exit(1);
    quitting = true;
    await stopSession().catch(() => {}); // hand the speakers back before exiting
    process.exit(0);
  });
}
