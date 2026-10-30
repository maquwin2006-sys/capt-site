'use strict';
// Сайт личного кабинета Capt DM: вход по нику/паролю игрового аккаунта, загрузка своей музыки.
// Работает на Vercel (как функция) и на обычном сервере (node server.js).
// Музыка хранится в Vercel Blob: браузер грузит файл прямо туда, сервер только выдаёт токен
// и записывает трек в базу. Игра берёт музыку по ссылке <сайт>/files/<файл> — сайт перенаправляет на Blob.
require('dotenv').config(); // подхватывает переменные из .env рядом с server.js (если файл есть)
const express = require('express');
const mysql = require('mysql2/promise');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const path = require('path');
const { head, del } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');

const cfg = {
  port: +process.env.PORT || 3000,
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'capt',
  },
  // DB_SSL=1 — шифровать подключение к MySQL (обязательно, если база доступна из интернета)
  ssl: process.env.DB_SSL === '1',
  // Ключ подписи входа. Если SESSION_SECRET не задан — выводится из секрета хранилища Blob,
  // который Vercel добавляет сам при подключении хранилища (так настраивать вручную нечего).
  secret: process.env.SESSION_SECRET || (process.env.BLOB_READ_WRITE_TOKEN
    ? crypto.createHmac('sha256', process.env.BLOB_READ_WRITE_TOKEN).update('capt-session-key').digest('hex') : ''),
  maxFile: (+process.env.MAX_FILE_MB || 25) * 1024 * 1024,
  maxTracks: +process.env.MAX_TRACKS || 20,   // в игре меню показывает до 20 треков
  maxTotal: (+process.env.MAX_TOTAL_MB || 300) * 1024 * 1024,
};
const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'application/ogg'];

// Не падаем при запуске, а честно говорим, чего не хватает (на Vercel падение = FUNCTION_INVOCATION_FAILED)
function configProblem() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return 'Сайт не настроен: подключите к проекту хранилище Vercel Blob (Storage → Blob).';
  if (cfg.secret.length < 16) return 'SESSION_SECRET слишком короткий: нужно минимум 16 символов (или удалите его совсем).';
  return null;
}

// ---------- база (ленивое подключение: функция Vercel поднимается на каждый холодный запуск) ----------
let pool = null, schemaReady = null;
function db() {
  if (!pool) {
    pool = mysql.createPool({
      ...cfg.db,
      waitForConnections: true,
      connectionLimit: process.env.VERCEL ? 2 : 8,
      connectTimeout: 8000,
      charset: 'cp1251_general_ci',
      ssl: cfg.ssl ? { rejectUnauthorized: !!process.env.DB_SSL_CA, ca: process.env.DB_SSL_CA || undefined } : undefined,
    });
  }
  return pool;
}
// Таблица и столбцы, которых может не быть (гейммод создаёт их сам; это на случай, если сайт запущен раньше)
async function ensureSchema() {
  const q = (s, a) => db().query(s, a);
  await q(`CREATE TABLE IF NOT EXISTS audio_tracks (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    owner VARCHAR(24) NOT NULL,
    title VARCHAR(60) NOT NULL,
    artist VARCHAR(48) NOT NULL DEFAULT '',
    file VARCHAR(64) NOT NULL,
    url VARCHAR(255) NOT NULL DEFAULT '',
    size INT UNSIGNED NOT NULL DEFAULT 0,
    created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY owner (owner), KEY file (file)
  ) ENGINE=InnoDB DEFAULT CHARSET=cp1251`);
  for (const [t, c, def] of [
    ['audio_tracks', 'artist', "VARCHAR(48) NOT NULL DEFAULT ''"],
    ['audio_tracks', 'url', "VARCHAR(255) NOT NULL DEFAULT ''"],
    ['accounts', 'audio', 'TINYINT NOT NULL DEFAULT 0'],
  ]) {
    const [x] = await q('SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]);
    if (x[0].c) continue;
    // у пользователя сайта может не быть прав на ALTER — тогда столбец создаст гейммод
    try { await q(`ALTER TABLE \`${t}\` ADD COLUMN \`${c}\` ${def}`); console.log(`Добавлен столбец ${t}.${c}`); }
    catch (e) { console.warn(`Не удалось добавить ${t}.${c}: ${e.message}`); }
  }
}
function schema() {
  if (!schemaReady) schemaReady = ensureSchema().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

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
// Папка игрока в хранилище: ник в hex, чтобы любые символы ника были безопасны в пути
const userDir = (name) => 'tracks/' + Buffer.from(name, 'latin1').toString('hex') + '/';

// ---------- проверка пароля (как в игре: SHA256(пароль + соль), HEX заглавными) ----------
function gameHash(password, salt) {
  return crypto.createHash('sha256').update(Buffer.concat([iconv.encode(password, 'win1251'), iconv.encode(salt, 'win1251')])).digest('hex').toUpperCase();
}

// ---------- защита от перебора (на Vercel — в пределах одного экземпляра функции) ----------
const tries = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (tries.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  tries.set(ip, a);
  return a.length >= 10;
}
const noteTry = (ip) => tries.set(ip, [...(tries.get(ip) || []), Date.now()]);
const cleanText = (v, max) => String(v || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, max);
const fail = (res, e) => { console.error(e); res.status(500).json({ error: e && e.code === 'ETIMEDOUT' || e && e.code === 'ECONNREFUSED' ? 'Нет связи с базой игрового сервера' : 'Ошибка сервера' }); };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));

