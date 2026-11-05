// Teiko Planner local server: static page + tiny JSON document store + photo uploads.
// No dependencies. Run: node server.js  ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const DB_FILE = path.join(DATA, 'db.json');
const SEED_FILE = path.join(ROOT, 'seed.json');

fs.mkdirSync(UPLOADS, { recursive: true });
let db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

// ponytail: whole-file rewrite on every change; fine for one office's data, move to SQLite if it grows past a few MB
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
save();

// Optional shared password: put it in password.txt (or env TEIKO_PASSWORD) before sharing the address with the team.
const PW_FILE = path.join(ROOT, 'password.txt');
const PASSWORD = process.env.TEIKO_PASSWORD || (fs.existsSync(PW_FILE) ? fs.readFileSync(PW_FILE, 'utf8').trim() : '');
function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const clients = new Set();
function changed(col) { for (const res of clients) res.write(`data: ${col}\n\n`); }

// national holidays + story tasks (shared with the Vercel function api/holidays.js)
const { getHolidays, storyTask } = require('./lib/holidays');
async function syncHolidays() {
  try {
    const h = await getHolidays();
    const ev = (db.events ??= {}), tasks = (db.tasks ??= {}), gone = new Set(db._meta?.dismissed || []), keep = new Set(h.events.map(e => e.id));
    let n = 0, t = 0;
    for (const e of h.events) if (ev[e.id]?.title !== e.title || ev[e.id]?.type !== (e.type || 'holiday')) { ev[e.id] = { date: e.date, type: e.type || 'holiday', title: e.title, body: '', auto: true, createdAt: 0 }; n++; }
    for (const k of Object.keys(ev)) {
      const y = /^gh-(\d{4})/.exec(k);
      if ((y && h.years.includes(y[1]) && !keep.has(k)) || /^h\d{4}-\d{4}$/.test(k)) { delete ev[k]; n++; }
    }
    for (const x of h.tasks) {
      const id = x.baseId + '-story', cur = tasks[id], fresh = storyTask(x);
      if (gone.has(id)) continue;
      if (!cur) { tasks[id] = fresh; t++; }
      else if (cur.status === 'open' && (cur.holidayDate !== x.date || cur.title !== fresh.title)) { Object.assign(cur, { title: fresh.title, due: fresh.due, forMonth: fresh.forMonth, holidayDate: fresh.holidayDate, desc: fresh.desc }); t++; }
    }
    if (n) changed('events');
    if (t) changed('tasks');
    if (n || t) save();
    console.log(`Libur nasional: ${h.events.length} tanggal, ${n} perubahan, ${t} tugas story`);
  } catch (e) { console.log('Libur nasional belum bisa diambil (' + e.message + '). Dicoba lagi nanti.'); }
}

const NAME = /^[A-Za-z0-9_-]{1,80}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };

function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const send = (res, code, data, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
};

http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Teiko Planner", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Masukkan password Teiko Planner.');
    }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/api/holidays') {
      try { const h = await getHolidays(); for (const x of h.tasks) x.doc = storyTask(x); return send(res, 200, h); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const ext = EXT[(req.headers['content-type'] || '').split(';')[0]];
      if (!ext) return send(res, 415, { code: 'unsupported_type' });
      const buf = await body(req, 20 * 1024 * 1024);
      const id = crypto.randomBytes(12).toString('hex') + ext;
      fs.writeFileSync(path.join(UPLOADS, id), buf);
      return send(res, 200, { id, url: '/_blob/' + id, sizeBytes: buf.length });
    }

    if (parts[0] === '_blob' && parts.length === 2 && /^[a-f0-9]{24}\.(jpg|png|webp|gif|pdf)$/.test(parts[1])) {
      const file = path.join(UPLOADS, parts[1]);
      if (!fs.existsSync(file)) return send(res, 404, { code: 'not_found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'max-age=31536000, immutable' });
      return fs.createReadStream(file).pipe(res);
    }

    if (parts[0] === 'api' && NAME.test(parts[1] || '')) {
      const col = parts[1], id = parts[2];
      if (id !== undefined && !NAME.test(id)) return send(res, 400, { code: 'invalid_argument' });
      const c = (db[col] ??= {});
      if (req.method === 'GET' && !id) return send(res, 200, Object.entries(c).map(([k, v]) => ({ id: k, ...v })));
      if (!id) return send(res, 405, { code: 'invalid_argument' });
      if (req.method === 'DELETE') {
        if (col === 'tasks' && id.startsWith('tk-hol-')) ((db._meta ??= {}).dismissed ??= []).push(id);
        delete c[id]; save(); changed(col); return send(res, 200, {});
      }
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const data = JSON.parse((await body(req, 1024 * 1024)).toString() || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { code: 'invalid_argument' });
        delete data.id;
        if (req.method === 'PATCH' && !c[id]) return send(res, 404, { code: 'invalid_argument' });
        c[id] = req.method === 'PUT' ? data : { ...c[id], ...data };
        save(); changed(col); return send(res, 200, {});
      }
      return send(res, 405, { code: 'invalid_argument' });
    }

    // static
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(ROOT, 'public', path.normalize(rel));
    if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, e.message === 'too_large' ? 413 : 500, { code: e.message === 'too_large' ? 'too_large' : 'unavailable' });
  }
}).listen(PORT, () => {
  console.log(`Teiko Planner jalan di http://localhost:${PORT}`);
  const ips = Object.values(require('os').networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  for (const ip of ips) console.log(`Tim di WiFi yang sama: http://${ip}:${PORT}`);
  console.log(PASSWORD ? 'Password aktif.' : 'Belum ada password. Buat file password.txt sebelum membagikan alamat ke tim.');
  syncHolidays(); setInterval(syncHolidays, 24 * 3600 * 1000);
});
