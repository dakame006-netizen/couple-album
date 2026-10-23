/**
 * Чтение даты съёмки из фотографии прямо в браузере, без библиотек.
 * Порядок: EXIF DateTimeOriginal → DateTimeDigitized → DateTime →
 * поиск даты в метаданных (HEIC и др.) → дата изменения файла.
 * Возвращает местное время съёмки в виде 'YYYY-MM-DDTHH:MM:SS' (без часового пояса, как в EXIF).
 */
(function () {
  'use strict';

  const DATE_RE = /(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

  const pad = (n) => String(n).padStart(2, '0');

  function localStamp(d) {
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  function normalize(raw) {
    const m = DATE_RE.exec(raw || '');
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    if (+y < 1990 || +y > 2100 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23) return null;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }

  function readAscii(view, start, len) {
    let s = '';
    for (let i = 0; i < len && start + i < view.byteLength; i++) {
      const c = view.getUint8(start + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function readIfd(view, tiff, offset, le, out) {
    if (offset < 0 || offset + 2 > view.byteLength) return;
    const count = view.getUint16(offset, le);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      const tag = view.getUint16(entry, le);
      const n = view.getUint32(entry + 4, le);
      const value = view.getUint32(entry + 8, le);
      if (tag === 0x8769) out.exifPointer = value;
      else if (tag === 0x9003 || tag === 0x9004 || tag === 0x0132) {
        out[tag] = readAscii(view, tiff + value, Math.min(n, 20));
      }
    }
  }

  function parseJpeg(view) {
    let off = 2;
    while (off + 4 <= view.byteLength) {
      if (view.getUint8(off) !== 0xff) return null;
      const marker = view.getUint8(off + 1);
      if (marker === 0xda || marker === 0xd9) return null;
      const len = view.getUint16(off + 2);
      if (marker === 0xe1 && off + 10 <= view.byteLength && view.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        if (tiff + 8 > view.byteLength) return null;
        const order = view.getUint16(tiff);
        const le = order === 0x4949;
        if (!le && order !== 0x4d4d) return null;
        const out = {};
        readIfd(view, tiff, tiff + view.getUint32(tiff + 4, le), le, out);
        if (out.exifPointer) readIfd(view, tiff, tiff + out.exifPointer, le, out);
        return out[0x9003] || out[0x9004] || out[0x0132] || null;
      }
      off += 2 + len;
    }
    return null;
  }

  function bytesToLatin1(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return text;
  }

  async function readTakenAt(file) {
    try {
      const buf = await file.slice(0, 512 * 1024).arrayBuffer();
      const view = new DataView(buf);
      let found = null;
      if (view.byteLength > 4 && view.getUint16(0) === 0xffd8) found = normalize(parseJpeg(view));
      if (!found) found = normalize(bytesToLatin1(new Uint8Array(buf)));
      if (found) return { takenAt: found, source: 'exif' };
    } catch (err) {
      console.warn('EXIF:', err);
    }
    if (file.lastModified) return { takenAt: localStamp(new Date(file.lastModified)), source: 'file' };
    return { takenAt: localStamp(new Date()), source: 'upload' };
  }

  window.Exif = { readTakenAt, localStamp };
})();
