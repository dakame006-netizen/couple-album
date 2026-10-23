(() => {
  'use strict';

  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

  const UPLOAD_CONCURRENCY = 2;
  const FULL_MAX_SIDE = 2048;
  const THUMB_MAX_SIDE = 800;

  const SUPABASE_CONFIG = {
    url: 'https://yhowzodbnytqadgadwbc.supabase.co',
    anonKey: 'sb_publishable_KrzuoSqfvB9kMEHiqDqSzw_lQSTd-ot',
    bucket: 'photos'
  };

  const state = {
    mode: 'supabase', // 'supabase' (общее облако) | 'server' (localhost) | 'idb' (локально)
    config: { names: ['Данияр', 'Кадиша'], startDate: '2025-01-12' },
    photos: [],
    days: {},
    order: localStorage.getItem('album.order') === 'desc' ? 'desc' : 'asc',
    searchQuery: '',
    grids: new Map(), // grid element → photos of that day
    lbIndex: -1,
    lastWidth: 0,
  };

  const $ = (id) => document.getElementById(id);

  // ── Облачное хранилище Supabase (синхронизация между всеми телефонами и ПК) ──
  const supabaseStore = (() => {
    const headers = () => ({
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
    });

    async function listPhotos() {
      const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/photos?select=*&order=taken_at.asc,id.asc`, {
        headers: headers()
      });
      if (!res.ok) throw new Error('Supabase photos fetch failed');
      const data = await res.json();
      return (data || []).map(p => ({
        id: p.id,
        hash: p.hash,
        taken_at: p.taken_at,
        date_source: p.date_source || 'exif',
        width: p.width,
        height: p.height,
        original_name: p.original_name || 'photo.jpg',
        caption: p.caption || '',
        thumbUrl: p.thumb_url,
        fullUrl: p.full_url,
        originalUrl: p.original_url || p.full_url
      }));
    }

    async function uploadBlob(path, blob, contentType) {
      const res = await fetch(`${SUPABASE_CONFIG.url}/storage/v1/object/${SUPABASE_CONFIG.bucket}/${path}`, {
        method: 'POST',
        headers: {
          ...headers(),
          'Content-Type': contentType,
          'x-upsert': 'true'
        },
        body: blob
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Upload to storage failed: ${err}`);
      }
      return `${SUPABASE_CONFIG.url}/storage/v1/object/public/${SUPABASE_CONFIG.bucket}/${path}`;
    }

    async function addPhoto({ hash, takenAt, source, full, thumb, file }) {
      const idPrefix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const thumbPath = `thumb/${idPrefix}.jpg`;
      const fullPath = `full/${idPrefix}.jpg`;
      const origExt = (file.name.match(/\.[^.]+$/) || ['.jpg'])[0].toLowerCase();
      const origPath = `orig/${idPrefix}${origExt}`;

      const [thumbUrl, fullUrl, originalUrl] = await Promise.all([
        uploadBlob(thumbPath, thumb.blob, 'image/jpeg'),
        uploadBlob(fullPath, full.blob, 'image/jpeg'),
        uploadBlob(origPath, file, file.type || 'image/jpeg')
      ]);

      const insertRes = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/photos`, {
        method: 'POST',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          hash,
          taken_at: takenAt,
          date_source: source,
          width: full.width,
          height: full.height,
          original_name: file.name,
          caption: '',
          thumb_url: thumbUrl,
          full_url: fullUrl,
          original_url: originalUrl
        })
      });

      if (!insertRes.ok) {
        const err = await insertRes.text();
        throw new Error(`Failed to insert record: ${err}`);
      }

      const rows = await insertRes.json();
      const p = rows[0];
      return {
        id: p.id,
        hash: p.hash,
        taken_at: p.taken_at,
        date_source: p.date_source,
        width: p.width,
        height: p.height,
        original_name: p.original_name,
        caption: p.caption || '',
        thumbUrl: p.thumb_url,
        fullUrl: p.full_url,
        originalUrl: p.original_url
      };
    }

    async function updatePhoto(id, patch) {
      const updateData = {};
      if (typeof patch.caption === 'string') updateData.caption = patch.caption.trim().slice(0, 300);
      if (patch.taken_at !== undefined) {
        updateData.taken_at = patch.taken_at;
        updateData.date_source = 'manual';
      }

      const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/photos?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(updateData)
      });
      if (!res.ok) throw new Error('Update failed');
      const rows = await res.json();
      return rows[0];
    }

    async function deletePhoto(id) {
      const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/photos?id=eq.${id}`, {
        method: 'DELETE',
        headers: headers()
      });
      if (!res.ok) throw new Error('Delete failed');
      return { ok: true, id };
    }

    async function listDays() {
      const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/days?select=*`, {
        headers: headers()
      });
      if (!res.ok) return {};
      const data = await res.json();
      const out = {};
      for (const row of data || []) out[row.date] = row.title;
      return out;
    }

    async function setDay(date, rawTitle) {
      const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 120) : '';
      if (!title) {
        await fetch(`${SUPABASE_CONFIG.url}/rest/v1/days?date=eq.${date}`, {
          method: 'DELETE',
          headers: headers()
        });
        return { date, title: '' };
      }

      const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/days`, {
        method: 'POST',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify({ date, title })
      });
      return { date, title };
    }

    return { listPhotos, addPhoto, updatePhoto, deletePhoto, listDays, setDay };
  })();

  // ── Локальная база IndexedDB (для работы на Vercel / GitHub Pages без бэкенда) ──
  const idbStore = (() => {
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('daniar_kadisha_album_v1', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('photos')) {
            const ps = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
            ps.createIndex('hash', 'hash', { unique: false });
          }
          if (!db.objectStoreNames.contains('days')) {
            db.createObjectStore('days', { keyPath: 'date' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }

    function hydratePhotoUrls(rec) {
      return {
        id: rec.id,
        hash: rec.hash,
        taken_at: rec.taken_at,
        date_source: rec.date_source || 'exif',
        width: rec.width,
        height: rec.height,
        original_name: rec.original_name || 'photo.jpg',
        caption: rec.caption || '',
        thumbUrl: rec.thumbBlob ? URL.createObjectURL(rec.thumbBlob) : '',
        fullUrl: rec.fullBlob ? URL.createObjectURL(rec.fullBlob) : '',
        originalUrl: rec.originalBlob ? URL.createObjectURL(rec.originalBlob) : '',
      };
    }

    async function listPhotos() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readonly');
        const req = tx.objectStore('photos').getAll();
        req.onsuccess = () => resolve((req.result || []).map(hydratePhotoUrls));
        req.onerror = () => reject(req.error);
      });
    }

    async function addPhoto(record) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        const store = tx.objectStore('photos');
        const req = store.add(record);
        req.onsuccess = () => {
          const saved = { ...record, id: req.result };
          resolve(hydratePhotoUrls(saved));
        };
        req.onerror = () => reject(req.error);
      });
    }

    async function updatePhoto(id, patch) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        const store = tx.objectStore('photos');
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return reject(new Error('Фото не найдено'));
          if (typeof patch.caption === 'string') existing.caption = patch.caption.trim().slice(0, 300);
          if (patch.taken_at !== undefined) {
            existing.taken_at = patch.taken_at;
            existing.date_source = 'manual';
          }
          const putReq = store.put(existing);
          putReq.onsuccess = () => resolve({
            id: existing.id,
            caption: existing.caption,
            taken_at: existing.taken_at,
            date_source: existing.date_source,
          });
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    }

    async function deletePhoto(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        const req = tx.objectStore('photos').delete(id);
        req.onsuccess = () => resolve({ ok: true, id });
        req.onerror = () => reject(req.error);
      });
    }

    async function listDays() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('days', 'readonly');
        const req = tx.objectStore('days').getAll();
        req.onsuccess = () => {
          const out = {};
          for (const row of req.result || []) out[row.date] = row.title;
          resolve(out);
        };
        req.onerror = () => reject(req.error);
      });
    }

    async function setDay(date, rawTitle) {
      const db = await open();
      const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 120) : '';
      return new Promise((resolve, reject) => {
        const tx = db.transaction('days', 'readwrite');
        const store = tx.objectStore('days');
        const req = title ? store.put({ date, title }) : store.delete(date);
        req.onsuccess = () => resolve({ date, title });
        req.onerror = () => reject(req.error);
      });
    }

    return { listPhotos, addPhoto, updatePhoto, deletePhoto, listDays, setDay };
  })();

  // ── Даты ────────────────────────────────────────────────────────
  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function toDate(s) {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function dayIndex(s) {
    return Math.round((toDate(s) - toDate(state.config.startDate)) / 86400000) + 1;
  }

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  const num = (n) => n.toLocaleString('ru-RU');

  function formatLong(s) {
    const d = toDate(s);
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
  }

  function formatDayHead(s) {
    const d = toDate(s);
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}, ${WEEKDAYS[d.getDay()]}`;
  }

  function dayLabel(s) {
    const n = dayIndex(s);
    return n >= 1 ? `день ${num(n)}` : '';
  }

  function getThumbUrl(photo) {
    return photo.thumbUrl || `/media/thumb/${photo.thumb_file}`;
  }

  function getFullUrl(photo) {
    return photo.fullUrl || `/media/full/${photo.full_file}`;
  }

  function getOriginalUrl(photo) {
    if (photo.originalUrl) return photo.originalUrl;
    if (photo.original_file) return `/media/original/${photo.original_file}`;
    return '';
  }

  // ── DOM-хелперы ─────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeTile(photo, width, height) {
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.id = photo.id;
    if (width) tile.style.width = `${width}px`;
    if (height) tile.style.height = `${height}px`;
    if (photo.caption) tile.title = photo.caption;

    const img = new Image();
    img.alt = photo.caption || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => {
      // Фолбэк на полную версию, если превью не успело сгенерироваться или отдалось с задержкой
      if (photo.fullUrl && img.src !== photo.fullUrl) {
        img.src = photo.fullUrl;
      } else {
        img.classList.add('loaded');
      }
    });
    img.src = getThumbUrl(photo);
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('loaded');
    }
    tile.append(img);
    return tile;
  }

  async function api(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Ошибка ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── Рендер ──────────────────────────────────────────────────────
  function sortPhotos() {
    const dir = state.order === 'asc' ? 1 : -1;
    state.photos.sort((a, b) => {
      if (a.taken_at !== b.taken_at) return (a.taken_at < b.taken_at ? -1 : 1) * dir;
      return (a.id - b.id) * dir;
    });
  }

  function renderHeader() {
    const [a, b] = state.config.names;
    const names = $('names');
    names.textContent = '';
    names.append(`${a} `, el('span', 'amp', 'и'), ` ${b}`);
    document.title = `${a} и ${b}`;

    $('since').textContent = `вместе с ${formatLong(state.config.startDate)}`;
    const days = dayIndex(localDate(new Date()));
    $('daysTogether').textContent = days >= 1 ? `${num(days)} ${plural(days, ['день', 'дня', 'дней'])}` : 'скоро';
    const count = state.photos.length;
    $('photoCount').textContent = `${num(count)} ${plural(count, ['фотография', 'фотографии', 'фотографий'])}`;
    $('orderBtn').textContent = state.order === 'asc' ? 'С самого начала ↓' : 'Сначала новые ↓';
    $('randomBtn').hidden = count === 0;
  }

  function groupPhotos() {
    const years = [];
    let year = null;
    let month = null;
    let day = null;
    const q = state.searchQuery.toLowerCase();
    for (const photo of state.photos) {
      const date = photo.taken_at.slice(0, 10);
      if (q) {
        const dayTitle = state.days[date] || '';
        const monthName = MONTHS[Number(date.slice(5, 7)) - 1] || '';
        const hay = `${dayTitle} ${photo.caption || ''} ${date} ${formatLong(date)} ${monthName}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const yKey = date.slice(0, 4);
      const mKey = date.slice(0, 7);
      if (!year || year.key !== yKey) {
        year = { key: yKey, months: [] };
        years.push(year);
        month = null;
      }
      if (!month || month.key !== mKey) {
        month = { key: mKey, days: [], count: 0 };
        year.months.push(month);
        day = null;
      }
      if (!day || day.key !== date) {
        day = { key: date, photos: [] };
        month.days.push(day);
      }
      day.photos.push(photo);
      month.count += 1;
    }
    return years;
  }

  function renderTimeline() {
    sortPhotos();
    const root = $('timeline');
    root.textContent = '';
    state.grids.clear();
    $('empty').hidden = state.photos.length > 0;

    const years = groupPhotos();
    const frag = document.createDocumentFragment();

    for (const year of years) {
      const yearEl = el('section', 'year');
      yearEl.id = `y-${year.key}`;
      yearEl.append(el('h2', 'year-title', year.key));

      for (const month of year.months) {
        const monthEl = el('section', 'month');
        monthEl.id = `m-${month.key}`;
        const head = el('header', 'month-head');
        head.append(
          el('h3', 'month-title', MONTHS[Number(month.key.slice(5)) - 1]),
          el('span', 'month-year', month.key.slice(0, 4)),
          el('span', 'month-count', `${num(month.count)} фото`)
        );
        monthEl.append(head);

        for (const day of month.days) {
          const dayEl = el('article', 'day');
          const dayHead = el('div', 'day-head');
          dayHead.append(el('span', '', formatDayHead(day.key)), el('span', '', dayLabel(day.key)));

          const title = el('input', 'day-title');
          title.placeholder = 'Подпись к этому дню';
          title.maxLength = 120;
          title.value = state.days[day.key] || '';
          title.dataset.date = day.key;

          const grid = el('div', 'grid');
          state.grids.set(grid, day.photos);
          dayEl.append(dayHead, title, grid);
          monthEl.append(dayEl);
        }
        yearEl.append(monthEl);
      }
      frag.append(yearEl);
    }

    root.append(frag);
    layoutAll();
    renderRail(years);
    renderOnThisDay();
    renderHeader();
  }

  function layoutGrid(grid, photos) {
    const width = grid.clientWidth;
    if (!width) return;
    const gap = width < 600 ? 3 : 5;
    const target = width < 600 ? 140 : width < 1000 ? 200 : 250;
    grid.textContent = '';

    let row = [];
    let sum = 0;
    const flush = (height) => {
      const rowEl = el('div', 'row');
      rowEl.style.gap = `${gap}px`;
      rowEl.style.marginBottom = `${gap}px`;
      for (const [photo, ratio] of row) {
        rowEl.append(makeTile(photo, Math.floor(ratio * height * 100) / 100, Math.round(height)));
      }
      grid.append(rowEl);
      row = [];
      sum = 0;
    };

    for (const photo of photos) {
      const ratio = Math.min(3, Math.max(0.33, photo.width / photo.height));
      row.push([photo, ratio]);
      sum += ratio;
      const height = (width - gap * (row.length - 1)) / sum;
      if (height <= target) flush(height);
    }
    if (row.length) {
      const cap = photos.length <= 2 ? target * 1.7 : target;
      flush(Math.min(cap, (width - gap * (row.length - 1)) / sum));
    }
  }

  function layoutAll() {
    state.lastWidth = window.innerWidth;
    for (const [grid, photos] of state.grids) layoutGrid(grid, photos);
  }

  function renderRail(years) {
    const rail = $('rail');
    rail.textContent = '';
    for (const year of years) {
      const y = el('a', 'rail-year', year.key);
      y.href = `#y-${year.key}`;
      rail.append(y);
      for (const month of year.months) {
        const m = el('a', '', MONTHS_SHORT[Number(month.key.slice(5)) - 1]);
        m.href = `#m-${month.key}`;
        rail.append(m);
      }
    }
    rail.hidden = years.length === 0;
  }

  function renderOnThisDay() {
    const box = $('onThisDay');
    const now = new Date();
    const md = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const items = state.photos.filter(
      (p) => p.taken_at.slice(5, 10) === md && Number(p.taken_at.slice(0, 4)) < now.getFullYear()
    );
    box.textContent = '';
    if (!items.length) {
      box.hidden = true;
      return;
    }
    const years = [...new Set(items.map((p) => Number(p.taken_at.slice(0, 4))))].sort((a, b) => b - a);
    const head = el('div', 'otd-head');
    head.append(
      el('span', 'otd-label', 'В этот день'),
      el(
        'span',
        'otd-years',
        years
          .map((y) => {
            const n = now.getFullYear() - y;
            return `${n} ${plural(n, ['год', 'года', 'лет'])} назад`;
          })
          .join(' · ')
      )
    );
    const strip = el('div', 'otd-strip');
    for (const photo of items.slice(0, 16)) {
      strip.append(makeTile(photo, Math.round((140 * photo.width) / photo.height), 140));
    }
    box.append(head, strip);
    box.hidden = false;
  }

  // ── Просмотр ────────────────────────────────────────────────────
  function openLightbox(id) {
    const index = state.photos.findIndex((p) => p.id === id);
    if (index < 0) return;
    state.lbIndex = index;
    $('lightbox').hidden = false;
    document.body.classList.add('no-scroll');
    showLightbox();
  }

  function closeLightbox() {
    $('lightbox').hidden = true;
    document.body.classList.remove('no-scroll');
    $('lbImg').removeAttribute('src');
    state.lbIndex = -1;
  }

  function showLightbox() {
    const photo = state.photos[state.lbIndex];
    if (!photo) return closeLightbox();

    const img = $('lbImg');
    img.src = getThumbUrl(photo);
    img.alt = photo.caption || '';
    const full = new Image();
    full.onload = () => {
      if (state.photos[state.lbIndex] === photo) img.src = full.src;
    };
    full.src = getFullUrl(photo);

    const date = photo.taken_at.slice(0, 10);
    const time = photo.taken_at.slice(11, 16);
    const showTime = photo.date_source === 'exif' && time !== '00:00';
    $('lbDate').textContent = `${formatLong(date)}${showTime ? `, ${time}` : ''}`;
    $('lbDay').textContent = `${dayLabel(date)}${dayLabel(date) ? ' · ' : ''}${state.lbIndex + 1} / ${state.photos.length}`;
    $('lbCaption').value = photo.caption || '';
    $('lbDateInput').value = date;

    const original = $('lbOriginal');
    const origHref = getOriginalUrl(photo);
    original.hidden = !origHref;
    if (origHref) {
      original.href = origHref;
      original.download = photo.original_name || 'photo.jpg';
    }

    $('lbPrev').hidden = state.lbIndex === 0;
    $('lbNext').hidden = state.lbIndex === state.photos.length - 1;

    for (const j of [state.lbIndex - 1, state.lbIndex + 1]) {
      const next = state.photos[j];
      if (next) new Image().src = getFullUrl(next);
    }
  }

  function stepLightbox(delta) {
    const next = state.lbIndex + delta;
    if (next < 0 || next >= state.photos.length) return;
    state.lbIndex = next;
    showLightbox();
  }

  async function updatePhoto(photo, patch) {
    if (state.mode === 'supabase') {
      const updated = await supabaseStore.updatePhoto(photo.id, patch);
      Object.assign(photo, updated);
      return photo;
    }
    if (state.mode === 'server') {
      const updated = await api(`/api/photos/${photo.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      Object.assign(photo, updated);
      return photo;
    }
    const updated = await idbStore.updatePhoto(photo.id, patch);
    Object.assign(photo, updated);
    return photo;
  }

  // ── Поддержка HEIC/HEIF для Chrome на Mac/Windows ───────────────
  let heicLoaderPromise = null;
  function loadHeic2Any() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    if (heicLoaderPromise) return heicLoaderPromise;
    heicLoaderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      script.onload = () => resolve(window.heic2any);
      script.onerror = () => reject(new Error('Не удалось загрузить декодер HEIC'));
      document.head.appendChild(script);
    });
    return heicLoaderPromise;
  }

  // ── Загрузка ────────────────────────────────────────────────────
  const upload = { queue: [], active: 0, total: 0, done: 0, added: 0, dupes: 0, failed: 0, hideTimer: null };

  function enqueue(fileList) {
    const files = [...fileList].filter(
      (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(f.name)
    );
    if (!files.length) return;
    if (upload.active === 0 && upload.queue.length === 0) {
      Object.assign(upload, { total: 0, done: 0, added: 0, dupes: 0, failed: 0 });
    }
    upload.total += files.length;
    upload.queue.push(...files);
    updateToast();
    pump();
  }

  function pump() {
    while (upload.active < UPLOAD_CONCURRENCY && upload.queue.length) {
      const file = upload.queue.shift();
      upload.active += 1;
      processFile(file)
        .then((result) => {
          upload[result] += 1;
        })
        .catch((err) => {
          console.error(file.name, err);
          upload.failed += 1;
        })
        .finally(() => {
          upload.active -= 1;
          upload.done += 1;
          updateToast();
          scheduleRender();
          pump();
        });
    }
  }

  async function sha256Hex(file) {
    if (!window.crypto || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function decodeBlobToImage(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Image decode failed'));
      };
      img.src = url;
    });
  }

  async function loadImage(file) {
    try {
      return await decodeBlobToImage(file);
    } catch (err) {
      // Если это HEIC/HEIF в браузере Chrome — конвертируем через heic2any
      if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
        const heic2any = await loadHeic2Any();
        const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
        const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
        return decodeBlobToImage(jpegBlob);
      }
      throw err;
    }
  }

  function resizeToJpeg(img, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve({ blob, width, height }) : reject(new Error('Не удалось сжать фото'))),
        'image/jpeg',
        quality
      );
    });
  }

  async function processFile(file) {
    const [{ takenAt, source }, hash] = await Promise.all([window.Exif.readTakenAt(file), sha256Hex(file)]);
    if (hash && state.photos.some((p) => p.hash === hash)) return 'dupes';

    const img = await loadImage(file);
    const full = await resizeToJpeg(img, FULL_MAX_SIDE, 0.86);
    const thumb = await resizeToJpeg(img, THUMB_MAX_SIDE, 0.8);

    if (state.mode === 'supabase') {
      const saved = await supabaseStore.addPhoto({
        hash,
        takenAt,
        source,
        full,
        thumb,
        file
      });
      state.photos.push(saved);
      return 'added';
    }

    if (state.mode === 'server') {
      const meta = {
        taken_at: takenAt,
        date_source: source,
        width: full.width,
        height: full.height,
        original_name: file.name,
        sizes: [file.size, full.blob.size, thumb.blob.size],
      };
      const res = await fetch('/api/photos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Meta': encodeURIComponent(JSON.stringify(meta)),
        },
        body: new Blob([file, full.blob, thumb.blob]),
      });
      if (res.status === 409) return 'dupes';
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
      state.photos.push(data);
      return 'added';
    }

    // Режим IndexedDB (на Vercel / GitHub Pages)
    const saved = await idbStore.addPhoto({
      hash,
      taken_at: takenAt,
      date_source: source,
      width: full.width,
      height: full.height,
      original_name: file.name,
      caption: '',
      thumbBlob: thumb.blob,
      fullBlob: full.blob,
      originalBlob: file,
    });
    state.photos.push(saved);
    return 'added';
  }

  function updateToast() {
    const toast = $('toast');
    clearTimeout(upload.hideTimer);
    toast.hidden = false;
    const { total, done, added, dupes, failed } = upload;
    $('toastBar').style.width = `${total ? (done / total) * 100 : 0}%`;

    if (done < total) {
      $('toastText').textContent = `Загрузка: ${num(done)} из ${num(total)}`;
      return;
    }
    const parts = [`Добавлено ${num(added)}`];
    if (dupes) parts.push(`уже были в альбоме: ${num(dupes)}`);
    if (failed) parts.push(`не удалось: ${num(failed)}`);
    $('toastText').textContent = parts.join(' · ');
    upload.hideTimer = setTimeout(() => {
      toast.hidden = true;
    }, failed ? 9000 : 5000);
  }

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderTimeline, upload.done < upload.total ? 800 : 0);
  }

  // ── События ─────────────────────────────────────────────────────
  function bindEvents() {
    const fileInput = $('fileInput');
    const pick = () => fileInput.click();
    $('addBtn').addEventListener('click', pick);
    $('emptyAddBtn').addEventListener('click', pick);
    fileInput.addEventListener('change', () => {
      enqueue(fileInput.files);
      fileInput.value = '';
    });

    $('orderBtn').addEventListener('click', () => {
      state.order = state.order === 'asc' ? 'desc' : 'asc';
      localStorage.setItem('album.order', state.order);
      renderTimeline();
    });

    $('randomBtn').addEventListener('click', () => {
      if (!state.photos.length) return;
      const pickPhoto = state.photos[Math.floor(Math.random() * state.photos.length)];
      openLightbox(pickPhoto.id);
    });

    $('searchInput').addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      renderTimeline();
    });

    // Тема (Светлая / Тёмная)
    const savedTheme = localStorage.getItem('album.theme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
      document.documentElement.dataset.theme = savedTheme;
    }
    const syncThemeLabel = () => {
      const current =
        document.documentElement.dataset.theme ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      $('themeBtn').textContent = current === 'dark' ? 'Светлая' : 'Тёмная';
    };
    syncThemeLabel();

    $('themeBtn').addEventListener('click', () => {
      const current =
        document.documentElement.dataset.theme ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('album.theme', next);
      syncThemeLabel();
    });

    // Перетаскивание файлов в любое место окна
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth += 1;
      $('dropOverlay').hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('dropOverlay').hidden = true;
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $('dropOverlay').hidden = true;
      enqueue(e.dataTransfer.files);
    });

    // Клик по фото
    const onTileClick = (e) => {
      const tile = e.target.closest('.tile');
      if (tile) openLightbox(Number(tile.dataset.id));
    };
    $('timeline').addEventListener('click', onTileClick);
    $('onThisDay').addEventListener('click', onTileClick);

    // Подпись к дню
    $('timeline').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('day-title')) e.target.blur();
    });
    $('timeline').addEventListener('change', async (e) => {
      const input = e.target;
      if (!input.classList.contains('day-title')) return;
      const date = input.dataset.date;
      try {
        let title = '';
        if (state.mode === 'supabase') {
          const res = await supabaseStore.setDay(date, input.value);
          title = res.title;
        } else if (state.mode === 'server') {
          const res = await api(`/api/days/${date}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: input.value }),
          });
          title = res.title;
        } else {
          const res = await idbStore.setDay(date, input.value);
          title = res.title;
        }
        if (title) state.days[date] = title;
        else delete state.days[date];
        input.value = title;
      } catch (err) {
        alert(`Не удалось сохранить подпись: ${err.message}`);
      }
    });

    // Просмотр
    $('lbClose').addEventListener('click', closeLightbox);
    $('lbPrev').addEventListener('click', () => stepLightbox(-1));
    $('lbNext').addEventListener('click', () => stepLightbox(1));
    $('lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox' || e.target.id === 'lbStage') closeLightbox();
    });

    document.addEventListener('keydown', (e) => {
      if ($('lightbox').hidden) return;
      if (e.key === 'Escape') return closeLightbox();
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
    });

    let touch = null;
    $('lbStage').addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      },
      { passive: true }
    );
    $('lbStage').addEventListener('touchend', (e) => {
      if (!touch) return;
      const dx = e.changedTouches[0].clientX - touch.x;
      const dy = e.changedTouches[0].clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) stepLightbox(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeLightbox();
    });

    const caption = $('lbCaption');
    caption.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') caption.blur();
    });
    caption.addEventListener('change', async () => {
      const photo = state.photos[state.lbIndex];
      if (!photo) return;
      try {
        await updatePhoto(photo, { caption: caption.value });
        const tile = document.querySelector(`.tile[data-id="${photo.id}"]`);
        if (tile) tile.title = photo.caption;
      } catch (err) {
        alert(`Не удалось сохранить подпись: ${err.message}`);
      }
    });

    $('lbDateInput').addEventListener('change', async (e) => {
      const photo = state.photos[state.lbIndex];
      if (!photo || !e.target.value) return;
      try {
        await updatePhoto(photo, { taken_at: `${e.target.value}${photo.taken_at.slice(10)}` });
        renderTimeline();
        state.lbIndex = state.photos.indexOf(photo);
        showLightbox();
      } catch (err) {
        alert(`Не удалось изменить дату: ${err.message}`);
      }
    });

    $('lbDelete').addEventListener('click', async () => {
      const photo = state.photos[state.lbIndex];
      if (!photo || !confirm('Удалить это фото из альбома? Это нельзя отменить.')) return;
      try {
        if (state.mode === 'supabase') {
          await supabaseStore.deletePhoto(photo.id);
        } else if (state.mode === 'server') {
          await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
        } else {
          await idbStore.deletePhoto(photo.id);
        }
        state.photos.splice(state.lbIndex, 1);
        renderTimeline();
        if (!state.photos.length) return closeLightbox();
        state.lbIndex = Math.min(state.lbIndex, state.photos.length - 1);
        showLightbox();
      } catch (err) {
        alert(`Не удалось удалить: ${err.message}`);
      }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.innerWidth !== state.lastWidth) layoutAll();
      }, 150);
    });
  }

  async function init() {
    bindEvents();
    try {
      if (SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey) {
        state.mode = 'supabase';
        const [photos, days] = await Promise.all([
          supabaseStore.listPhotos(),
          supabaseStore.listDays()
        ]);
        state.photos = photos;
        state.days = days;
      } else {
        const probe = await fetch('/api/config');
        if (probe.ok && (probe.headers.get('content-type') || '').includes('application/json')) {
          state.mode = 'server';
          const [config, photos, days] = await Promise.all([
            probe.json(),
            api('/api/photos'),
            api('/api/days'),
          ]);
          state.config = config;
          state.photos = photos;
          state.days = days;
        } else {
          state.mode = 'idb';
          const [photos, days] = await Promise.all([idbStore.listPhotos(), idbStore.listDays()]);
          state.photos = photos;
          state.days = days;
        }
      }
    } catch (err) {
      console.warn('Init error, falling back to idb:', err);
      state.mode = 'idb';
      const [photos, days] = await Promise.all([idbStore.listPhotos(), idbStore.listDays()]);
      state.photos = photos;
      state.days = days;
    }
    renderTimeline();
  }

  init();
})();
