'use strict';
// Сайт личного кабинета Capt DM: вход по нику/паролю игрового аккаунта, загрузка своей музыки.
require('dotenv').config(); // подхватывает переменные из .env рядом с server.js (если файл есть)
const express = require('express');
const multer = require('multer');
const mysql = require('mysql2/promise');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cfg = {
  port: +process.env.PORT || 3000,
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'capt',
  },
  secret: process.env.SESSION_SECRET || '',
  maxFile: (+process.env.MAX_FILE_MB || 25) * 1024 * 1024,
  maxTracks: +process.env.MAX_TRACKS || 30,
  maxTotal: (+process.env.MAX_TOTAL_MB || 300) * 1024 * 1024,
};
if (cfg.secret.length < 16) {
  console.error('Задайте SESSION_SECRET (минимум 16 символов) в .env / переменных окружения.');
  process.exit(1);
}

const UP = path.join(__dirname, 'uploads');
fs.mkdirSync(UP, { recursive: true });
const pool = mysql.createPool({ ...cfg.db, waitForConnections: true, connectionLimit: 8, charset: 'cp1251_general_ci' });

// ---------- сессии: подписанная cookie ----------
const COOKIE = 'capt_sid';
const sign = (v) => crypto.createHmac('sha256', cfg.secret).update(v).digest('hex');
function makeToken(name) {
  const body = Buffer.from(JSON.stringify({ n: name, e: Date.now() + 7 * 864e5 })).toString('base64url');
  return body + '.' + sign(body);
}
function readToken(tok) {
  if (!tok) return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o.e > Date.now() ? o.n : null;
  } catch { return null; }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function auth(req, res, next) {
  const n = readToken(cookies(req)[COOKIE]);
  if (!n) return res.status(401).json({ error: 'Требуется вход' });
  req.user = n;
  next();
}

// ---------- проверка пароля (как в игре: SHA256(пароль + соль), HEX заглавными) ----------
function gameHash(password, salt) {
  return crypto.createHash('sha256').update(Buffer.concat([iconv.encode(password, 'win1251'), iconv.encode(salt, 'win1251')])).digest('hex').toUpperCase();
}

// ---------- защита от перебора ----------
const tries = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (tries.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  tries.set(ip, a);
  return a.length >= 10;
}
const noteTry = (ip) => tries.set(ip, [...(tries.get(ip) || []), Date.now()]);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Слишком много попыток. Подождите 10 минут.' });
  const name = String((req.body || {}).name || '').trim();
  const password = String((req.body || {}).password || '');
  if (!/^[A-Za-z0-9_\[\]\.\$=@\(\)]{3,24}$/.test(name) || !password || password.length > 64)
    return res.status(400).json({ error: 'Неверный ник или пароль' });
  try {
    const [rows] = await pool.query('SELECT name, pass, salt, elo, wins, losses, kills, deaths FROM accounts WHERE name = ? LIMIT 1', [name]);
    noteTry(ip);
    const r = rows[0];
    const ok = r && (() => {
      const a = Buffer.from(gameHash(password, r.salt)), b = Buffer.from(String(r.pass).toUpperCase());
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })();
    if (!ok) return res.status(401).json({ error: 'Неверный ник или пароль' });
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken(r.name))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${req.secure ? '; Secure' : ''}`);
    res.json({ ok: true, name: r.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT name, elo, wins, losses, kills, deaths, reg_date, last_login FROM accounts WHERE name = ?', [req.user]);
    if (!rows[0]) return res.status(401).json({ error: 'Аккаунт не найден' });
    const [t] = await pool.query('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM audio_tracks WHERE owner = ?', [req.user]);
    res.json({ ...rows[0], tracks: t[0].c, used: Number(t[0].s), limits: { maxTracks: cfg.maxTracks, maxTotal: cfg.maxTotal, maxFile: cfg.maxFile } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/tracks', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, title, file, size, created FROM audio_tracks WHERE owner = ? ORDER BY id DESC', [req.user]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (_r, _f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.tmp'),
  }),
  limits: { fileSize: cfg.maxFile, files: 1 },
});

function detectExt(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  if (b.slice(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return '.mp3';
  if (b.toString() === 'OggS') return '.ogg';
  return null;
}

app.post('/api/tracks', auth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    const f = req.file;
    const drop = () => { if (f) fs.unlink(f.path, () => {}); };
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${cfg.maxFile / 1048576} МБ` : 'Ошибка загрузки' });
    if (!f) return res.status(400).json({ error: 'Файл не выбран' });
    try {
      const ext = detectExt(f.path);
      if (!ext) { drop(); return res.status(400).json({ error: 'Поддерживаются только MP3 и OGG' }); }
      const [t] = await pool.query('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM audio_tracks WHERE owner = ?', [req.user]);
      if (t[0].c >= cfg.maxTracks) { drop(); return res.status(400).json({ error: `Лимит треков: ${cfg.maxTracks}` }); }
      if (Number(t[0].s) + f.size > cfg.maxTotal) { drop(); return res.status(400).json({ error: 'Превышен лимит места' }); }
      let title = String(req.body.title || '').trim() || path.parse(Buffer.from(f.originalname, 'latin1').toString('utf8')).name;
      title = title.replace(/[\x00-\x1f]/g, '').slice(0, 60);
      const name = path.basename(f.path, '.tmp') + ext;
      fs.renameSync(f.path, path.join(UP, name));
      const [r] = await pool.query('INSERT INTO audio_tracks (owner, title, file, size) VALUES (?, ?, ?, ?)', [req.user, title, name, f.size]);
      res.json({ ok: true, id: r.insertId });
    } catch (e) { drop(); console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
  });
});

app.patch('/api/tracks/:id', auth, async (req, res) => {
  const title = String((req.body || {}).title || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60);
  if (!title) return res.status(400).json({ error: 'Пустое название' });
  try {
    const [r] = await pool.query('UPDATE audio_tracks SET title = ? WHERE id = ? AND owner = ?', [title, +req.params.id, req.user]);
    res.json({ ok: r.affectedRows > 0 });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/tracks/:id', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT file FROM audio_tracks WHERE id = ? AND owner = ?', [+req.params.id, req.user]);
    if (!rows[0]) return res.status(404).json({ error: 'Не найдено' });
    await pool.query('DELETE FROM audio_tracks WHERE id = ? AND owner = ?', [+req.params.id, req.user]);
    fs.unlink(path.join(UP, path.basename(rows[0].file)), () => {});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Публичная раздача файлов (по случайным именам) — именно по этим ссылкам играет игровой сервер
app.use('/files', express.static(UP, { index: false, dotfiles: 'deny', maxAge: '7d', setHeaders: (r) => r.setHeader('Accept-Ranges', 'bytes') }));
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS audio_tracks (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    owner VARCHAR(24) NOT NULL,
    title VARCHAR(60) NOT NULL,
    file VARCHAR(64) NOT NULL,
    size INT UNSIGNED NOT NULL DEFAULT 0,
    created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY owner (owner)
  ) ENGINE=InnoDB DEFAULT CHARSET=cp1251`);
  app.listen(cfg.port, () => console.log('Capt audio site: порт ' + cfg.port));
})().catch((e) => { console.error('Не удалось подключиться к MySQL:', e.message); process.exit(1); });
