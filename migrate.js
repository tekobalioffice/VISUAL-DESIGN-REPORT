// One-time copy of the local data (data/db.json + data/uploads) to Supabase.
// Run: node migrate.js <email> <password>   (a team account made in Supabase > Authentication)
const fs = require('fs');
const path = require('path');

const cfg = fs.readFileSync(path.join(__dirname, 'public/config.js'), 'utf8');
const URL_ = cfg.match(/url:\s*'([^']+)'/)[1], KEY = cfg.match(/key:\s*'([^']+)'/)[1];
const [email, password] = process.argv.slice(2);
if (!email || !password) { console.log('Pakai: node migrate.js <email> <password>'); process.exit(1); }

const TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

(async () => {
  const auth = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
  })).json();
  if (!auth.access_token) throw new Error('Login gagal: ' + (auth.msg || auth.error_description || JSON.stringify(auth)));
  const h = { apikey: KEY, Authorization: 'Bearer ' + auth.access_token };

  const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/db.json'), 'utf8'));
  const rows = [];
  for (const [col, docs] of Object.entries(db)) {
    if (col === '_meta') continue;
    for (const [id, data] of Object.entries(docs)) rows.push({ col, id, data });
  }
  for (const id of db._meta?.dismissed || []) rows.push({ col: '_dismissed', id, data: {} });

  const r = await fetch(`${URL_}/rest/v1/docs?on_conflict=col,id`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error('Simpan data gagal: ' + await r.text());
  console.log(`${rows.length} data dipindahkan.`);

  const dir = path.join(__dirname, 'data/uploads');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const u = await fetch(`${URL_}/storage/v1/object/uploads/${f}`, {
      method: 'POST', headers: { ...h, 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'x-upsert': 'false' },
      body: fs.readFileSync(path.join(dir, f))
    });
    console.log(f, u.ok ? 'ok' : (u.status === 409 || u.status === 400 ? 'sudah ada' : 'GAGAL ' + await u.text()));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
