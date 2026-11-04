// Teiko Planner local server: static page + tiny JSON document store + photo uploads.
// No dependencies. Run: node server.js  ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

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

// Indonesian national holidays (incl. cuti bersama) from Google's public holiday calendar, refreshed daily
const HOLIDAY_ICS = 'https://calendar.google.com/calendar/ical/id.indonesian%23holiday%40group.v.calendar.google.com/public/basic.ics';
function fetchText(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) { r.resume(); return fetchText(r.headers.location, hops + 1).then(resolve, reject); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c); r.on('end', () => resolve(d));
    }).on('error', reject).setTimeout(20000, function () { this.destroy(new Error('timeout')); });
  });
}
// one "Design ucapan <hari raya>" task per upcoming national holiday (not cuti bersama), deadline H-7
function holidayTasks(ev) {
  const tasks = (db.tasks ??= {}), gone = new Set(db._meta?.dismissed || []), today = new Date().toISOString().slice(0, 10);
  const first = {};
  for (const e of Object.values(ev)) {
    if (e.type !== 'holiday' || !e.auto || e.date < today || /^cuti bersama/i.test(e.title)) continue;
    const base = e.title.replace(/\s*\(belum pasti\)\s*/i, '').trim(), key = e.date.slice(0, 4) + '|' + base;
    if (!first[key] || e.date < first[key].date) first[key] = { date: e.date, base, tentative: /belum pasti/i.test(e.title) };
  }
  let n = 0;
  for (const [key, h] of Object.entries(first)) {
    const baseId = `tk-hol-${h.date.slice(0, 4)}-${crypto.createHash('md5').update(key).digest('hex').slice(0, 8)}`;
    const d = new Date(h.date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 7);
    const due = d.toISOString().slice(0, 10), nice = new Date(h.date + 'T00:00:00Z').toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    // two deliverables per holiday: Instagram feed post + Instagram story
    for (const [suffix, kind, title, what] of [['-story', 'story', `Design story Instagram ${h.base}`, 'story Instagram Teiko (1080 × 1920 px)']]) {  // holiday greetings are story-only
      const id = baseId + suffix;
      if (gone.has(id)) continue;
      const desc = `Hari libur nasional: ${h.base}, ${nice}${h.tentative ? ' (tanggal belum pasti)' : ''}.\nSiapkan design ucapan untuk ${what}.`;
      const t = tasks[id];
      if (!t) { tasks[id] = { kind, title, due, forMonth: h.date.slice(0, 7), holidayDate: h.date, need: 1, desc, files: [], status: 'open', auto: true, createdAt: Date.now() }; n++; }
      else if (t.status === 'open' && (t.holidayDate !== h.date || t.title !== title)) { Object.assign(t, { title, due, forMonth: h.date.slice(0, 7), holidayDate: h.date, desc }); n++; }  // date confirmed/shifted or wording updated
    }
  }
  return n;
}
async function syncHolidays() {
  try {
    const ics = (await fetchText(HOLIDAY_ICS)).replace(/\r?\n[ \t]/g, '');
    const ev = (db.events ??= {}), keep = new Set(), years = new Set();
    let n = 0;
    for (const b of ics.split('BEGIN:VEVENT').slice(1)) {
      const d = b.match(/DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/), t = (b.match(/SUMMARY:(.*)/) || [])[1];
      if (!d || !t || !/Hari libur nasional/.test(b)) continue;
      const title = t.trim().replace(/\\([,;\\])/g, '$1').replace(/^Joint Holiday for Good Friday$/i, 'Cuti Bersama Wafat Isa Almasih').replace(/^Joint Holiday for /i, 'Cuti Bersama '), date = `${d[1]}-${d[2]}-${d[3]}`;
      const id = `gh-${d[1]}${d[2]}${d[3]}-${crypto.createHash('md5').update(title).digest('hex').slice(0, 6)}`;
      keep.add(id); years.add(d[1]);
      if (ev[id]?.title === title) continue;
      ev[id] = { date, type: 'holiday', title, body: '', auto: true, createdAt: 0 }; n++;
    }
    if (!keep.size) throw new Error('kalender kosong');
    for (const k of Object.keys(ev)) {
      const old = /^gh-(\d{4})/.exec(k);
      if ((old && years.has(old[1]) && !keep.has(k)) || /^h\d{4}-\d{4}$/.test(k)) { delete ev[k]; n++; }  // renamed/removed dates + the old hand-typed list
    }
    const t = holidayTasks(ev);
    if (n) changed('events');
    if (t) changed('tasks');
    if (n || t) save();
    console.log(`Libur nasional: ${keep.size} tanggal, ${n} perubahan, ${t} tugas design ucapan`);
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
