'use strict';
/* 끄적노트 — 다른 기기(노트북·태블릿)와 맞추기: 내 구글 드라이브의 앱 전용 공간(appDataFolder)
   - 문서 하나 = 드라이브 파일 하나('<문서 id>.json'). 녹음·붙인 파일의 내용은 따로 '<문서 id>.bin'
   - 이 기기에서 바뀐 문서는 KK.db 쓰기를 가로채 표시해 두었다가 몇 초 뒤 올림
   - 받을 때: 마지막으로 맞춘 판(base)과 견주어 세 갈래로 합침
       노트 본문은 줄 단위, 필기는 획 단위, 나머지 칸은 한쪽만 고쳤으면 그쪽, 둘 다 고쳤으면 나중에 고친 쪽
   - 지운 문서는 '지움 표시'로 올려 다른 기기에서도 지움
   - 구글 로그인(토큰)은 1시간이면 끝남 → 위쪽 구름 버튼 '맞추기'를 누르면 이어짐
   - 맞추지 않는 것: 설정(Claude API 키·업무보드 키 포함), 녹음 중 조각, 저장 확인 전 녹음 */
window.KK = window.KK || {};

(function () {
  const db = KK.db;
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
  const FIELDS = 'id,name,modifiedTime,createdTime,appProperties';
  const DEFAULT_CLIENT_ID = '277084713279-0c5jubei6ki1h760rvtu4q5l2nommtm0.apps.googleusercontent.com';
  const LS_CFG = 'kk-sync', LS_TOK = 'kk-stok';
  const KINDS = ['note', 'item', 'ink', 'imp', 'month', 'rec', 'att'];
  const BLOB_KINDS = ['rec', 'att'];
  const BLOB_MAX = 300 * 1024 * 1024;
  const toast = (...a) => KK.ui && KK.ui.toast(...a);
  const A = () => KK.app;

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 무시 */ } };
  const cfg = Object.assign({ on: false, email: '', dev: '', cursor: '', last: 0, files: true, err: '', errUrl: '', stats: null, seeded: false }, lsGet(LS_CFG, {}));
  if (!cfg.dev) cfg.dev = 'd' + Math.random().toString(36).slice(2, 9);
  const saveCfg = () => lsSet(LS_CFG, cfg);
  saveCfg();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- 맞춘 기록 (이 기기에만: IndexedDB 'kk-sync') ----------
     meta: { id, k(종류), t(이 기기 판), r(드라이브에 있는 판), f(드라이브 파일), fc(파일 만든 때), bf·bs·bt(녹음·파일 내용) }
     base: { id, doc } — 마지막으로 맞춘 판(세 갈래 합치기의 기준) */
  let mdbp = null;
  function mdb() {
    if (mdbp) return mdbp;
    mdbp = new Promise((res, rej) => {
      const r = indexedDB.open('kk-sync', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('meta', { keyPath: 'id' }); r.result.createObjectStore('base', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return mdbp;
  }
  function tx(store, mode, work) {
    return mdb().then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out; const r = work(s);
      if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
  }
  const meta = new Map(), metaDirty = new Set();
  let metaP = null, metaTimer = null;
  function loadMeta() {
    if (!metaP) metaP = tx('meta', 'readonly', s => s.getAll()).then(list => { (list || []).forEach(m => { if (!meta.has(m.id)) meta.set(m.id, m); }); }).catch(() => {});
    return metaP;
  }
  function touch(m) { meta.set(m.id, m); metaDirty.add(m.id); clearTimeout(metaTimer); metaTimer = setTimeout(flushMeta, 400); }
  function dropMeta(id) { meta.delete(id); metaDirty.add(id); clearTimeout(metaTimer); metaTimer = setTimeout(flushMeta, 400); }
  async function flushMeta() {
    clearTimeout(metaTimer);
    const ids = [...metaDirty]; metaDirty.clear();
    if (!ids.length) return;
    await tx('meta', 'readwrite', s => { ids.forEach(id => { const m = meta.get(id); if (m) s.put(m); else s.delete(id); }); }).catch(() => {});
  }
  const baseCache = new Map();
  async function getBase(id) {
    if (baseCache.has(id)) return baseCache.get(id);
    const r = await tx('base', 'readonly', s => s.get(id)).catch(() => null);
    const d = r ? r.doc : null;
    if (baseCache.size > 400) baseCache.clear();
    baseCache.set(id, d);
    return d;
  }
  function setBase(id, doc) {
    doc = doc ? JSON.parse(JSON.stringify(doc)) : null; // 따로 떼어 둠(화면의 노트 객체와 같은 것을 쓰면 글을 쓸 때 기준 판도 바뀜)
    baseCache.set(id, doc);
    tx('base', 'readwrite', s => (doc ? s.put({ id, doc }) : s.delete(id))).catch(() => {});
  }
  let lastTick = 0;
  const tick = () => (lastTick = Math.max(Date.now(), lastTick + 1));
  const dirty = m => m && m.t != null && m.t !== m.r;
  const pendingCount = () => { let n = 0; meta.forEach(m => { if (dirty(m)) n++; }); return n; };

  /* ---------- 기기 저장소 쓰기를 가로채 '바뀜' 표시 ---------- */
  const raw = { putMany: db.putMany.bind(db), putRaw: db.putRaw.bind(db), delMany: db.delMany.bind(db) };
  db.putMany = async function (docs) { await raw.putMany(docs); noteLocal(docs.map(d => [d.id, d.kind])); };
  db.putRaw = async function (doc) { await raw.putRaw(doc); noteLocal([[doc.id, doc.kind]]); };
  db.delMany = async function (ids) { await raw.delMany(ids); noteLocal(ids.map(id => [id, null])); };
  function noteLocal(list) {
    if (!cfg.on) return;
    const t = tick();
    loadMeta().then(() => {
      let any = false;
      list.forEach(([id, kind]) => {
        if (kind && !KINDS.includes(kind)) return;
        const m = meta.get(id);
        if (!kind && !m) return; // 맞춘 적 없는 문서를 지움
        const x = m || { id };
        x.t = Math.max(t, (x.t || 0) + 1); if (kind) x.k = kind;
        touch(x); any = true;
      });
      if (any) pushSoon();
    });
  }

  /* ---------- 구글 로그인 (Google Identity Services, 토큰 1시간) ---------- */
  let token = null, tokenExp = 0;
  (() => { const t = lsGet(LS_TOK, null); if (t && t.exp > Date.now() + 60000) { token = t.token; tokenExp = t.exp; } })();
  const hasToken = () => !!token && tokenExp > Date.now() + 60000;
  let gisP = null, tc = null, tcId = '', waitTok = [];
  function loadGIS() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisP) return gisP;
    gisP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res(); s.onerror = () => { gisP = null; rej(new Error('gis')); };
      document.head.append(s);
    });
    return gisP;
  }
  const clientId = () => (KK.gcal && KK.gcal.cfg && KK.gcal.cfg.clientId) || DEFAULT_CLIENT_ID;
  function tokenClient() {
    if (!(window.google && google.accounts && google.accounts.oauth2)) return null;
    const cid = clientId();
    if (tc && tcId === cid) return tc;
    tc = google.accounts.oauth2.initTokenClient({ client_id: cid, scope: SCOPE, callback: onToken, error_callback: e => onToken({ error: (e && e.type) || 'error' }) });
    tcId = cid;
    return tc;
  }
  function onToken(resp) {
    let ok = !!(resp && resp.access_token && !resp.error);
    if (ok && google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
      ok = false; setErr('scope', '구글 권한 창에서 「끄적노트 전용 공간(Google Drive)」 항목에 체크해야 맞출 수 있어요. 다시 켜 주세요.');
    }
    if (ok) {
      token = resp.access_token; tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      lsSet(LS_TOK, { token, exp: tokenExp });
      if (cfg.err === 'scope') { cfg.err = ''; saveCfg(); }
    } else if (resp && resp.error && resp.error !== 'popup_closed' && cfg.err !== 'scope') toast('구글 로그인을 마치지 못했어요. 다시 눌러 주세요.');
    const fns = waitTok; waitTok = [];
    fns.forEach(f => f(ok));
    notify();
  }
  /* 반드시 버튼을 누른 순간에 불러야 해요 (팝업 차단 방지) */
  function login(first) {
    return new Promise(res => {
      if (!navigator.onLine) { toast('인터넷에 연결된 뒤 다시 눌러 주세요.'); res(false); return; }
      const c = tokenClient();
      if (!c) { loadGIS().then(tokenClient).catch(() => {}); toast('구글 로그인을 준비하고 있어요. 1~2초 뒤 다시 눌러 주세요.'); res(false); return; }
      waitTok.push(res);
      const o = { prompt: first ? 'select_account consent' : '' };
      if (cfg.email && !first) o.login_hint = cfg.email;
      c.requestAccessToken(o);
    });
  }

  /* ---------- 드라이브 API ---------- */
  const codeErr = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };
  async function api(url, opt, as) {
    for (let tries = 0; ; tries++) {
      if (!hasToken()) throw codeErr('token');
      const o = opt || {};
      let res;
      try { res = await fetch(url, Object.assign({ cache: 'no-store' }, o, { headers: Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {}) })); }
      catch (e) { throw codeErr('net', '인터넷 연결을 확인해 주세요'); }
      if (res.status === 401) { token = null; tokenExp = 0; lsSet(LS_TOK, null); throw codeErr('token'); }
      if (res.status === 404) throw codeErr('gone');
      if (res.ok) {
        if (as === 'res') return res;
        if (as === 'text') return res.text();
        if (as === 'blob') return res.blob();
        if (res.status === 204) return null;
        return res.json().catch(() => null);
      }
      const data = await res.json().catch(() => null);
      const er = (data && data.error) || {};
      const msg = er.message || ('HTTP ' + res.status);
      const reason = ((er.errors || [])[0] || {}).reason || er.status || '';
      const retry = res.status === 429 || res.status >= 500 || /rateLimit/i.test(reason);
      if (retry && tries < 3) { await sleep(800 * (tries + 1) * (tries + 1)); continue; }
      let code = 'http';
      if (res.status === 403 && /has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(msg + ' ' + reason)) code = 'api-off';
      else if (res.status === 403 && /insufficient|scope/i.test(msg + ' ' + reason)) code = 'scope';
      else if (res.status === 403 && /storageQuota|quota/i.test(msg + ' ' + reason)) code = 'full';
      const e = codeErr(code, msg); e.status = res.status; throw e;
    }
  }
  const enc = encodeURIComponent;
  async function listFiles(q) {
    const out = []; let page = '';
    do {
      const r = await api(API + '/files?spaces=appDataFolder&pageSize=1000&orderBy=modifiedTime&fields=' + enc('nextPageToken,files(' + FIELDS + ')')
        + (q ? '&q=' + enc(q) : '') + (page ? '&pageToken=' + enc(page) : ''));
      out.push(...((r && r.files) || [])); page = (r && r.nextPageToken) || '';
    } while (page);
    return out;
  }
  async function findByName(name) {
    const list = await listFiles("name = '" + name.replace(/'/g, "\\'") + "'");
    return list.sort(byCreated)[0] || null;
  }
  const byCreated = (x, y) => (x.createdTime < y.createdTime ? -1 : x.createdTime > y.createdTime ? 1 : x.id < y.id ? -1 : 1);
  async function upload(fileId, name, props, content, type) {
    const md = fileId ? { appProperties: props } : { name, parents: ['appDataFolder'], appProperties: props, mimeType: type };
    const path = UP + '/files' + (fileId ? '/' + fileId : '');
    const method = fileId ? 'PATCH' : 'POST';
    if (content.size > 4 * 1024 * 1024) {
      const init = await api(path + '?uploadType=resumable&fields=' + FIELDS, { method, body: JSON.stringify(md), headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(content.size) } }, 'res');
      const loc = init.headers.get('Location') || init.headers.get('location');
      if (loc) return api(loc, { method: 'PUT', body: content, headers: { 'Content-Type': type } });
    }
    const b = 'kk' + Math.random().toString(36).slice(2);
    const body = new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(md) + '\r\n--' + b + '\r\nContent-Type: ' + type + '\r\n\r\n', content, '\r\n--' + b + '--']);
    return api(path + '?uploadType=multipart&fields=' + FIELDS, { method, body, headers: { 'Content-Type': 'multipart/related; boundary=' + b } });
  }
  const delFile = id => api(API + '/files/' + id, { method: 'DELETE' }).catch(() => null);
  async function fetchJSON(f) {
    const txt = await api(API + '/files/' + f.id + '?alt=media', null, 'text');
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  /* ---------- 합치기 ---------- */
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  // 드라이브에 올리는 모양(파일 내용 Blob 뺌, 드라이브 표시 칸 뺌)
  function clean(d) {
    const o = Object.assign({}, d);
    delete o.blob; delete o._bf; delete o._bs; delete o._bt;
    return JSON.parse(JSON.stringify(o));
  }
  function lcsPairs(A, B) {
    const n = A.length, m = B.length;
    if (!n || !m) return [];
    if (n * m > 4e6) return null;
    const W = m + 1, L = (Math.min(n, m) < 65535 ? new Uint16Array((n + 1) * W) : new Uint32Array((n + 1) * W));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push([i, j]); i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
    }
    return out;
  }
  // O의 줄 → X의 같은 줄 위치(-1 = 없음)
  function matchMap(O, X) {
    const map = new Int32Array(O.length).fill(-1);
    let p = 0;
    while (p < O.length && p < X.length && O[p] === X[p]) { map[p] = p; p++; }
    let s = 0;
    while (s < O.length - p && s < X.length - p && O[O.length - 1 - s] === X[X.length - 1 - s]) { map[O.length - 1 - s] = X.length - 1 - s; s++; }
    const pairs = lcsPairs(O.slice(p, O.length - s), X.slice(p, X.length - s));
    if (pairs === null) return null;
    pairs.forEach(([i, j]) => { map[p + i] = p + j; });
    return map;
  }
  function diff3(O, A, B) {
    const ma = matchMap(O, A), mb = matchMap(O, B);
    if (!ma || !mb) return null;
    const out = [];
    let io = 0, ia = 0, ib = 0;
    const flush = (oe, ae, be) => {
      const o = O.slice(io, oe), a = A.slice(ia, ae), b = B.slice(ib, be);
      const so = o.join('\n'), sa = a.join('\n'), sb = b.join('\n');
      if (sa === so) out.push(...b);
      else if (sb === so || sa === sb) out.push(...a);
      else { // 같은 곳을 양쪽에서 고침 → 둘 다 남김(이쪽 먼저, 저쪽에만 있는 줄 뒤에)
        out.push(...a);
        const seen = new Set(a.filter(l => l.trim()));
        b.forEach(l => { if (!l.trim() || !seen.has(l)) out.push(l); });
      }
    };
    for (let i = 0; i < O.length; i++) {
      if (ma[i] >= ia && mb[i] >= ib) {
        flush(i, ma[i], mb[i]);
        out.push(O[i]); io = i + 1; ia = ma[i] + 1; ib = mb[i] + 1;
      }
    }
    flush(O.length, A.length, B.length);
    return out;
  }
  function mergeText(o, a, b) {
    if (a === b) return a;
    const A2 = a.split('\n'), B2 = b.split('\n');
    let O;
    if (o == null) { // 기준 판이 없으면 두 쪽에 다 있는 줄을 기준으로
      if (a.includes(b)) return a;
      if (b.includes(a)) return b;
      const m = matchMap(A2, B2);
      O = m ? A2.filter((_, i) => m[i] >= 0) : [];
    } else O = o.split('\n');
    const r = diff3(O, A2, B2);
    return r ? r.join('\n') : a + '\n\n' + b;
  }
  function mergeStrokes(o, a, b) {
    const ka = a.map(stable), kb = b.map(stable), ko = new Set((o || []).map(stable));
    const sb = new Set(kb), sa = new Set(ka);
    const out = [], have = new Set();
    a.forEach((s, i) => { if (ko.has(ka[i]) && !sb.has(ka[i])) return; out.push(s); have.add(ka[i]); }); // 저쪽에서 지운 획은 뺌
    b.forEach((s, i) => { if (!ko.has(kb[i]) && !sa.has(kb[i]) && !have.has(kb[i])) { out.push(s); have.add(kb[i]); } });
    return out;
  }
  // 세 갈래 합치기: base(마지막으로 맞춘 판), a(이 기기), b(드라이브), ta·tb(고친 때)
  function merge3(base, a, b, ta, tb) {
    base = base || {};
    const out = {};
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k => {
      const av = a[k], bv = b[k], ov = base[k];
      const sa = stable(av), sb = stable(bv), so = stable(ov);
      let v;
      if (sa === sb || sb === so) v = av;
      else if (sa === so) v = bv;
      else if (k === 'body' && typeof av === 'string' && typeof bv === 'string') v = mergeText(typeof ov === 'string' ? ov : (Object.keys(base).length ? '' : null), av, bv);
      else if (k === 'strokes' && Array.isArray(av) && Array.isArray(bv)) v = mergeStrokes(Array.isArray(ov) ? ov : null, av, bv);
      else v = ta >= tb ? av : bv;
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  /* ---------- 받기 ---------- */
  // 드라이브 파일 하나(f, 내용 remote)를 이 기기에 반영. 'defer' = 지금 쓰는 중이라 다음에
  // dup: 같은 이름 파일이 둘 — 'mine'(내 파일을 남김) / 'theirs'(이 파일을 남김). 따로 만든 것이라 기준 판 없이 합침
  async function absorb(f, id, remote, changes, dup) {
    const p = f.appProperties || {}, rt = Number(p.t) || 0;
    const m = meta.get(id) || { id };
    const base = dup ? null : await getBase(id);
    let local = A() && A().memDoc ? A().memDoc(id) : undefined;
    if (local === undefined) local = await db.get(id);
    const mem = A() && A().memDoc ? A().memDoc(id) : undefined; // 기다리는 사이 바뀌었을 수 있어 다시 읽음(여기부터 끝까지 동기)
    if (mem !== undefined) local = mem;
    if (A() && A().editingNow && A().editingNow(id)) return 'defer';
    const lc = local ? clean(local) : null;
    const localDirty = lc ? (!base || stable(lc) !== stable(base)) : dirty(m);
    if (dup && (!remote || remote._del || !lc)) { if (dup === 'theirs') { m.f = f.id; m.fc = f.createdTime; m.r = -1; m.t = tick(); touch(m); } return 'dup'; }
    if (!dup) { m.f = f.id; if (!m.fc) m.fc = f.createdTime; }
    if (!remote || remote._del) {
      m.r = rt; setBase(id, null);
      if (lc && localDirty) { m.t = tick(); touch(m); return 'keep'; } // 이 기기에서 고친 것 → 남겨 다시 올림
      m.t = rt; touch(m);
      if (local) {
        changes.push({ id, doc: null, kind: local.kind });
        if (A() && A().applyRemote) A().applyRemote([{ id, doc: null, kind: local.kind }]);
        await raw.delMany([id]);
        if (m.bf) m.bf = '';
      }
      return 'del';
    }
    const rd = clean(remote);
    if (!KINDS.includes(rd.kind)) return 'skip';
    let result = (!lc || !localDirty) ? rd : merge3(base, lc, rd, m.t || 0, rt);
    m.k = rd.kind;
    if (BLOB_KINDS.includes(rd.kind)) {
      if (remote._bf) { m.bf = remote._bf; m.bs = remote._bs || 0; m.bt = remote._bt || ''; }
      const lb = local && local.blob;
      if (lb && (!remote._bf || lb.size === remote._bs)) result = Object.assign({}, result, { blob: lb });
    }
    const same = stable(clean(result)) === stable(rd);
    if (dup === 'mine') m.t = tick(); // 내 파일의 기준 판(r·base)은 그대로, 합친 것을 다시 올림
    else if (dup === 'theirs') { m.f = f.id; m.fc = f.createdTime; m.r = rt; m.t = tick(); setBase(id, rd); }
    else { m.r = rt; m.t = same ? rt : tick(); setBase(id, rd); }
    touch(m);
    changes.push({ id, doc: result, kind: rd.kind });
    if (A() && A().applyRemote) A().applyRemote([{ id, doc: result, kind: rd.kind }]);
    if (result.blob) await raw.putRaw(result); else await raw.putMany([result]);
    return same ? 'take' : 'merge';
  }

  async function pull(changes, stats) {
    const since = cfg.cursor;
    const files = await listFiles(since ? "modifiedTime > '" + since + "'" : '');
    let maxMod = '';
    const byId = new Map();
    files.forEach(f => {
      if (f.modifiedTime > maxMod) maxMod = f.modifiedTime;
      if (!/\.json$/.test(f.name)) return;
      const id = f.name.slice(0, -5);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(f);
    });
    // 내려받을 것: 이미 가진 판이 아닌 것
    const jobs = [];
    byId.forEach((list, id) => {
      list.sort(byCreated).forEach(f => {
        const m = meta.get(id), rt = Number((f.appProperties || {}).t) || 0;
        if (m && m.f === f.id && m.r === rt) return;
        jobs.push({ f, id });
      });
    });
    if (A() && A().flushPending) A().flushPending();
    let deferred = 0, i = 0;
    const got = new Array(jobs.length);
    const worker = async () => { while (i < jobs.length) { const k = i++; got[k] = await fetchJSON(jobs[k].f).catch(e => { if (e.code === 'gone') return undefined; throw e; }); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    for (let k = 0; k < jobs.length; k++) {
      const { f, id } = jobs[k];
      if (got[k] === undefined) continue; // 그사이 지워진 파일
      const m = meta.get(id);
      // 같은 문서가 두 기기에서 따로 만들어진 경우: 먼저 만든 파일 하나로 모음
      if (m && m.f && m.f !== f.id && f.createdTime && m.fc) {
        const mineOlder = m.fc < f.createdTime || (m.fc === f.createdTime && m.f < f.id);
        const drop = mineOlder ? f.id : m.f;
        const r = await absorb(f, id, got[k], changes, mineOlder ? 'mine' : 'theirs');
        if (r === 'defer') { deferred++; continue; }
        await delFile(drop);
        stats.got++;
        continue;
      }
      const r = await absorb(f, id, got[k], changes);
      if (r === 'defer') deferred++;
      else if (r !== 'skip') stats.got++;
    }
    if (!deferred && maxMod) {
      const c = new Date(new Date(maxMod).getTime() - 60000).toISOString(); // 드라이브 목록이 늦게 보이는 것 대비 1분 겹침
      if (!cfg.cursor || c > cfg.cursor) cfg.cursor = c;
      saveCfg();
    }
    return deferred;
  }

  /* ---------- 올리기 ---------- */
  const fixedId = id => /^(ink|imp|month)-/.test(id) || /^n-.+-\d{4}-\d{2}$/.test(id); // 두 기기에서 같은 이름으로 생길 수 있는 문서
  async function pushOne(id, stats, changes, depth) {
    const m = meta.get(id);
    if (!dirty(m)) return;
    const t = m.t;
    const doc = await db.get(id);
    if (doc && !KINDS.includes(doc.kind)) { dropMeta(id); return; }
    if (doc && doc.kind === 'rec' && doc.draft) { m.r = t; touch(m); return; } // 저장 확인 전 녹음은 확인한 뒤에(그때 다시 바뀜 표시)
    if (doc && m.f && m.r != null) { // 마지막으로 맞춘 판과 같으면 할 일 없음
      const base0 = await getBase(id);
      const needBlob = BLOB_KINDS.includes(doc.kind) && doc.blob && cfg.files && doc.blob.size <= BLOB_MAX && (!m.bf || m.bs !== doc.blob.size);
      if (base0 && !needBlob && stable(clean(doc)) === stable(base0)) { if (m.t === t) { m.t = m.r; touch(m); } return; }
    }
    // 드라이브 쪽이 그사이 바뀌었으면 먼저 받아 합침
    if (m.f || (!m.f && fixedId(id))) {
      let f = null;
      try {
        f = m.f ? await api(API + '/files/' + m.f + '?fields=' + FIELDS) : await findByName(id + '.json');
      } catch (e) { if (e.code !== 'gone') throw e; f = await findByName(id + '.json'); m.f = f ? f.id : ''; if (f) m.fc = f.createdTime; }
      if (f) {
        const rt = Number((f.appProperties || {}).t) || 0;
        if (m.f !== f.id || m.r !== rt) {
          if (A() && A().editingNow && A().editingNow(id)) return; // 지금 쓰는 중 → 다음에
          const remote = await fetchJSON(f).catch(() => null);
          const r = await absorb(f, id, remote, changes);
          if (r === 'defer') return;
          if (depth < 2) return pushOne(id, stats, changes, depth + 1);
          return;
        }
      }
    }
    let body, props;
    if (!doc) {
      if (!m.f) { dropMeta(id); setBase(id, null); return; } // 올린 적 없는 문서를 지움
      body = { id, _del: true }; props = { t: String(t), d: cfg.dev, k: 'del' };
    } else {
      body = clean(doc);
      const base = await getBase(id);
      let blobUp = false;
      if (BLOB_KINDS.includes(doc.kind) && doc.blob && cfg.files && doc.blob.size <= BLOB_MAX && (!m.bf || m.bs !== doc.blob.size)) blobUp = true;
      if (m.f && base && !blobUp && stable(body) === stable(base)) { m.r = t; touch(m); return; } // 바뀐 것 없음
      if (blobUp) {
        const old = m.bf;
        const type = doc.blob.type || doc.mime || doc.type || 'application/octet-stream';
        const r = await upload(null, id + '.bin', { k: 'blob', of: id, d: cfg.dev }, doc.blob, type);
        m.bf = r.id; m.bs = doc.blob.size; m.bt = type; touch(m);
        if (old) delFile(old);
        stats.files++;
      }
      if (BLOB_KINDS.includes(doc.kind) && m.bf) { body._bf = m.bf; body._bs = m.bs || 0; body._bt = m.bt || ''; }
      props = { t: String(t), d: cfg.dev, k: doc.kind };
    }
    const content = new Blob([JSON.stringify(body)], { type: 'application/json' });
    let res;
    try { res = await upload(m.f || null, id + '.json', props, content, 'application/json'); }
    catch (e) {
      if (e.code !== 'gone') throw e;
      m.f = ''; m.fc = '';
      res = await upload(null, id + '.json', props, content, 'application/json');
    }
    m.f = res.id; if (!m.fc) m.fc = res.createdTime; m.r = t;
    if (body._del) { setBase(id, null); if (m.bf) { delFile(m.bf); m.bf = ''; } }
    else setBase(id, clean(body));
    touch(m);
    stats.sent++;
  }
  async function push(stats, changes) {
    const ids = [...meta.values()].filter(dirty).map(m => m.id);
    let i = 0;
    const worker = async () => { while (i < ids.length) { const id = ids[i++]; await pushOne(id, stats, changes, 0); progress(stats, ids.length); } };
    await Promise.all([worker(), worker(), worker()]);
  }

  /* ---------- 녹음·붙인 파일 내려받기 ---------- */
  let dlBusy = false;
  async function fetchBlobs() {
    if (dlBusy || !cfg.on || !cfg.files || !hasToken()) return;
    dlBusy = true;
    let n = 0;
    try {
      for (const m of [...meta.values()]) {
        if (!m.bf || !BLOB_KINDS.includes(m.k) || !hasToken()) continue;
        const doc = await db.get(m.id);
        if (!doc || (doc.blob && doc.blob.size === m.bs)) continue;
        const b = await api(API + '/files/' + m.bf + '?alt=media', null, 'blob').catch(() => null);
        if (!b) continue;
        const fresh = await db.get(m.id);
        if (!fresh) continue;
        fresh.blob = new Blob([b], { type: m.bt || fresh.mime || fresh.type || b.type || '' });
        await raw.putRaw(fresh);
        n++;
        if (A() && A().afterRemote) A().afterRemote([{ id: m.id, doc: fresh, kind: m.k }]);
      }
    } finally { dlBusy = false; notify(); }
    return n;
  }
  // 이 기기에 내용이 없는 녹음·파일: 'wait'(받는 중) / 'off'(파일 맞추기 꺼짐) / ''(드라이브에도 없음)
  function inCloud(id) {
    const m = meta.get(id);
    if (!cfg.on || !m || !m.bf) return '';
    return cfg.files ? 'wait' : 'off';
  }

  /* ---------- 맞추기 한 번 ---------- */
  let running = null, queued = null, deferTimer = null;
  function setErr(code, msg, url) { cfg.err = code; cfg.errMsg = msg || ''; cfg.errUrl = url || ''; saveCfg(); notify(); }
  function handleErr(e) {
    if (e.code === 'token' || e.code === 'net') return;
    if (e.code === 'api-off') {
      const m = /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"]+/.exec(e.message || '');
      setErr('api-off', '구글 클라우드에서 「Google Drive API」를 켜야 해요(처음 한 번).', m ? m[0] : 'https://console.cloud.google.com/apis/library/drive.googleapis.com');
    } else if (e.code === 'scope') setErr('scope', '구글 권한 창에서 「끄적노트 전용 공간(Google Drive)」 항목에 체크해야 맞출 수 있어요. 끄고 다시 켜 주세요.');
    else if (e.code === 'full') setErr('full', '구글 드라이브 저장 공간이 가득 찼어요.');
    else setErr('http', '맞추는 중 문제가 생겼어요: ' + (e.message || e));
  }
  function progress(stats, total) {
    if (total > 20) { stats.total = total; notify(); }
  }
  function run(why) {
    if (!cfg.on) return Promise.resolve(null);
    if (running) { // 맞추는 중이면 끝난 뒤 한 번 더(부른 쪽은 그것까지 기다림)
      if (!queued) queued = running.then(() => { queued = null; return run(why); });
      return queued;
    }
    if (!navigator.onLine || !hasToken()) { notify(); return Promise.resolve(null); }
    if (A() && A().S && A().S.busy) { clearTimeout(deferTimer); deferTimer = setTimeout(() => run('busy'), 5000); return Promise.resolve(null); }
    clearTimeout(pushTimer); firstPend = 0;
    const stats = { got: 0, sent: 0, files: 0, total: 0 };
    const changes = [];
    running = (async () => {
      notify();
      try {
        await loadMeta();
        if (!cfg.seeded) await markAll(); // 켠 뒤 처음 끝까지 맞출 때까지: 이 기기 문서를 모두 올릴 대상으로(같은 것은 안 올림)
        const deferred = await pull(changes, stats);
        await push(stats, changes);
        cfg.seeded = true;
        if (!cfg.email) { try { const a = await api(API + '/about?fields=' + enc('user(emailAddress)')); cfg.email = (a && a.user && a.user.emailAddress) || ''; } catch (e) { /* 계정 이름 없이도 맞춤 */ } }
        cfg.last = Date.now(); if (cfg.err && cfg.err !== 'scope') { cfg.err = ''; cfg.errMsg = ''; cfg.errUrl = ''; }
        cfg.stats = { got: stats.got, sent: stats.sent, at: cfg.last };
        saveCfg();
        if (deferred) { clearTimeout(deferTimer); deferTimer = setTimeout(() => run('deferred'), 2500); }
      } catch (e) { handleErr(e); }
      finally {
        await flushMeta();
        if (changes.length && A() && A().afterRemote) { try { A().afterRemote(changes); } catch (e) { console.warn(e); } }
        running = null;
        notify();
        if (!queued && cfg.files && hasToken()) fetchBlobs();
      }
      return stats;
    })();
    return running;
  }
  let pushTimer = null, firstPend = 0;
  function pushSoon() {
    if (!cfg.on) return;
    const now = Date.now();
    if (!firstPend) firstPend = now;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { firstPend = 0; run('push'); }, Math.max(0, Math.min(4000, firstPend + 20000 - now)));
    notify();
  }

  /* ---------- 켜기·끄기 ---------- */
  async function enable() {
    const ok = await login(true);
    if (!ok) return;
    let email = '';
    try { const a = await api(API + '/about?fields=' + enc('user(emailAddress)')); email = (a && a.user && a.user.emailAddress) || ''; }
    catch (e) { if (e.code === 'api-off' || e.code === 'scope') { cfg.on = true; cfg.seeded = false; saveCfg(); handleErr(e); renderBox(); return; } }
    await loadMeta();
    if (cfg.email && email && cfg.email !== email) await resetLocal(); // 다른 구글 계정 → 처음부터
    cfg.email = email || cfg.email; cfg.on = true; cfg.err = ''; cfg.errMsg = ''; cfg.errUrl = '';
    saveCfg();
    cfg.seeded = false; saveCfg(); // 처음 맞출 때 이 기기 문서를 모두 올림(run에서)
    toast('구글 드라이브와 맞추는 중이에요. 처음에는 조금 걸려요.', null, null, 6000);
    renderBox();
    const st = await run('first');
    if (st && !cfg.err) toast('맞췄어요 · 받은 것 ' + st.got + '개 · 올린 것 ' + st.sent + '개' + (st.files ? ' (녹음·파일 ' + st.files + '개)' : ''), null, null, 6000);
  }
  async function markAll() {
    (await db.all()).forEach(d => {
      if (!KINDS.includes(d.kind)) return;
      const m = meta.get(d.id) || { id: d.id };
      m.t = tick(); m.k = d.kind; touch(m);
    });
  }
  async function resetLocal() {
    meta.clear(); baseCache.clear(); cfg.cursor = '';
    await tx('meta', 'readwrite', s => s.clear()).catch(() => {});
    await tx('base', 'readwrite', s => s.clear()).catch(() => {});
  }
  function disable() {
    cfg.on = false; saveCfg();
    try { if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* 무시 */ }
    token = null; tokenExp = 0; lsSet(LS_TOK, null);
    clearTimeout(pushTimer);
    notify();
    toast('이 기기에서 맞추기를 껐어요. 노트는 이 기기와 드라이브에 그대로 있어요.');
  }
  // 위쪽 구름 버튼
  function tap() {
    if (!cfg.on || ['api-off', 'scope', 'full'].includes(cfg.err)) { if (A()) A().openSettings(); return; }
    syncNow();
  }
  function syncNow() {
    const done = st => { if (st && !cfg.err) toast(st.got || st.sent ? '맞췄어요 · 받은 것 ' + st.got + '개 · 올린 것 ' + st.sent + '개' : '이미 맞춰져 있어요'); };
    if (!hasToken()) { login(cfg.err === 'scope').then(ok => { if (ok) run('tap').then(done); }); return; }
    run('tap').then(done);
  }

  /* ---------- 화면 ---------- */
  function stateNow() {
    if (!cfg.on) return 'off';
    if (!navigator.onLine) return 'offline';
    if (running) return 'busy';
    if (['api-off', 'scope', 'full'].includes(cfg.err)) return 'err';
    if (!hasToken()) return 'need';
    if (cfg.err) return 'err';
    return 'ok';
  }
  const stamp = ms => (KK.date ? KK.date.stamp(ms) : new Date(ms).toLocaleString());
  function notify() {
    const b = document.getElementById('cloudBtn');
    if (b) {
      const s = stateNow(), n = pendingCount();
      b.hidden = s === 'off';
      b.dataset.s = s;
      const T = document.getElementById('cloudT');
      if (T) T.textContent = s === 'need' ? '맞추기' : s === 'err' ? '맞추기 확인' : '';
      b.classList.toggle('pend', n > 0 && s !== 'busy');
      b.title = s === 'need' ? '구글 로그인이 끝났어요. 누르면 다시 로그인하고 다른 기기와 맞춰요' + (n ? ' (올릴 것 ' + n + '개)' : '')
        : s === 'busy' ? '다른 기기와 맞추는 중' : s === 'offline' ? '오프라인 · 연결되면 맞춰요' : s === 'err' ? (cfg.errMsg || '맞추기 문제') : '다른 기기와 맞춤' + (cfg.last ? ' · ' + stamp(cfg.last) : '') + ' (누르면 지금 맞추기)';
      b.setAttribute('aria-label', b.title);
    }
    const dlg = document.getElementById('dlgSettings');
    if (dlg && dlg.open) renderBox();
  }
  function renderBox() {
    const box = document.getElementById('syncBox');
    if (!box || !KK.ui) return;
    const { h } = KK.ui;
    box.textContent = '';
    if (!cfg.on) {
      box.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => enable() }, '구글 드라이브로 맞추기 켜기')));
      box.append(h('p', { class: 'hint' }, '노트북에서는 크롬(또는 엣지)으로 이 앱 주소를 열고, 설정에서 같은 구글 계정으로 켜면 돼요.'));
      return;
    }
    const s = stateNow(), n = pendingCount();
    const line = [!hasToken() ? '켜짐 · 다시 로그인 필요(1시간마다)' : s === 'offline' ? '켜짐 · 오프라인' : '켜짐', cfg.email ? '계정 ' + cfg.email : '계정 확인 전'].filter(Boolean).join(' · ');
    box.append(h('p', null, line));
    box.append(h('p', { class: 'hint' }, (s === 'busy' ? '맞추는 중…' : cfg.last && cfg.seeded ? '마지막으로 맞춘 때 ' + stamp(cfg.last) : '아직 이 기기 노트를 다 올리지 못함 · 「다시 로그인하고 맞추기」를 눌러 주세요') + (n ? ' · 올릴 것 ' + n + '개' : '')));
    if (cfg.err) {
      const p = h('p', { class: 'hint', style: 'color:var(--danger)' }, cfg.errMsg || '맞추기 문제');
      if (cfg.errUrl) p.append(' ', h('a', { href: cfg.errUrl, target: '_blank', rel: 'noopener' }, '설정 화면 열기'));
      box.append(p);
    }
    box.append(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', disabled: s === 'busy' || s === 'offline', onclick: () => syncNow() }, !hasToken() ? '다시 로그인하고 맞추기' : '지금 맞추기'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => disable() }, '이 기기에서 끄기')));
    box.append(h('label', { class: 'chkrow', for: 'syncFiles' },
      h('input', { type: 'checkbox', id: 'syncFiles', checked: cfg.files, onchange: e => { cfg.files = e.target.checked; saveCfg(); if (cfg.files) { markBlobs(); pushSoon(); } } }),
      '녹음 파일·붙인 파일도 맞추기 (용량이 커서 와이파이에서 권장)'));
    box.append(h('p', { class: 'hint' }, '두 기기 모두 같은 구글 계정으로 켜야 해요. 같은 노트를 양쪽에서 고쳤으면 두 쪽 글을 모두 남겨요.'));
  }
  // 파일 맞추기를 다시 켰을 때 아직 안 올린 녹음·파일 표시
  async function markBlobs() {
    await loadMeta();
    (await db.all()).forEach(d => {
      if (!BLOB_KINDS.includes(d.kind) || !d.blob) return;
      const m = meta.get(d.id) || { id: d.id, k: d.kind };
      if (!m.bf || m.bs !== d.blob.size) { m.t = tick(); touch(m); }
    });
  }

  /* ---------- 언제 맞추나 ---------- */
  // 앱을 열 때: 다른 기기에서 바뀐 것을 먼저 받음(최대 3초, 나머지는 뒤에서)
  async function startup() {
    await loadMeta();
    if (cfg.on) loadGIS().catch(() => {});
    notify();
    if (!cfg.on || !hasToken() || !navigator.onLine) return;
    await Promise.race([run('start'), sleep(3000)]);
  }
  let lastAuto = 0;
  function auto(why) {
    if (!cfg.on || document.visibilityState === 'hidden') return;
    if (Date.now() - lastAuto < 10000 && why !== 'online') return;
    lastAuto = Date.now();
    run(why);
  }
  document.addEventListener('visibilitychange', () => {
    if (!cfg.on) return;
    if (document.visibilityState === 'visible') { notify(); auto('visible'); }
    else if (hasToken() && pendingCount()) { if (A() && A().flushPending) A().flushPending(); run('hidden'); }
  });
  window.addEventListener('online', () => { notify(); auto('online'); });
  window.addEventListener('offline', notify);
  setInterval(() => { notify(); if (hasToken()) auto('poll'); }, 45000);

  KK.sync = {
    cfg, startup, run, tap, syncNow, enable, disable, renderBox, notify, inCloud, fetchBlobs, hasToken, pendingCount, loadGIS,
    _t: { merge3, mergeText, mergeStrokes, stable, meta, setToken: (t, exp) => { token = t; tokenExp = exp; lsSet(LS_TOK, t ? { token: t, exp } : null); notify(); } },
  };
})();