// Всё, что ниже, требует настроенного сайта и базы
app.use(['/api', '/files'], async (req, res, next) => {
  const p = configProblem();
  if (p) return res.status(503).json({ error: p });
  try { await schema(); next(); } catch (e) { fail(res, e); }
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Слишком много попыток. Подождите 10 минут.' });
  const name = String((req.body || {}).name || '').trim();
  const password = String((req.body || {}).password || '');
  if (!/^[A-Za-z0-9_\[\]\.\$=@\(\)]{3,24}$/.test(name) || !password || password.length > 64)
    return res.status(400).json({ error: 'Неверный ник или пароль' });
  try {
    const [rows] = await db().query('SELECT name, pass, salt FROM accounts WHERE name = ? LIMIT 1', [name]);
    noteTry(ip);
    const r = rows[0];
    const ok = r && (() => {
      const a = Buffer.from(gameHash(password, r.salt)), b = Buffer.from(String(r.pass).toUpperCase());
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })();
    if (!ok) return res.status(401).json({ error: 'Неверный ник или пароль' });
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken(r.name))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${req.secure ? '; Secure' : ''}`);
    res.json({ ok: true, name: r.name });
  } catch (e) { fail(res, e); }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const [rows] = await db().query('SELECT id, name, elo, wins, losses, kills, deaths, money, skin, donate, fitness, admin, audio, reg_date, last_login FROM accounts WHERE name = ?', [req.user]);
    if (!rows[0]) return res.status(401).json({ error: 'Аккаунт не найден' });
    const [t] = await db().query('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM audio_tracks WHERE owner = ?', [req.user]);
    res.json({ ...rows[0], dir: userDir(req.user), tracks: t[0].c, used: Number(t[0].s), limits: { maxTracks: cfg.maxTracks, maxTotal: cfg.maxTotal, maxFile: cfg.maxFile } });
  } catch (e) { fail(res, e); }
});

app.get('/api/tracks', auth, async (req, res) => {
  try {
    const [rows] = await db().query('SELECT id, title, artist, file, size, created FROM audio_tracks WHERE owner = ? ORDER BY id DESC', [req.user]);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// Можно ли загрузить ещё size байт (null — можно, иначе текст ошибки)
async function uploadProblem(user, size) {
  const [acc] = await db().query('SELECT audio FROM accounts WHERE name = ?', [user]);
  if (!acc[0] || !acc[0].audio) return 'Сначала установите аудиосистему: в игре сядьте за руль и введите /makeaudio';
  const [t] = await db().query('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM audio_tracks WHERE owner = ?', [user]);
  if (t[0].c >= cfg.maxTracks) return `Лимит треков: ${cfg.maxTracks}`;
  if (Number(t[0].s) + size > cfg.maxTotal) return 'Превышен лимит места';
  return null;
}

// 1) Токен для загрузки из браузера прямо в Blob (так обходится лимит Vercel 4,5 МБ на запрос)
app.post('/api/upload', auth, async (req, res) => {
  try {
    const out = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(userDir(req.user)) || !/^[a-z0-9]+\.(mp3|ogg)$/.test(pathname.slice(userDir(req.user).length)))
          throw new Error('Неверное имя файла');
        const p = await uploadProblem(req.user, 0);
        if (p) throw new Error(p);
        return { allowedContentTypes: AUDIO_TYPES, maximumSizeInBytes: cfg.maxFile, addRandomSuffix: true, tokenPayload: req.user };
      },
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось начать загрузку' });
  }
});

// Первые байты файла: MP3 (ID3 или кадр) или OGG
async function looksLikeAudio(url) {
  const r = await fetch(url, { headers: { Range: 'bytes=0-3' } });
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length < 4) return false;
  return b.slice(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || b.toString('latin1', 0, 4) === 'OggS';
}

// 2) Браузер загрузил файл — проверяем его и записываем трек в базу
app.post('/api/tracks/commit', auth, async (req, res) => {
  const url = String((req.body || {}).url || '');
  let info;
  try { info = await head(url); } catch { return res.status(400).json({ error: 'Файл не найден в хранилище' }); }
  const dropBlob = () => del(info.url).catch(() => {});
  try {
    if (!info.pathname.startsWith(userDir(req.user))) return res.status(403).json({ error: 'Чужой файл' });
    const [dup] = await db().query('SELECT id FROM audio_tracks WHERE url = ?', [info.url]);
    if (dup[0]) return res.json({ ok: true, id: dup[0].id });
    const p = await uploadProblem(req.user, info.size);
    if (p) { await dropBlob(); return res.status(400).json({ error: p }); }
    if (info.size > cfg.maxFile || !(await looksLikeAudio(info.url))) { await dropBlob(); return res.status(400).json({ error: 'Поддерживаются только MP3 и OGG' }); }
    const title = cleanText(req.body.title, 60) || 'Без названия';
    const artist = cleanText(req.body.artist, 48);
    const file = path.posix.basename(info.pathname).slice(0, 64);
    const [r] = await db().query('INSERT INTO audio_tracks (owner, title, artist, file, url, size) VALUES (?, ?, ?, ?, ?, ?)', [req.user, title, artist, file, info.url, info.size]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { fail(res, e); }
});

app.patch('/api/tracks/:id', auth, async (req, res) => {
  const title = cleanText((req.body || {}).title, 60), artist = cleanText((req.body || {}).artist, 48);
  if (!title) return res.status(400).json({ error: 'Пустое название' });
  try {
    const [r] = await db().query('UPDATE audio_tracks SET title = ?, artist = ? WHERE id = ? AND owner = ?', [title, artist, +req.params.id, req.user]);
    res.json({ ok: r.affectedRows > 0 });
  } catch (e) { fail(res, e); }
});

app.delete('/api/tracks/:id', auth, async (req, res) => {
  try {
    const [rows] = await db().query('SELECT url FROM audio_tracks WHERE id = ? AND owner = ?', [+req.params.id, req.user]);
    if (!rows[0]) return res.status(404).json({ error: 'Не найдено' });
    await db().query('DELETE FROM audio_tracks WHERE id = ? AND owner = ?', [+req.params.id, req.user]);
    if (rows[0].url) await del(rows[0].url).catch((e) => console.error('blob del', e.message));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Смена пароля (тот же формат, что в игре: SHA256(пароль + соль), новая соль из 16 символов)
app.post('/api/password', auth, async (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Слишком много попыток. Подождите 10 минут.' });
  const old = String((req.body || {}).old || ''), next = String((req.body || {}).next || '');
  if (next.length < 4 || next.length > 32 || /\s/.test(next)) return res.status(400).json({ error: 'Новый пароль: от 4 до 32 символов, без пробелов' });
  try {
    const [rows] = await db().query('SELECT pass, salt FROM accounts WHERE name = ?', [req.user]);
    noteTry(ip);
    const r = rows[0];
    if (!r || gameHash(old, r.salt) !== String(r.pass).toUpperCase()) return res.status(401).json({ error: 'Текущий пароль указан неверно' });
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const salt = Array.from(crypto.randomBytes(16), (b) => abc[b % abc.length]).join('');
    await db().query('UPDATE accounts SET pass = ?, salt = ? WHERE name = ?', [gameHash(next, salt), salt, req.user]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Ссылки для игры: <сайт>/files/<файл> -> адрес файла в Blob (формат ссылок в гейммоде не меняется)
app.get('/files/:file', async (req, res) => {
  try {
    const [rows] = await db().query('SELECT url FROM audio_tracks WHERE file = ? LIMIT 1', [req.params.file]);
    if (!rows[0] || !rows[0].url) return res.status(404).send('Not found');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.redirect(302, rows[0].url);
  } catch (e) { fail(res, e); }
});

// Страница кабинета. На Vercel файлы из public/ отдаёт сам Vercel (внутри функции их нет),
// поэтому там корень просто ведёт на /index.html; при запуске через node — обычная раздача файлов.
if (process.env.VERCEL) {
  app.get('/', (req, res) => res.redirect(302, '/index.html'));
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

module.exports = app;

if (require.main === module) {
  const p = configProblem();
  if (p) console.warn(p);
  app.listen(cfg.port, () => console.log('Capt audio site: порт ' + cfg.port));
}
