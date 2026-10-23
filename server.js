'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ── Настройки альбома ─────────────────────────────────────────────
const CONFIG = {
  names: ['Данияр', 'Кадиша'],
  startDate: '2025-01-12', // «день 1»
};

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// Всё, что нужно для бэкапа, лежит в одной папке data/
const DATA_DIR = process.env.ALBUM_DATA_DIR || path.join(ROOT, 'data');
const MEDIA_DIRS = {
  original: path.join(DATA_DIR, 'media', 'original'),
  full: path.join(DATA_DIR, 'media', 'full'),
  thumb: path.join(DATA_DIR, 'media', 'thumb'),
};
for (const dir of Object.values(MEDIA_DIRS)) fs.mkdirSync(dir, { recursive: true });

// ── База данных ───────────────────────────────────────────────────
const db = new DatabaseSync(path.join(DATA_DIR, 'album.db'));
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS photos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    hash          TEXT UNIQUE,
    taken_at      TEXT NOT NULL,              -- 'YYYY-MM-DDTHH:MM:SS', местное время съёмки
    date_source   TEXT NOT NULL DEFAULT 'exif', -- exif | file | manual | upload
    width         INTEGER NOT NULL,
    height        INTEGER NOT NULL,
    original_file TEXT,
    original_name TEXT,
    full_file     TEXT NOT NULL,
    thumb_file    TEXT NOT NULL,
    caption       TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at);

  CREATE TABLE IF NOT EXISTS days (
    date  TEXT PRIMARY KEY,
    title TEXT NOT NULL
  );
`);

const stmt = {
  listPhotos: db.prepare('SELECT * FROM photos ORDER BY taken_at, id'),
  getPhoto: db.prepare('SELECT * FROM photos WHERE id = ?'),
  getByHash: db.prepare('SELECT * FROM photos WHERE hash = ?'),
  insertPhoto: db.prepare(`
    INSERT INTO photos (hash, taken_at, date_source, width, height, original_file, original_name, full_file, thumb_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updatePhoto: db.prepare('UPDATE photos SET caption = ?, taken_at = ?, date_source = ? WHERE id = ?'),
  deletePhoto: db.prepare('DELETE FROM photos WHERE id = ?'),
  listDays: db.prepare('SELECT date, title FROM days'),
  upsertDay: db.prepare(
    'INSERT INTO days (date, title) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET title = excluded.title'
  ),
  deleteDay: db.prepare('DELETE FROM days WHERE date = ?'),
};

// ── Утилиты ───────────────────────────────────────────────────────
const TAKEN_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_SOURCES = new Set(['exif', 'file', 'manual', 'upload']);
const ORIGINAL_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.avif', '.tif', '.tiff', '.dng',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(httpError(413, 'Файл слишком большой'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw httpError(400, 'Некорректный JSON');
  }
}

function mediaPaths(photo) {
  const list = [path.join(MEDIA_DIRS.full, photo.full_file), path.join(MEDIA_DIRS.thumb, photo.thumb_file)];
  if (photo.original_file) list.push(path.join(MEDIA_DIRS.original, photo.original_file));
  return list;
}

function removeFiles(files) {
  return Promise.all(files.map((f) => fsp.unlink(f).catch(() => {})));
}

