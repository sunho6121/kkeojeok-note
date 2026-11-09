'use strict';
/* 끄적노트 — 기기 저장소(IndexedDB, 실패 시 localStorage)와 날짜 도우미 */
window.KK = window.KK || {};

(function () {
  const DB_NAME = 'kkeojeok';
  const STORE = 'docs';
  const LS_KEY = 'kk-docs-fallback';
  let dbp = null;
  let useLS = false;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    return dbp;
  }

  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function lsWrite(map) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (e) { console.warn('저장 실패', e); }
  }

  function run(mode, work) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      const r = work(store);
      if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  KK.db = {
    get usingFallback() { return useLS; },
    async init() {
      try {
        if (!('indexedDB' in window)) throw new Error('no idb');
        await open();
      } catch (e) {
        useLS = true;
      }
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* 무시 */ }
    },
    async all() {
      if (useLS) return Object.values(lsRead());
      return (await run('readonly', s => s.getAll())) || [];
    },
    async get(id) {
      if (useLS) return lsRead()[id] || null;
      return (await run('readonly', s => s.get(id))) || null;
    },
    async put(doc) { return this.putMany([doc]); },
    async putMany(docs) {
      const clean = docs.map(d => JSON.parse(JSON.stringify(d)));
      if (useLS) { const m = lsRead(); clean.forEach(d => { m[d.id] = d; }); lsWrite(m); return; }
      await run('readwrite', s => { clean.forEach(d => s.put(d)); });
    },
    /* 녹음 파일처럼 Blob이 든 문서 — JSON으로 바꾸지 않고 그대로 저장 */
    async putRaw(doc) {
      if (useLS) throw new Error('이 브라우저에서는 파일을 저장할 수 없어요');
      await run('readwrite', s => { s.put(doc); });
    },
    async del(id) { return this.delMany([id]); },
    async delMany(ids) {
      if (!ids.length) return;
      if (useLS) { const m = lsRead(); ids.forEach(id => { delete m[id]; }); lsWrite(m); return; }
      await run('readwrite', s => { ids.forEach(id => s.delete(id)); });
    },
  };

  /* ---------- 날짜 ---------- */
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };

  KK.date = {
    DOW, pad, ymd, parse, addDays,
    today: () => ymd(new Date()),
    diffDays(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); },
    isValid(s) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
      const d = parse(s); return ymd(d) === s;
    },
    isTime: s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || ''),
    dayLabel(s) { const d = parse(s); return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + DOW[d.getDay()] + ')'; },
    longToday() { const d = new Date(); return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + DOW[d.getDay()] + '요일'; },
    stamp(ms) { const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); },
    short(ms) {
      const d = new Date(ms); const t = ymd(d);
      if (t === ymd(new Date())) return pad(d.getHours()) + ':' + pad(d.getMinutes());
      return (d.getMonth() + 1) + '/' + d.getDate();
    },
    /* Claude에게 줄 3주치 달력 */
    calendarText() {
      const now = new Date();
      const lines = [];
      for (let i = -1; i < 21; i++) {
        const d = addDays(now, i);
        const tag = i === 0 ? ' ← 오늘' : i === 1 ? ' ← 내일' : i === 2 ? ' ← 모레' : i === -1 ? ' ← 어제' : '';
        lines.push(ymd(d) + ' (' + DOW[d.getDay()] + ')' + tag);
      }
      const dow = now.getDay() === 0 ? 7 : now.getDay();
      const mon = addDays(now, 1 - dow);
      return {
        lines: lines.join('\n'),
        thisWeek: ymd(mon) + ' (월) ~ ' + ymd(addDays(mon, 6)) + ' (일)',
        nextWeek: ymd(addDays(mon, 7)) + ' (월) ~ ' + ymd(addDays(mon, 13)) + ' (일)',
        now: ymd(now) + ' (' + DOW[now.getDay()] + ') ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
      };
    },
  };

  KK.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
})();
