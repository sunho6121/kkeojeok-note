'use strict';
/* 끄적노트 — 구글 캘린더 연결: 일정 읽어 오기 · 끄적노트 일정 자동 등록 · 중복 판별 */
window.KK = window.KK || {};

(function () {
  const D = KK.date;
  const { toast } = KK.ui;
  const API = 'https://www.googleapis.com/calendar/v3';
  const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const LS_CFG = 'kk-gcal', LS_TOK = 'kk-gtok', LS_EV = 'kk-gcal-ev';
  const A = () => KK.app;

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 무시 */ } };

  // 사용자 본인의 Google Cloud 프로젝트(sunho note)에서 만든 웹 클라이언트 ID — 공개돼도 되는 값
  const DEFAULT_CLIENT_ID = '277084713279-0c5jubei6ki1h760rvtu4q5l2nommtm0.apps.googleusercontent.com';
  const cfg = Object.assign({ clientId: '', connected: false, autoPush: true, writeCal: 'primary', showCals: null, cals: [], lastSync: 0, needsAuth: false }, lsGet(LS_CFG, {}));
  if (!cfg.clientId) cfg.clientId = DEFAULT_CLIENT_ID;
  const saveCfg = () => lsSet(LS_CFG, cfg);
  let token = null, tokenExp = 0;
  (() => { const t = lsGet(LS_TOK, null); if (t && t.exp > Date.now() + 60000) { token = t.token; tokenExp = t.exp; } })();
  let events = lsGet(LS_EV, []) || [];
  let lastFetch = 0, fetching = null, tokenClient = null, tokenClientId = '', gis = null, afterToken = [];

  const hasToken = () => !!token && tokenExp > Date.now() + 60000;
  const ready = () => cfg.connected && !!cfg.clientId;

  /* ---------- 로그인 (Google Identity Services) ---------- */
  function loadGIS() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gis) return gis;
    gis = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res(); s.onerror = () => { gis = null; rej(new Error('gis')); };
      document.head.append(s);
    });
    return gis;
  }
  function client() {
    if (!cfg.clientId || !(window.google && google.accounts && google.accounts.oauth2)) return null;
    if (tokenClient && tokenClientId === cfg.clientId) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId, scope: SCOPES,
      callback: resp => {
        if (!resp || resp.error) { finishAuth(false, resp && resp.error); return; }
        token = resp.access_token; tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        lsSet(LS_TOK, { token, exp: tokenExp });
        cfg.connected = true; cfg.needsAuth = false; saveCfg();
        finishAuth(true);
      },
      error_callback: err => finishAuth(false, err && err.type),
    });
    tokenClientId = cfg.clientId;
    return tokenClient;
  }
  function finishAuth(ok, why) {
    const fns = afterToken; afterToken = [];
    fns.forEach(f => f(ok));
    if (!ok && why !== 'popup_closed') toast('구글 연결을 마치지 못했어요. 다시 눌러 주세요.');
    notify();
    if (ok) sync(true);
  }
  /* 반드시 버튼을 누른 순간에 불러야 해요 (팝업 차단 방지) */
  function connect(forceConsent) {
    if (!cfg.clientId) { toast('설정에서 구글 클라이언트 ID를 먼저 넣어 주세요.'); return; }
    if (!navigator.onLine) { toast('구글 연결은 인터넷이 필요해요.'); return; }
    const c = client();
    if (!c) { loadGIS().then(client).catch(() => {}); toast('구글 로그인을 준비하고 있어요. 1~2초 뒤 다시 눌러 주세요.'); return; }
    c.requestAccessToken({ prompt: forceConsent || !cfg.connected ? 'consent' : '' });
  }
  function disconnect() {
    try { if (token && window.google) google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* 무시 */ }
    token = null; tokenExp = 0; lsSet(LS_TOK, null);
    cfg.connected = false; cfg.needsAuth = false; cfg.cals = []; cfg.showCals = null; saveCfg();
    events = []; lsSet(LS_EV, []);
    notify();
  }

  /* ---------- API ---------- */
  async function api(path, opt) {
    if (!hasToken()) { cfg.needsAuth = cfg.connected; saveCfg(); const e = new Error('token'); e.code = 'token'; throw e; }
    const o = opt || {};
    const res = await fetch(API + path, Object.assign({}, o, { headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, o.headers || {}) }));
    if (res.status === 401) { token = null; tokenExp = 0; cfg.needsAuth = true; saveCfg(); const e = new Error('token'); e.code = 'token'; throw e; }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const e = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status);
      e.code = res.status === 404 || res.status === 410 ? 'gone' : 'api'; throw e;
    }
    return data;
  }

  async function refreshCalendars() {
    const d = await api('/users/me/calendarList?maxResults=250');
    cfg.cals = (d.items || []).map(c => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, role: c.accessRole }));
    if (!cfg.showCals) { cfg.showCals = {}; cfg.cals.forEach(c => { cfg.showCals[c.id] = true; }); }
    if (!cfg.cals.some(c => c.id === cfg.writeCal) && cfg.writeCal !== 'primary') cfg.writeCal = 'primary';
    saveCfg();
  }

  function toEntry(e, cal) {
    const allDay = !!(e.start && e.start.date);
    let date, time = '', endTime = '';
    if (allDay) date = e.start.date;
    else {
      const s = new Date(e.start.dateTime);
      date = D.ymd(s); time = D.pad(s.getHours()) + ':' + D.pad(s.getMinutes());
      if (e.end && e.end.dateTime) { const en = new Date(e.end.dateTime); endTime = D.pad(en.getHours()) + ':' + D.pad(en.getMinutes()); }
    }
    const priv = (e.extendedProperties && e.extendedProperties.private) || {};
    return { src: 'g', id: e.id, calId: cal.id, calName: cal.primary ? '구글' : cal.name, title: e.summary || '(제목 없음)', date, time, endTime, place: e.location || '', detail: (e.description || '').slice(0, 200), link: e.htmlLink || '', kk: priv.kkItem || '' };
  }

  async function fetchEvents(force) {
    if (!ready() || !navigator.onLine) return events;
    if (!force && Date.now() - lastFetch < 5 * 60000) return events;
    if (fetching) return fetching;
    fetching = (async () => {
      if (!cfg.cals.length) await refreshCalendars();
      const now = new Date();
      const timeMin = D.addDays(now, -14).toISOString(), timeMax = D.addDays(now, 120).toISOString();
      const out = [];
      for (const c of cfg.cals.filter(x => cfg.showCals[x.id] !== false)) {
        let pageToken = '';
        do {
          const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '250' });
          if (pageToken) q.set('pageToken', pageToken);
          const d = await api('/calendars/' + encodeURIComponent(c.id) + '/events?' + q);
          (d.items || []).forEach(e => { if (e.status !== 'cancelled' && e.start) out.push(toEntry(e, c)); });
          pageToken = d.nextPageToken || '';
        } while (pageToken);
      }
      events = out; lastFetch = Date.now(); lsSet(LS_EV, events);
      return events;
    })().finally(() => { fetching = null; });
    return fetching;
  }

  /* ---------- 중복 판별 ---------- */
  const norm = t => String(t || '').toLowerCase().replace(/^\s*\[(취소|보류|할 일)\]\s*/, '').replace(/[\s[\]().,·:;!?~\-_/'"]/g, '');
  function bigrams(s) { const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2)); return a; }
  function titleSim(x, y) {
    const a = norm(x), b = norm(y);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if ((a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b))) return 0.9;
    const A2 = bigrams(a), B2 = bigrams(b).slice();
    if (!A2.length || !B2.length) return 0;
    let m = 0;
    A2.forEach(g => { const i = B2.indexOf(g); if (i >= 0) { m++; B2.splice(i, 1); } });
    return (2 * m) / (A2.length + bigrams(b).length);
  }
  const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  function sameEvent(a, b) {
    if (!a.date || a.date !== b.date) return false;
    if (a.time && b.time && Math.abs(mins(a.time) - mins(b.time)) > 30) return false;
    return titleSim(a.title, b.title) >= 0.6;
  }

  /* ---------- 끄적노트 → 구글 등록 ---------- */
  function bodyOf(it) {
    const prefix = it.status === 'hold' ? '[보류] ' : '';
    const b = {
      summary: prefix + (it.type === 'task' ? '[할 일] ' : '') + it.title,
      location: it.place || '',
      description: [it.detail, '끄적노트에서 정리한 일정'].filter(Boolean).join('\n'),
      extendedProperties: { private: { kkItem: it.id } },
    };
    if (it.time) {
      const [y, m, d] = it.date.split('-').map(Number), [hh, mm] = it.time.split(':').map(Number);
      const st = new Date(y, m - 1, d, hh, mm);
      let en = new Date(st.getTime() + 3600000);
      if (it.endTime) { const [eh, em] = it.endTime.split(':').map(Number); en = new Date(y, m - 1, d, eh, em); if (en <= st) en = new Date(en.getTime() + 86400000); }
      const f = x => D.ymd(x) + 'T' + D.pad(x.getHours()) + ':' + D.pad(x.getMinutes()) + ':00';
      b.start = { dateTime: f(st), timeZone: 'Asia/Seoul' }; b.end = { dateTime: f(en), timeZone: 'Asia/Seoul' };
    } else {
      b.start = { date: it.date }; b.end = { date: D.ymd(D.addDays(D.parse(it.date), 1)) };
    }
    return b;
  }

  async function pushItem(it) {
    const want = !it.deleted && !!it.date && ['todo', 'doing', 'hold', 'done'].includes(it.status || 'todo');
    if (it.gEventId) {
      const path = '/calendars/' + encodeURIComponent(it.gCalId || 'primary') + '/events/' + encodeURIComponent(it.gEventId);
      if (!want) {
        try { await api(path, { method: 'DELETE' }); } catch (e) { if (e.code !== 'gone') throw e; }
        it.gEventId = ''; it.gCalId = ''; it.gHash = '';
        return true;
      }
      const body = bodyOf(it), hsh = JSON.stringify(body);
      if (hsh === it.gHash) return false;
      try { await api(path, { method: 'PATCH', body: hsh }); }
      catch (e) { if (e.code !== 'gone') throw e; it.gEventId = ''; it.gHash = ''; return pushItem(it); }
      it.gHash = hsh;
      return true;
    }
    if (!want || it.status === 'done' || it.gLinked) return false;
    const dup = events.find(e => !e.kk && sameEvent(it, e));
    if (dup) { it.gLinked = dup.calId + '|' + dup.id; return true; } // 이미 캘린더(그룹웨어 등)에 있는 일정 → 새로 만들지 않고 연결만
    const body = bodyOf(it), hsh = JSON.stringify(body);
    const ev = await api('/calendars/' + encodeURIComponent(cfg.writeCal || 'primary') + '/events', { method: 'POST', body: hsh });
    it.gEventId = ev.id; it.gCalId = cfg.writeCal || 'primary'; it.gHash = hsh;
    return true;
  }

  let syncing = false, syncTimer = null;
  async function sync(force) {
    if (!ready() || !navigator.onLine || syncing) return;
    if (!hasToken()) { cfg.needsAuth = true; saveCfg(); notify(); return; }
    syncing = true; notify();
    try {
      await fetchEvents(true);
      if (cfg.autoPush) {
        const S = A().S, changed = [];
        for (const it of S.items.values()) {
          if (!it.date && !it.gEventId) continue;
          if (await pushItem(it)) changed.push(it);
        }
        if (changed.length) { await KK.db.putMany(changed); await fetchEvents(true); }
      }
      cfg.lastSync = Date.now(); cfg.needsAuth = false; saveCfg();
    } catch (e) {
      if (e.code !== 'token') toast('구글 캘린더 동기화 중 문제가 생겼어요: ' + e.message, null, null, 6000);
    } finally { syncing = false; notify(); }
  }
  function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), 1500); }

  /* 노트를 지울 때 끄적노트가 만든 캘린더 일정도 지운다 */
  async function removeOwned(items) {
    if (!ready() || !hasToken()) return;
    for (const it of items) {
      if (!it.gEventId) continue;
      try { await api('/calendars/' + encodeURIComponent(it.gCalId || 'primary') + '/events/' + encodeURIComponent(it.gEventId), { method: 'DELETE' }); } catch (e) { /* 이미 없으면 그대로 둔다 */ }
    }
    fetchEvents(true).then(notify).catch(() => {});
  }

  /* 화면 갱신 알림 */
  function notify() { if (KK.views && A()) { KK.views.renderSched(); if (KK.views.renderGcalSettings) KK.views.renderGcalSettings(); } }

  KK.gcal = {
    cfg, saveCfg, connect, disconnect, sync, syncSoon, removeOwned, fetchEvents, refreshCalendars, titleSim, sameEvent,
    get events() { return events; }, get syncing() { return syncing; },
    hasToken, ready, loadGIS,
    async afterConnect(fn) { afterToken.push(fn); },
  };

  // 설정이 있으면 미리 로그인 모듈을 받아 둔다 (버튼을 누를 때 바로 창이 뜨도록)
  if (cfg.clientId && navigator.onLine) loadGIS().then(client).catch(() => {});
})();