// ── Загрузка фото ─────────────────────────────────────────────────
// Тело запроса = оригинал + веб-версия (JPEG) + превью (JPEG), склеенные подряд.
// Размеры частей и метаданные приходят в заголовке X-Meta.
async function createPhoto(req, res) {
  let meta;
  try {
    meta = JSON.parse(decodeURIComponent(req.headers['x-meta'] || ''));
  } catch {
    throw httpError(400, 'Нет метаданных фото');
  }

  const sizes = Array.isArray(meta.sizes) ? meta.sizes.map(Number) : [];
  if (sizes.length !== 3 || sizes.some((n) => !Number.isInteger(n) || n < 0) || !sizes[1] || !sizes[2]) {
    throw httpError(400, 'Некорректные размеры файла');
  }
  if (!TAKEN_AT_RE.test(meta.taken_at || '')) throw httpError(400, 'Некорректная дата съёмки');
  const width = Math.round(Number(meta.width));
  const height = Math.round(Number(meta.height));
  if (!(width > 0 && height > 0)) throw httpError(400, 'Некорректные размеры изображения');

  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (body.length !== sizes[0] + sizes[1] + sizes[2]) throw httpError(400, 'Файл пришёл не полностью');

  const original = body.subarray(0, sizes[0]);
  const full = body.subarray(sizes[0], sizes[0] + sizes[1]);
  const thumb = body.subarray(sizes[0] + sizes[1]);

  const hash = crypto.createHash('sha256').update(sizes[0] ? original : full).digest('hex');
  const existing = stmt.getByHash.get(hash);
  if (existing) return sendJson(res, 409, { error: 'Это фото уже есть в альбоме', photo: existing });

  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  const originalName = String(meta.original_name || '').slice(0, 200);
  let ext = path.extname(originalName).toLowerCase();
  if (!ORIGINAL_EXTS.has(ext)) ext = '.bin';

  const files = {
    original: sizes[0] ? `${id}${ext}` : null,
    full: `${id}.jpg`,
    thumb: `${id}.jpg`,
  };
  const written = [path.join(MEDIA_DIRS.full, files.full), path.join(MEDIA_DIRS.thumb, files.thumb)];
  if (files.original) written.push(path.join(MEDIA_DIRS.original, files.original));

  await Promise.all([
    fsp.writeFile(written[0], full),
    fsp.writeFile(written[1], thumb),
    files.original ? fsp.writeFile(written[2], original) : null,
  ]);

  const source = DATE_SOURCES.has(meta.date_source) ? meta.date_source : 'upload';
  let result;
  try {
    result = stmt.insertPhoto.run(
      hash, meta.taken_at, source, width, height, files.original, originalName, files.full, files.thumb
    );
  } catch (err) {
    await removeFiles(written);
    if (/UNIQUE/i.test(err.message)) {
      return sendJson(res, 409, { error: 'Это фото уже есть в альбоме', photo: stmt.getByHash.get(hash) });
    }
    throw err;
  }
  return sendJson(res, 201, stmt.getPhoto.get(result.lastInsertRowid));
}

// ── API ───────────────────────────────────────────────────────────
async function routeApi(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/config' && method === 'GET') return sendJson(res, 200, CONFIG);
  if (pathname === '/api/photos' && method === 'GET') return sendJson(res, 200, stmt.listPhotos.all());
  if (pathname === '/api/photos' && method === 'POST') return createPhoto(req, res);

  if (pathname === '/api/days' && method === 'GET') {
    const out = {};
    for (const row of stmt.listDays.all()) out[row.date] = row.title;
    return sendJson(res, 200, out);
  }

  let match = /^\/api\/photos\/(\d+)$/.exec(pathname);
  if (match) {
    const photo = stmt.getPhoto.get(Number(match[1]));
    if (!photo) throw httpError(404, 'Фото не найдено');

    if (method === 'PATCH') {
      const body = await readJson(req);
      let { caption, taken_at: takenAt, date_source: source } = photo;
      if (typeof body.caption === 'string') caption = body.caption.trim().slice(0, 300);
      if (body.taken_at !== undefined) {
        if (!TAKEN_AT_RE.test(String(body.taken_at))) throw httpError(400, 'Некорректная дата');
        takenAt = body.taken_at;
        source = 'manual';
      }
      stmt.updatePhoto.run(caption, takenAt, source, photo.id);
      return sendJson(res, 200, stmt.getPhoto.get(photo.id));
    }

    if (method === 'DELETE') {
      stmt.deletePhoto.run(photo.id);
      await removeFiles(mediaPaths(photo));
      return sendJson(res, 200, { ok: true, id: photo.id });
    }
  }

  match = /^\/api\/days\/(\d{4}-\d{2}-\d{2})$/.exec(pathname);
  if (match && method === 'PUT') {
    const body = await readJson(req);
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    if (title) stmt.upsertDay.run(match[1], title);
    else stmt.deleteDay.run(match[1]);
    return sendJson(res, 200, { date: match[1], title });
  }

  throw httpError(404, 'Не найдено');
}

// ── Файлы ─────────────────────────────────────────────────────────
function serveFile(res, filePath, cacheControl) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveMedia(res, pathname) {
  const match = /^\/media\/(original|full|thumb)\/([\w.-]+)$/.exec(pathname);
  if (!match) throw httpError(404, 'Не найдено');
  // Имена файлов уникальны и не меняются — можно кэшировать навсегда
  serveFile(res, path.join(MEDIA_DIRS[match[1]], match[2]), 'public, max-age=31536000, immutable');
}

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    throw httpError(400, 'Некорректный адрес');
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw httpError(403, 'Запрещено');
  serveFile(res, filePath, 'no-cache');
}

// ── Сервер ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return await routeApi(req, res, pathname);
    if (pathname.startsWith('/media/')) return serveMedia(res, pathname);
    return serveStatic(res, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Ошибка сервера' });
    else res.end();
  }
});

module.exports = { server, db, CONFIG };

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Альбом: http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const addr of list || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`  в домашней сети: http://${addr.address}:${PORT}`);
        }
      }
    }
  });
}
