'use strict';
/* 끄적노트 — 화면 동작 */
(function () {
  const D = KK.date, db = KK.db;
  const $ = id => document.getElementById(id);
  const TRIGGERS = ['//', '@정리', '정리!!'];

  const S = { notes: new Map(), items: new Map(), cur: null, filter: 'all', day: null, q: '', busy: null, mode: 'type', lastDay: D.today() };
  const DEFAULTS = { apiKey: '', model: 'claude-sonnet-5-5', effort: 'high', v: 2 };
  const settings = loadSettings();

  /* ---------- 작은 도우미 ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
    return el;
  }
  function svg(path) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = path; return s;
  }
  const ICON = {
    check: '<path d="M5 12l5 5 9-10" stroke-width="3"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4M12 13v4M10 15h4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  };
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } }
  function loadSettings() {
    let s;
    try { s = JSON.parse(lsGet('kk-settings', '{}')) || {}; } catch (e) { s = {}; }
    // v1에서 저장된 기본값(Opus)은 새 기본값(Sonnet 5.5 · 높음)으로 바꾼다. 키는 그대로 둔다.
    if (s.v !== 2) { s.model = DEFAULTS.model; s.effort = DEFAULTS.effort; s.v = 2; }
    return Object.assign({}, DEFAULTS, s);
  }
  function saveSettings() { lsSet('kk-settings', JSON.stringify(settings)); }
  const isWide = () => window.matchMedia('(min-width:1100px)').matches;

  /* ---------- 토스트 ---------- */
  let toastTimer;
  function toast(text, btnLabel, fn, ms) {
    const t = $('toast'), b = $('toastBtn');
    $('toastText').textContent = text;
    b.hidden = !btnLabel; b.textContent = btnLabel || '';
    b.onclick = () => { t.hidden = true; fn && fn(); };
    t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || (btnLabel ? 6000 : 3500));
  }

  /* ---------- 노트 ---------- */
  const bodyEl = $('body'), titleEl = $('noteTitle');
  const curNote = () => (S.cur ? S.notes.get(S.cur) : null);
  function notesSorted() { return [...S.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt); }

  function ensureNote() {
    let n = curNote();
    if (n) return n;
    const now = Date.now();
    n = { id: 'n-' + KK.uid(), kind: 'note', title: titleEl.value.trim(), titleAuto: !titleEl.value.trim(), body: bodyEl.value, summary: [], tags: [], createdAt: now, updatedAt: now, organizedAt: 0, pending: false, hasInk: false };
    S.notes.set(n.id, n); S.cur = n.id; lsSet('kk-last', n.id);
    db.put(n); renderList(); $('btnDelNote').hidden = false;
    return n;
  }

  let saveTimer = null;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 500); }
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = null;
    const n = curNote(); if (n) db.put(n);
    flushInk();
  }

  function openNote(id) {
    flushSave();
    S.cur = id && S.notes.has(id) ? id : null;
    const n = curNote();
    titleEl.value = n ? n.title : '';
    bodyEl.value = n ? n.body : '';
    $('btnDelNote').hidden = !n;
    if (n) lsSet('kk-last', n.id);
    ink.reset([]);
    if (n && n.hasInk) db.get('ink-' + n.id).then(d => { if (S.cur === n.id && d) { ink.reset(d.strokes); updatePenHint(); } });
    updatePenHint();
    renderList(); renderResult();
  }

  function newNote() {
    flushSave();
    S.cur = null; titleEl.value = ''; bodyEl.value = ''; ink.reset([]);
    $('btnDelNote').hidden = true;
    renderList(); renderResult(); updatePenHint();
    setView('write');
    if (S.mode === 'type') bodyEl.focus();
  }

  function deleteNote() {
    const n = curNote(); if (!n) return;
    const its = [...S.items.values()].filter(i => i.noteId === n.id && !i.done);
    const inkDoc = { id: 'ink-' + n.id, kind: 'ink', strokes: ink.strokes().slice() };
    S.notes.delete(n.id); its.forEach(i => S.items.delete(i.id));
    db.delMany([n.id, inkDoc.id, ...its.map(i => i.id)]);
    S.cur = null;
    const next = notesSorted()[0];
    openNote(next ? next.id : null); renderSched();
    toast('노트를 지웠어요', '되돌리기', () => {
      S.notes.set(n.id, n); its.forEach(i => S.items.set(i.id, i));
      db.putMany([n, ...its, ...(inkDoc.strokes.length ? [inkDoc] : [])]);
      openNote(n.id); renderSched();
    });
  }

  /* 입력 & 정리 신호 */
  let trigTimer = null, listTimer = null;
  function onBodyInput() {
    const n = ensureNote();
    n.body = bodyEl.value; n.updatedAt = Date.now();
    scheduleSave(); checkTrigger();
    clearTimeout(listTimer); listTimer = setTimeout(() => { renderList(); renderResult(); }, 400);
  }
  function lastLine(v) { const lines = v.replace(/\s+$/, '').split('\n'); return (lines[lines.length - 1] || '').trim(); }
  function checkTrigger() {
    clearTimeout(trigTimer);
    if (!TRIGGERS.includes(lastLine(bodyEl.value))) return;
    trigTimer = setTimeout(() => {
      if (!TRIGGERS.includes(lastLine(bodyEl.value))) return;
      const lines = bodyEl.value.replace(/\s+$/, '').split('\n'); lines.pop();
      bodyEl.value = lines.join('\n').replace(/\s+$/, '');
      const n = ensureNote(); n.body = bodyEl.value; n.updatedAt = Date.now(); flushSave();
      organize();
    }, 800);
  }

  /* ---------- 필기 ---------- */
  let inkTimer = null, inkDirty = false;
  const ink = KK.createInk($('ink'), {
    onChange() {
      const n = ensureNote();
      n.hasInk = !ink.isEmpty(); n.updatedAt = Date.now();
      inkDirty = true; clearTimeout(inkTimer); inkTimer = setTimeout(flushInk, 600);
      scheduleSave(); updatePenHint();
      clearTimeout(listTimer); listTimer = setTimeout(() => { renderList(); renderResult(); }, 400);
    },
  });
  function flushInk() {
    clearTimeout(inkTimer);
    const n = curNote(); if (!n || !inkDirty) return;
    inkDirty = false;
    if (ink.isEmpty()) db.del('ink-' + n.id);
    else db.put({ id: 'ink-' + n.id, kind: 'ink', strokes: ink.strokes() });
  }
  function updatePenHint() { $('penHint').hidden = !ink.isEmpty(); }
  function setMode(m) {
    S.mode = m;
    $('modeType').setAttribute('aria-pressed', String(m === 'type'));
    $('modePen').setAttribute('aria-pressed', String(m === 'pen'));
    $('penWrap').hidden = m !== 'pen';
    lsSet('kk-mode', m);
    if (m === 'pen') requestAnimationFrame(() => ink.resize());
  }
  document.querySelectorAll('.pentools [data-color]').forEach(b => b.addEventListener('click', () => {
    ink.setColor(b.dataset.color);
    document.querySelectorAll('.pentools button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('penErase').addEventListener('click', () => {
    const on = $('penErase').getAttribute('aria-pressed') !== 'true';
    ink.setEraser(on);
    document.querySelectorAll('.pentools [data-color]').forEach(x => x.setAttribute('aria-pressed', 'false'));
    $('penErase').setAttribute('aria-pressed', String(on));
    if (!on) document.querySelector('.pentools [data-color="ink"]').click();
  });
  $('penUndo').addEventListener('click', () => ink.undo());
  $('penClear').addEventListener('click', () => {
    if (ink.isEmpty()) return;
    ink.clear(); toast('필기를 모두 지웠어요', '되돌리기', () => ink.undo());
  });

  /* ---------- 정리 (Claude) ---------- */
  async function organize() {
    if (S.busy) return;
    const text = bodyEl.value.trim();
    if (!text && ink.isEmpty()) { toast('먼저 내용을 적어 주세요'); return; }
    const n = ensureNote(); flushSave();
    if (!settings.apiKey) {
      n.pending = true; db.put(n); renderList(); renderResult();
      toast('정리하려면 Claude API 키가 필요해요. 노트는 저장됐어요.', '설정 열기', openSettings); return;
    }
    if (!navigator.onLine) {
      n.pending = true; db.put(n); renderList(); renderResult();
      toast('인터넷이 없어 정리 대기로 두었어요. 연결되면 자동으로 정리해요.'); return;
    }
    await runOrganize(n, true);
  }

  async function runOrganize(n, interactive) {
    const isCur = n.id === S.cur;
    const text = (isCur ? bodyEl.value : n.body || '').trim();
    let imageB64 = null, hadInk = false;
    if (isCur && !ink.isEmpty()) { imageB64 = await ink.toPNGBase64(); hadInk = true; }
    else if (!isCur && n.hasInk) {
      const d = await db.get('ink-' + n.id);
      if (d && d.strokes && d.strokes.length) { imageB64 = await KK.strokesToPNGBase64(d.strokes); hadInk = true; }
    }
    const ctl = new AbortController();
    S.busy = { id: n.id, ctl }; setBusy(true, n);
    try {
      const out = await KK.claude.organize({ apiKey: settings.apiKey, model: settings.model, effort: settings.effort, text, imageB64, signal: ctl.signal });
      const c = applyResult(n, out, hadInk);
      const parts = [];
      if (c.events) parts.push('약속 ' + c.events + '개');
      if (c.tasks) parts.push('할 일 ' + c.tasks + '개');
      const msg = parts.length ? '정리 완료 · ' + parts.join(', ') + '를 일정에 넣었어요' : '정리 완료 · 새 일정은 없어요';
      if (interactive || n.id === S.cur) toast(msg, !isWide() && parts.length ? '일정 보기' : null, () => setView('sched'));
    } catch (e) {
      if (e.code === 'offline') {
        n.pending = true; db.put(n);
        if (interactive) toast('인터넷이 끊겨 정리 대기로 두었어요. 연결되면 자동으로 정리해요.');
      } else if (e.code !== 'cancelled') {
        const m = errCopy(e);
        toast(m, e.code === 'bad_key' || e.code === 'bad_model' ? '설정 열기' : null, openSettings, 7000);
      }
    } finally {
      S.busy = null; setBusy(false); renderAll();
    }
  }

  function errCopy(e) {
    switch (e.code) {
      case 'bad_key': return 'API 키가 맞지 않아요. 설정에서 키를 확인해 주세요.';
      case 'forbidden': return '이 API 키로는 사용할 수 없어요. Anthropic 콘솔에서 권한·결제를 확인해 주세요.';
      case 'bad_model': return '선택한 모델을 쓸 수 없어요. 설정에서 다른 모델을 골라 주세요.';
      case 'rate': return '요청이 많거나 사용 한도에 닿았어요. 잠시 뒤 다시 정리해 주세요.';
      case 'server': return 'Claude 서버가 바빠요. 잠시 뒤 다시 정리해 주세요.';
      case 'too_large': return '메모나 필기가 너무 커요. 나눠서 정리해 주세요.';
      case 'refused': return '이 메모는 정리하지 못했어요. 내용을 조금 바꿔 다시 시도해 주세요.';
      case 'bad_output': return '정리 결과를 읽지 못했어요. 한 번 더 정리해 주세요.';
      default: return '정리하지 못했어요: ' + (e.message || '알 수 없는 오류');
    }
  }

  function applyResult(n, out, hadInk) {
    const now = Date.now();
    const isCur = n.id === S.cur;
    if (isCur) n.body = bodyEl.value;
    if (hadInk && out.transcript) {
      n.body = ((n.body || '').replace(/\s+$/, '') + '\n\n[필기 옮김 · ' + D.stamp(now) + ']\n' + out.transcript).replace(/^\s+/, '');
      n.hasInk = false;
      db.del('ink-' + n.id);
      if (isCur) { ink.reset([]); inkDirty = false; bodyEl.value = n.body; updatePenHint(); }
    }
    if (n.titleAuto !== false || !n.title) { n.title = out.title || n.title; n.titleAuto = true; if (isCur) titleEl.value = n.title; }
    n.summary = out.summary; n.tags = out.tags;
    n.updatedAt = now; n.organizedAt = now; n.pending = false; n.model = settings.model;

    const old = [...S.items.values()].filter(i => i.noteId === n.id);
    const keep = old.filter(i => i.done), drop = old.filter(i => !i.done);
    drop.forEach(i => S.items.delete(i.id));
    const key = i => (i.title + '|' + (i.date || '')).replace(/\s/g, '');
    const kept = new Set(keep.map(key));
    const fresh = [];
    out.items.forEach(it => {
      if (kept.has(key(it))) return;
      const doc = Object.assign({ id: 't-' + KK.uid(), kind: 'item', noteId: n.id, done: false, createdAt: now }, it);
      S.items.set(doc.id, doc); fresh.push(doc);
    });
    db.delMany(drop.map(i => i.id));
    db.putMany([n, ...fresh]);
    return { events: fresh.filter(i => i.type === 'event').length, tasks: fresh.filter(i => i.type === 'task').length };
  }

  let queueRunning = false;
  async function processQueue() {
    if (queueRunning || !navigator.onLine || !settings.apiKey) return;
    queueRunning = true;
    try {
      for (const n of notesSorted().filter(x => x.pending)) {
        if (!navigator.onLine) break;
        while (S.busy) await new Promise(r => setTimeout(r, 500));
        await runOrganize(n, false);
      }
    } finally { queueRunning = false; }
  }

  function setBusy(on, n) {
    $('busy').hidden = !on;
    $('btnOrganize').disabled = !!on;
    $('btnOrganize').textContent = on ? '정리 중…' : '정리하기';
    if (on) $('busyText').textContent = (n && n.id !== S.cur ? '「' + (n.title || '대기 노트') + '」 ' : '') + 'Claude가 메모를 꼼꼼히 읽고 있어요 · 길면 1분쯤 걸려요';
  }

  /* ---------- 렌더: 노트 목록 ---------- */
  function noteLabel(n) {
    if (n.title) return n.title;
    const first = (n.body || '').split('\n').map(s => s.trim()).find(Boolean);
    return first ? first.slice(0, 40) : (n.hasInk ? '필기 노트' : '빈 노트');
  }
  function renderList() {
    const ul = $('noteList'); ul.textContent = '';
    const q = S.q.trim().toLowerCase();
    const list = notesSorted().filter(n => !q || [n.title, n.body, (n.tags || []).join(' ')].join(' ').toLowerCase().includes(q));
    if (!list.length) {
      ul.append(h('li', { class: 'empty' }, q ? '찾는 노트가 없어요.' : '아직 노트가 없어요. 오른쪽(또는 쓰기 탭)에 바로 적어 보세요.'));
      return;
    }
    list.forEach(n => {
      const lines = (n.body || '').split('\n').map(s => s.trim()).filter(Boolean);
      const snippet = (n.summary && n.summary[0]) || (n.title ? lines[0] : lines[1]) || '';
      const chips = [h('span', { class: 'when' }, D.short(n.updatedAt))];
      if (n.pending) chips.push(h('span', { class: 'chip wait' }, '정리 대기'));
      else if (!n.organizedAt && (lines.length || n.hasInk)) chips.push(h('span', { class: 'chip new' }, '새 메모'));
      else if (n.organizedAt && n.updatedAt > n.organizedAt + 1500) chips.push(h('span', { class: 'chip plain' }, '수정됨'));
      if (n.hasInk) chips.push(h('span', { class: 'chip plain' }, '필기'));
      (n.tags || []).slice(0, 2).forEach(t => chips.push(h('span', { class: 'chip' }, t)));
      ul.append(h('li', null, h('button', {
        class: 'nitem', 'aria-current': String(n.id === S.cur),
        onclick: () => { openNote(n.id); setView('write'); },
      }, h('div', { class: 't' }, noteLabel(n)), snippet ? h('div', { class: 's' }, snippet) : null, h('div', { class: 'm' }, chips))));
    });
  }

  /* ---------- 렌더: 정리 결과 카드 ---------- */
  function renderResult() {
    const box = $('result'), n = curNote();
    box.textContent = '';
    if (!n || (!n.organizedAt && !n.pending)) { box.hidden = true; return; }
    box.hidden = false;
    if (n.pending && !n.organizedAt) {
      box.append(h('div', { class: 'rh' }, h('span', { class: 'chip wait' }, '정리 대기'),
        settings.apiKey ? '인터넷이 연결되면 자동으로 정리해요' : '설정에서 API 키를 넣으면 정리할 수 있어요'));
      return;
    }
    const its = [...S.items.values()].filter(i => i.noteId === n.id);
    const ev = its.filter(i => i.type === 'event').length, tk = its.filter(i => i.type === 'task').length;
    box.append(h('div', { class: 'rh' }, h('span', { class: 'chip' }, '정리됨'), h('span', { class: 'when' }, D.stamp(n.organizedAt)),
      n.pending ? h('span', { class: 'chip wait' }, '다시 정리 대기') : null));
    if (n.summary && n.summary.length) box.append(h('ul', null, n.summary.map(s => h('li', null, s))));
    const rf = h('div', { class: 'rf' }, (n.tags || []).map(t => h('span', { class: 'chip plain' }, '#' + t)));
    if (ev || tk) {
      rf.append(h('span', { class: 'when' }, '약속 ' + ev + ' · 할 일 ' + tk));
      if (!isWide()) rf.append(h('button', { class: 'linkbtn', onclick: () => setView('sched') }, '일정 보기'));
    }
    box.append(rf);
    if (n.updatedAt > n.organizedAt + 1500 && !n.pending) box.append(h('div', { class: 'stale' }, '정리 후 내용을 고쳤어요. 다시 정리하면 일정에 반영돼요.'));
  }

  /* ---------- 렌더: 일정 ---------- */
  function sortItems(a, b) {
    return (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99') || a.createdAt - b.createdAt;
  }
  function gcalUrl(it) {
    if (!it.date) return null;
    const d = it.date.replace(/-/g, '');
    let dates;
    if (it.time) {
      const [y, m, dd] = it.date.split('-').map(Number), [hh, mm] = it.time.split(':').map(Number);
      const st = new Date(y, m - 1, dd, hh, mm);
      let en;
      if (it.endTime) { const [eh, em] = it.endTime.split(':').map(Number); en = new Date(y, m - 1, dd, eh, em); if (en <= st) en = new Date(en.getTime() + 86400000); }
      else en = new Date(st.getTime() + 3600000);
      const f = x => D.ymd(x).replace(/-/g, '') + 'T' + D.pad(x.getHours()) + D.pad(x.getMinutes()) + '00';
      dates = f(st) + '/' + f(en);
    } else {
      dates = d + '/' + D.ymd(D.addDays(D.parse(it.date), 1)).replace(/-/g, '');
    }
    const p = new URLSearchParams({ action: 'TEMPLATE', text: it.title, dates, ctz: 'Asia/Seoul' });
    if (it.place) p.set('location', it.place);
    if (it.detail) p.set('details', it.detail);
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }
  function itemRow(it) {
    const today = D.today();
    const timeCell = h('div', { class: 'tm' });
    if (it.time) { timeCell.append(it.time); if (it.endTime) timeCell.append(h('small', null, '~' + it.endTime)); }
    else if (it.date && it.date !== today && S.day !== it.date) timeCell.append(h('small', null, D.dayLabel(it.date).replace(/^\d+월 /, '')));
    else timeCell.append(h('small', null, it.type === 'event' ? '하루' : '할 일'));
    const src = S.notes.get(it.noteId);
    const meta = h('div', { class: 'it-m' },
      it.priority === 'high' ? h('span', { class: 'pri' }, '중요') : null,
      it.date && it.date < today && !it.done ? h('span', { class: 'pri' }, D.dayLabel(it.date) + ' 지남') : null,
      it.place ? h('span', null, it.place) : null,
      it.detail ? h('span', null, it.detail) : null,
      src ? h('button', { onclick: () => { openNote(src.id); setView('write'); } }, noteLabel(src)) : null);
    const url = gcalUrl(it);
    return h('li', { class: 'it ' + (it.type === 'event' ? 'ev' : 'tk') + (it.done ? ' done' : '') },
      h('button', { class: 'chk', 'aria-label': it.done ? '완료 취소' : '완료로 표시', onclick: () => toggleDone(it) }, h('i', null, svg(ICON.check))),
      timeCell,
      h('div', { style: 'min-width:0' }, h('div', { class: 'it-t' }, it.title), meta),
      h('div', { class: 'acts' },
        url ? h('a', { href: url, target: '_blank', rel: 'noopener', 'aria-label': '구글 캘린더에 추가', title: '구글 캘린더에 추가' }, svg(ICON.cal)) : null,
        h('button', { 'aria-label': '삭제', title: '삭제', onclick: () => deleteItem(it) }, svg(ICON.trash))));
  }
  function toggleDone(it) {
    it.done = !it.done; it.doneAt = it.done ? Date.now() : 0;
    db.put(it); renderSched(); renderResult();
  }
  function deleteItem(it) {
    S.items.delete(it.id); db.del(it.id); renderSched(); renderResult();
    toast('「' + it.title + '」을(를) 지웠어요', '되돌리기', () => { S.items.set(it.id, it); db.put(it); renderSched(); renderResult(); });
  }
  function group(title, list, cls, sub) {
    if (!list.length) return null;
    return h('section', { class: 'grp ' + (cls || '') },
      h('h3', null, title, sub ? h('span', { class: 'when' }, sub) : null),
      h('ul', null, list.map(itemRow)));
  }
  function renderWeek() {
    const box = $('week'); box.textContent = '';
    const now = new Date(), today = D.today();
    for (let i = 0; i < 7; i++) {
      const d = D.addDays(now, i), key = D.ymd(d);
      const its = [...S.items.values()].filter(x => x.date === key && !x.done && (S.filter === 'all' || x.type === S.filter));
      const pips = its.slice(0, 4).map(x => h('span', { class: 'pip' + (x.type === 'task' ? ' t' : '') }));
      box.append(h('button', {
        class: 'day' + (key === today ? ' is-today' : '') + (d.getDay() === 0 ? ' sun' : ''),
        'aria-pressed': String(S.day === key), 'aria-label': D.dayLabel(key) + ' 일정 ' + its.length + '개',
        onclick: () => { S.day = S.day === key ? null : key; renderSched(); },
      }, h('span', { class: 'dw' }, i === 0 ? '오늘' : D.DOW[d.getDay()]), h('span', { class: 'dn' }, d.getDate()), h('span', { class: 'pips' }, pips)));
    }
  }
  function renderSched() {
    renderWeek();
    const box = $('slist'); box.textContent = '';
    const today = D.today();
    const all = [...S.items.values()].filter(x => S.filter === 'all' || x.type === S.filter).sort(sortItems);
    const open = all.filter(x => !x.done);
    $('navCnt').textContent = String(open.filter(x => x.date === today).length || '');
    const parts = [];
    if (S.day) {
      parts.push(group(D.dayLabel(S.day), all.filter(x => x.date === S.day), '', null));
      if (!parts[0]) parts[0] = h('p', { class: 'empty' }, D.dayLabel(S.day) + '에는 일정이 없어요.');
    } else {
      const diff = x => D.diffDays(today, x.date);
      parts.push(group('놓친 할 일', open.filter(x => x.date && x.type === 'task' && diff(x) < 0), 'overdue'));
      parts.push(group('오늘', open.filter(x => x.date && diff(x) === 0), '', D.dayLabel(today)));
      parts.push(group('내일', open.filter(x => x.date && diff(x) === 1), '', D.dayLabel(D.ymd(D.addDays(new Date(), 1)))));
      parts.push(group('이번 7일', open.filter(x => x.date && diff(x) >= 2 && diff(x) <= 6)));
      parts.push(group('그 뒤', open.filter(x => x.date && diff(x) > 6)));
      parts.push(group('날짜 없는 할 일', open.filter(x => !x.date)));
      parts.push(group('최근 완료', all.filter(x => x.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 8)));
      if (!parts.some(Boolean)) {
        parts.push(h('div', { class: 'empty' },
          h('p', null, '아직 일정이 없어요.'),
          h('p', null, '노트에 "내일 10시 팀 회의", "금요일까지 보고서"처럼 적고 마지막 줄에 // 를 쓰면 여기에 날짜별로 정리돼요.')));
      }
    }
    parts.filter(Boolean).forEach(p => box.append(p));
  }

  function renderAll() { $('todayLabel').textContent = D.longToday(); renderList(); renderResult(); renderSched(); }

  /* ---------- 화면 전환 ---------- */
  function setView(v) {
    document.body.dataset.view = v;
    document.querySelectorAll('.bnav button').forEach(b => b.setAttribute('aria-current', b.dataset.v === v ? 'page' : 'false'));
    if (v === 'write' && S.mode === 'pen') requestAnimationFrame(() => ink.resize());
  }

  /* ---------- 내보내기 ---------- */
  function saveFile(name, data, type) {
    const blob = new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function exportIcs() {
    const from = D.ymd(D.addDays(new Date(), -7));
    const list = [...S.items.values()].filter(i => i.date && i.date >= from && !i.done);
    if (!list.length) { toast('내보낼 날짜 있는 일정이 없어요'); return; }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//kkeojeok//note//KO', 'CALSCALE:GREGORIAN'];
    list.forEach(it => {
      const d = it.date.replace(/-/g, '');
      L.push('BEGIN:VEVENT', 'UID:' + it.id + '@kkeojeok', 'DTSTAMP:' + stamp);
      if (it.time) {
        const st = d + 'T' + it.time.replace(':', '') + '00';
        let en;
        if (it.endTime && it.endTime > it.time) en = d + 'T' + it.endTime.replace(':', '') + '00';
        else { const [hh, mm] = it.time.split(':').map(Number); const x = new Date(2000, 0, 1, hh + 1, mm); en = (hh + 1 >= 24 ? D.ymd(D.addDays(D.parse(it.date), 1)).replace(/-/g, '') : d) + 'T' + D.pad(x.getHours()) + D.pad(x.getMinutes()) + '00'; }
        L.push('DTSTART:' + st, 'DTEND:' + en);
      } else {
        L.push('DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + D.ymd(D.addDays(D.parse(it.date), 1)).replace(/-/g, ''));
      }
      L.push('SUMMARY:' + icsEscape((it.type === 'task' ? '[할 일] ' : '') + it.title));
      if (it.place) L.push('LOCATION:' + icsEscape(it.place));
      if (it.detail) L.push('DESCRIPTION:' + icsEscape(it.detail));
      L.push('END:VEVENT');
    });
    L.push('END:VCALENDAR');
    saveFile('끄적노트-일정-' + D.today() + '.ics', L.join('\r\n'), 'text/calendar');
    toast('일정 ' + list.length + '개를 캘린더 파일로 저장했어요. 파일을 열면 캘린더에 추가돼요.');
  }
  async function exportBackup() {
    flushSave();
    const docs = await db.all();
    saveFile('끄적노트-백업-' + D.today() + '.json', JSON.stringify({ app: 'kkeojeok', version: 1, exportedAt: new Date().toISOString(), docs }, null, 1), 'application/json');
  }
  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'kkeojeok' || !Array.isArray(data.docs)) throw new Error('형식');
      const docs = data.docs.filter(d => d && typeof d.id === 'string' && ['note', 'item', 'ink'].includes(d.kind));
      await db.putMany(docs);
      await loadAll(); openNote(S.cur); renderAll();
      toast('백업에서 ' + docs.filter(d => d.kind === 'note').length + '개 노트를 불러왔어요');
    } catch (e) { toast('백업 파일을 읽지 못했어요. 끄적노트에서 받은 .json 파일인지 확인해 주세요.'); }
  }

  /* ---------- 설정 ---------- */
  const dlg = $('dlgSettings');
  function openSettings() {
    $('apiKey').value = settings.apiKey; $('model').value = settings.model; $('effort').value = settings.effort; $('keyMsg').textContent = '';
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function readSettingsForm() {
    settings.apiKey = $('apiKey').value.trim(); settings.model = $('model').value; settings.effort = $('effort').value; saveSettings();
  }
  dlg.addEventListener('close', () => { readSettingsForm(); renderResult(); processQueue(); });
  $('btnTestKey').addEventListener('click', async () => {
    readSettingsForm();
    const msg = $('keyMsg');
    if (!settings.apiKey) { msg.className = 'errmsg'; msg.textContent = 'API 키를 먼저 넣어 주세요.'; return; }
    msg.className = ''; msg.textContent = '확인 중…';
    try { await KK.claude.test({ apiKey: settings.apiKey, model: settings.model }); msg.className = 'okmsg'; msg.textContent = '연결됐어요.'; }
    catch (e) { msg.className = 'errmsg'; msg.textContent = errCopy(e); }
  });
  $('btnExport').addEventListener('click', exportBackup);
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });

  /* ---------- 이벤트 연결 ---------- */
  bodyEl.addEventListener('input', onBodyInput);
  titleEl.addEventListener('input', () => {
    const n = ensureNote(); n.title = titleEl.value; n.titleAuto = !titleEl.value.trim(); n.updatedAt = Date.now();
    scheduleSave(); clearTimeout(listTimer); listTimer = setTimeout(renderList, 400);
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); organize(); }
  });
  $('btnOrganize').addEventListener('click', organize);
  $('btnStop').addEventListener('click', () => S.busy && S.busy.ctl.abort());
  $('btnNew').addEventListener('click', newNote);
  $('btnDelNote').addEventListener('click', deleteNote);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnIcsAll').addEventListener('click', exportIcs);
  $('modeType').addEventListener('click', () => setMode('type'));
  $('modePen').addEventListener('click', () => setMode('pen'));
  $('search').addEventListener('input', e => { S.q = e.target.value; renderList(); });
  document.querySelectorAll('.filters button').forEach(b => b.addEventListener('click', () => {
    S.filter = b.dataset.f;
    document.querySelectorAll('.filters button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderSched();
  }));
  document.querySelectorAll('.bnav button').forEach(b => b.addEventListener('click', () => setView(b.dataset.v)));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
    else if (D.today() !== S.lastDay) { S.lastDay = D.today(); renderAll(); }
  });
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('online', () => { $('sync').dataset.s = 'ok'; $('sync').textContent = '이 기기에 저장됨'; processQueue(); });
  window.addEventListener('offline', () => { $('sync').dataset.s = 'busy'; $('sync').textContent = '오프라인 · 기기에 저장 중'; });
  window.matchMedia('(min-width:1100px)').addEventListener('change', renderResult);
  setInterval(() => { if (D.today() !== S.lastDay) { S.lastDay = D.today(); renderAll(); } }, 60000);

  /* ---------- 시작 ---------- */
  async function loadAll() {
    const docs = await db.all();
    S.notes.clear(); S.items.clear();
    docs.forEach(d => { if (d.kind === 'note') S.notes.set(d.id, d); else if (d.kind === 'item') S.items.set(d.id, d); });
  }
  async function start() {
    await db.init();
    await loadAll();
    if (db.usingFallback) $('storeNote').textContent = '이 브라우저는 간이 저장소를 써요. 백업을 자주 받아 두세요.';
    if (!navigator.onLine) window.dispatchEvent(new Event('offline'));
    setMode(lsGet('kk-mode', 'type') === 'pen' ? 'pen' : 'type');
    setView('write');
    const last = lsGet('kk-last', '');
    openNote(S.notes.has(last) ? last : null);
    renderAll();
    processQueue();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 오프라인 캐시 없이도 동작 */ });
    }
  }
  start();
})();
