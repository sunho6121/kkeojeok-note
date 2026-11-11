'use strict';
/* 끄적노트 v0.3 — 노트 쓰기·정리·일정 상태 관리 */
(function () {
  const D = KK.date, db = KK.db;
  const { $, toast } = KK.ui;
  const V = KK.views;
  const TRIGGERS = ['//', '@정리', '정리!!'];

  const S = {
    notes: new Map(), items: new Map(), cur: null, filter: 'all', sview: 'open', day: null, q: '',
    busy: null, mode: 'type', lastDay: D.today(), showSummary: false,
  };
  const DEFAULTS = { apiKey: '', model: 'claude-sonnet-5-5', effort: 'high', v: 2, autoMinutes: true, minutesTasks: true, recWith: 'app', boardUrl: '', boardKey: '', boardOwner: '', boardAuto: true, boardPull: true };
  const settings = loadSettings();

  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } }
  function loadSettings() {
    let s;
    try { s = JSON.parse(lsGet('kk-settings', '{}')) || {}; } catch (e) { s = {}; }
    if (s.v !== 2) { s.model = DEFAULTS.model; s.effort = DEFAULTS.effort; s.v = 2; }
    return Object.assign({}, DEFAULTS, s);
  }
  function saveSettings() { lsSet('kk-settings', JSON.stringify(settings)); }

  /* ---------- 그리기 묶음 ---------- */
  function renderEditorTop() { V.renderChips(); V.renderResult(); if (KK.work) KK.work.renderCarry(); if (KK.daily) KK.daily.renderBar(); if (KK.edit) KK.edit.paint(); }
  function renderAll() {
    $('todayLabel').textContent = D.longToday();
    renderEditorTop(); V.renderNotes(); V.renderSched(); V.renderMemo();
    if (KK.work) KK.work.render();
  }
  function setView(v) {
    document.body.dataset.view = v;
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.v === v ? 'page' : 'false'));
    if (v === 'write' && S.mode === 'pen') requestAnimationFrame(() => ink.resize());
    if (v === 'sched') {
      V.renderSched();
      if (KK.gcal && KK.gcal.ready() && KK.gcal.hasToken()) KK.gcal.fetchEvents().then(() => V.renderSched()).catch(() => {});
    }
    if (v === 'notes') V.renderNotes();
    if (v === 'memo') V.renderMemo();
    if (v === 'work' && KK.work) KK.work.render();
    if (v === 'work' && KK.board) KK.board.pull();
    if (v === 'rec' && KK.voice) KK.voice.renderList();
    if (v !== 'rec') S.recNote = null;
    lsSet('kk-view', v);
  }

  /* ---------- 노트 ---------- */
  const bodyEl = $('body'), titleEl = $('noteTitle');
  const curNote = () => (S.cur ? S.notes.get(S.cur) : null);

  function ensureNote() {
    let n = curNote();
    if (n) return n;
    const now = Date.now();
    n = { id: 'n-' + KK.uid(), kind: 'note', title: titleEl.value.trim(), titleAuto: !titleEl.value.trim(), body: bodyEl.value, summary: [], tags: [], createdAt: now, updatedAt: now, organizedAt: 0, pending: false, hasInk: false };
    n.month = KK.work ? KK.work.curYM() : ''; n.series = n.id; // 노트는 달마다 새로 시작
    S.notes.set(n.id, n); S.cur = n.id; lsSet('kk-last', n.id);
    db.put(n); renderEditorTop();
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
    if (id === S.cur && id) { renderEditorTop(); return; }
    flushSave();
    S.cur = id && S.notes.has(id) ? id : null;
    S.showSummary = false; lastCaret = null;
    const n = curNote();
    titleEl.value = n ? n.title : '';
    bodyEl.value = n ? n.body : '';
    if (n) lsSet('kk-last', n.id);
    ink.reset([]); inkDirty = false;
    if (n && n.hasInk) db.get('ink-' + n.id).then(d => { if (S.cur === n.id && d) { ink.reset(d.strokes); updatePenHint(); } });
    updatePenHint();
    renderEditorTop(); V.renderNotes();
    if (KK.voice) KK.voice.refresh();
    // 이어 쓰기 편하게 맨 끝으로
    requestAnimationFrame(() => { bodyEl.scrollTop = bodyEl.scrollHeight; });
  }

  function newNote() {
    flushSave();
    S.cur = null; S.showSummary = false; titleEl.value = ''; bodyEl.value = ''; ink.reset([]); inkDirty = false;
    renderEditorTop(); V.renderNotes(); updatePenHint();
    if (KK.voice) KK.voice.refresh();
    setView('write');
    if (S.mode === 'type') bodyEl.focus();
  }

  function deleteNote() {
    const n = curNote();
    if (!n) { toast('지울 노트가 없어요'); return; }
    const its = [...S.items.values()].filter(i => i.noteId === n.id);
    const inkDoc = { id: 'ink-' + n.id, kind: 'ink', strokes: ink.strokes().slice() };
    if (KK.gcal) setTimeout(() => { if (!S.notes.has(n.id)) KK.gcal.removeOwned(its); }, 7000);
    S.notes.delete(n.id); its.forEach(i => S.items.delete(i.id));
    db.delMany([n.id, inkDoc.id, ...its.map(i => i.id)]);
    // 가져온 파일·녹음은 되돌리기 시간(6초)이 지난 뒤 지운다
    setTimeout(async () => {
      if (S.notes.has(n.id)) return;
      const extra = (await db.all()).filter(d => (d.kind === 'rec' && d.noteId === n.id) || d.id === 'imp-' + n.id).map(d => d.id);
      db.delMany(extra);
    }, 8000);
    S.cur = null;
    const next = V.notesSorted()[0];
    openNote(next ? next.id : null); renderAll();
    toast('「' + V.noteLabel(n) + '」 노트를 지웠어요', '되돌리기', () => {
      S.notes.set(n.id, n); its.forEach(i => S.items.set(i.id, i));
      db.putMany([n, ...its, ...(inkDoc.strokes.length ? [inkDoc] : [])]);
      openNote(n.id); renderAll();
    });
  }

  /* 입력 & 정리 신호 */
  let trigTimer = null, topTimer = null;
  function onBodyInput() {
    const n = ensureNote();
    n.body = bodyEl.value; n.updatedAt = Date.now();
    scheduleSave(); checkTrigger();
    if (KK.daily) KK.daily.onInput(); // 날짜만 적은 줄 → 전날까지 못 끝낸 일 불러오기
    clearTimeout(topTimer); topTimer = setTimeout(renderEditorTop, 500);
  }
  // 코드로 본문을 고친 뒤 저장 (날짜 불러오기 등)
  function bodyEdited() {
    const n = ensureNote();
    n.body = bodyEl.value; n.updatedAt = Date.now();
    scheduleSave();
    clearTimeout(topTimer); topTimer = setTimeout(renderEditorTop, 300);
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
      n.pending = true; db.put(n); renderEditorTop();
      toast('정리하려면 Claude API 키가 필요해요. 노트는 저장됐어요.', '설정 열기', openSettings); return;
    }
    if (!navigator.onLine) {
      n.pending = true; db.put(n); renderEditorTop();
      toast('인터넷이 없어 정리 대기로 두었어요. 연결되면 자동으로 정리해요.'); return;
    }
    await runOrganize(n, true);
  }

  /* 이 노트의 기존 일정을 짧은 번호(e1…)로 Claude에게 넘긴다 */
  function existingFor(n) {
    const cutoff = Date.now() - 60 * 86400000, carried = KK.daily ? KK.daily.refs(n) : new Set();
    const mine = [...S.items.values()]
      .filter(i => (i.noteId === n.id || carried.has(i.id)) && (!i.deleted || (i.deletedAt || 0) > cutoff))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-150);
    const refMap = {}, list = [];
    mine.forEach((it, idx) => {
      const ref = 'e' + (idx + 1);
      refMap[ref] = it;
      list.push({ ref, type: it.type, title: it.title, date: it.date, time: it.time, place: it.place, to: it.to || '', status: it.status || 'todo', locked: !!it.locked, deleted: !!it.deleted, edited: !!(it.userFields && Object.keys(it.userFields).length) });
    });
    return { refMap, list };
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
    let file = null;
    if (n.hasImport) {
      const d = await db.get('imp-' + n.id);
      if (d && d.data) file = { kind: d.fileKind, media_type: d.media_type, data: d.data };
    }
    const { refMap, list } = existingFor(n);
    const ctl = new AbortController();
    S.busy = { id: n.id, ctl }; setBusy(true, n);
    try {
      const out = await KK.claude.organize({
        apiKey: settings.apiKey, model: settings.model, effort: settings.effort,
        text: n.importMarker ? text.replace(n.importMarker, '').trim() : text,
        imageB64, file, existing: list, signal: ctl.signal,
      });
      const c = applyResult(n, out, hadInk, refMap, !!file);
      if (KK.gcal) KK.gcal.syncSoon();
      const parts = [];
      if (c.added) parts.push('새 일정 ' + c.added + '개');
      if (c.updated) parts.push('바뀐 일정 ' + c.updated + '개');
      const msg = parts.length ? '정리 완료 · ' + parts.join(', ') : '정리 완료 · 바뀐 일정은 없어요';
      if (interactive || n.id === S.cur) toast(msg, parts.length ? '일정 보기' : null, () => setView('sched'));
    } catch (e) {
      if (e.code === 'offline') {
        n.pending = true; db.put(n);
        if (interactive) toast('인터넷이 끊겨 정리 대기로 두었어요. 연결되면 자동으로 정리해요.');
      } else if (e.code !== 'cancelled') {
        toast(errCopy(e), e.code === 'bad_key' || e.code === 'bad_model' ? '설정 열기' : null, openSettings, 7000);
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
      case 'too_large': return '메모나 필기가 너무 커요. 새 노트로 나눠 써 주세요.';
      case 'refused': return '이 메모는 정리하지 못했어요. 내용을 조금 바꿔 다시 시도해 주세요.';
      case 'bad_output': return '정리 결과를 읽지 못했어요. 한 번 더 정리해 주세요.';
      default: return '정리하지 못했어요: ' + (e.message || '알 수 없는 오류');
    }
  }

  const FIELDS = ['type', 'title', 'date', 'time', 'endTime', 'place', 'to', 'priority', 'detail'];
  function applyResult(n, out, hadInk, refMap, hadFile) {
    const now = Date.now();
    const isCur = n.id === S.cur;
    if (isCur) n.body = bodyEl.value;
    if (hadFile && n.importMarker) {
      n.body = (n.body || '').replace(n.importMarker, '').replace(/^\s+/, '');
      delete n.importMarker;
    }
    if ((hadInk || hadFile) && out.transcript) {
      const label = hadFile && !hadInk ? (n.imported ? '[삼성 노트에서 가져옴 · ' : '[붙여넣은 이미지 옮김 · ') : '[필기 옮김 · ';
      n.body = ((n.body || '').replace(/\s+$/, '') + '\n\n' + label + D.stamp(now) + ']\n' + out.transcript).replace(/^\s+/, '');
    }
    if (hadFile) { n.hasImport = false; db.del('imp-' + n.id); }
    if (hadInk && out.transcript) { n.hasInk = false; db.del('ink-' + n.id); }
    if (isCur && (hadInk || hadFile)) {
      bodyEl.value = n.body;
      if (hadInk && out.transcript) { ink.reset([]); inkDirty = false; updatePenHint(); }
    }
    if (n.titleAuto !== false || !n.title) { n.title = out.title || n.title; n.titleAuto = true; if (isCur) titleEl.value = n.title; }
    n.summary = out.summary; n.tags = out.tags;
    n.updatedAt = now; n.organizedAt = now; n.pending = false; n.model = settings.model;

    const key = i => (i.title + '|' + (i.date || '')).replace(/\s/g, '');
    const carried = KK.daily ? KK.daily.refs(n) : new Set();
    const mine = [...S.items.values()].filter(i => i.noteId === n.id || carried.has(i.id));
    const tomb = new Set(mine.filter(i => i.deleted).map(key));
    const live = new Set(mine.filter(i => !i.deleted).map(key));
    const changed = [], srcOnly = [];
    let added = 0, updated = 0;
    out.items.forEach(r => {
      const t = r.ref ? refMap[r.ref] : null;
      if (t) {
        if (t.deleted) return;
        const before = JSON.stringify([FIELDS.map(f => t[f]), t.status]);
        // 사람이 정한 우선순위·앱에서 직접 고친 칸은 그대로
        FIELDS.forEach(f => { if (f === 'priority' && t.priSet) return; if (t.userFields && t.userFields[f]) return; if (r[f] !== '' && r[f] != null) t[f] = r[f]; });
        if (r.src && r.src !== t.src) { t.src = r.src; srcOnly.push(t); } // 노트의 원문 구절(고칠 때 취소선 긋는 곳)
        if (!t.locked && r.status && r.status !== (t.status || 'todo')) {
          t.status = r.status; t.statusAt = now; t.doneAt = r.status === 'done' ? now : 0;
        }
        if (JSON.stringify([FIELDS.map(f => t[f]), t.status]) !== before) { t.updatedAt = now; changed.push(t); updated++; }
        return;
      }
      const k = key(r);
      if (tomb.has(k) || live.has(k)) return;
      const doc = { id: 't-' + KK.uid(), kind: 'item', noteId: n.id, createdAt: now, updatedAt: now, locked: false, deleted: false, status: r.status || 'todo', doneAt: r.status === 'done' ? now : 0 };
      FIELDS.forEach(f => { doc[f] = r[f] || ''; });
      doc.src = r.src || '';
      S.items.set(doc.id, doc); changed.push(doc); live.add(k); added++;
    });
    db.putMany([n, ...changed, ...srcOnly.filter(x => !changed.includes(x))]);
    if (KK.board) KK.board.sync(changed);
    return { added, updated };
  }

  let queueRunning = false;
  async function processQueue() {
    if (KK.minutes) KK.minutes.resume();   // 기다리던 자동 회의록
    if (KK.work) KK.work.processMonths(); // 기다리던 월간 업무 요약
    if (KK.board) KK.board.flush();       // 보드에 못 맞춘 상태
    if (queueRunning || !navigator.onLine || !settings.apiKey) return;
    queueRunning = true;
    try {
      for (const n of V.notesSorted().filter(x => x.pending)) {
        if (!navigator.onLine) break;
        while (S.busy) await new Promise(r => setTimeout(r, 500));
        await runOrganize(n, false);
      }
    } finally { queueRunning = false; }
  }

  function setBusy(on, n) {
    $('busy').hidden = !on;
    $('btnOrganize').hidden = !!on;
    if (on) $('busyText').textContent = (n && n.id !== S.cur ? '「' + V.noteLabel(n) + '」 ' : '') + 'Claude가 메모를 꼼꼼히 읽고 있어요 · 길면 1분쯤 걸려요';
  }

  /* ---------- 일정 상태 ---------- */
  function setItemStatus(it, s) {
    const now = Date.now();
    it.status = s; it.locked = true; it.statusAt = now; it.updatedAt = now;
    it.doneAt = s === 'done' ? now : 0;
    db.put(it); V.renderSched(); V.renderResult(); V.renderMemo(); if (KK.work) KK.work.render();
    if (KK.gcal) KK.gcal.syncSoon();
    if (KK.board) KK.board.sync([it]);
  }
  function setItemPriority(it, p) {
    it.priority = p; it.priSet = true; it.updatedAt = Date.now();
    db.put(it); V.renderSched(); V.renderResult(); V.renderMemo(); if (KK.work) KK.work.render(); if (KK.daily) KK.daily.renderBar();
  }
  function deleteItem(it) {
    it.deleted = true; it.deletedAt = Date.now();
    db.put(it); V.renderSched(); V.renderResult(); V.renderMemo(); if (KK.work) KK.work.render();
    if (KK.gcal) KK.gcal.syncSoon();
    toast('「' + it.title + '」을(를) 지웠어요', '되돌리기', () => { it.deleted = false; it.deletedAt = 0; db.put(it); V.renderSched(); V.renderResult(); V.renderMemo(); if (KK.work) KK.work.render(); if (KK.gcal) KK.gcal.syncSoon(); });
  }
  /* 이번 달 노트를 Claude가 다시 읽고 전달사항·중요 메모(와 일정)를 뽑는다 — 다시 정리와 같음 */
  async function extractMemos() {
    if (S.extracting) return;
    const cm = KK.work ? KK.work.curYM() : '';
    flushSave();
    const list = [...S.notes.values()].filter(n => !n.closed && (!cm || !n.month || n.month === cm) && ((n.body || '').trim() || n.hasInk));
    if (!list.length) { toast('정리할 이번 달 노트 내용이 없어요. 쓰기 탭에서 먼저 적어 주세요.'); return; }
    if (!settings.apiKey) { toast('Claude API 키가 필요해요.', '설정 열기', openSettings); return; }
    if (!navigator.onLine) { toast('인터넷에 연결되어 있지 않아요.'); return; }
    list.forEach(n => { n.pending = true; });
    db.putMany(list);
    S.extracting = true; V.renderMemo();
    toast('노트 ' + list.length + '개를 Claude가 다시 읽고 있어요. 끝나면 여기에 모여요.');
    try {
      while (S.busy || queueRunning) await new Promise(r => setTimeout(r, 500));
      await processQueue();
    } finally { S.extracting = false; renderAll(); }
    const n = [...S.items.values()].filter(i => !i.deleted && (i.type === 'notice' || i.type === 'memo')).length;
    toast(n ? '전달사항·중요 메모 ' + n + '건을 정리했어요' : '노트에서 전달할 것·기억할 것을 찾지 못했어요', null, null, 6000);
  }

  /* 전달사항·중요 메모를 Claude가 개조식으로 간결하게 다듬는다 (지금 보이는 것만, 되돌리기 가능) */
  async function polishMemos() {
    if (S.polishing) return;
    const list = [...S.items.values()].filter(i => !i.deleted && (
      (i.type === 'notice' && ['todo', 'doing', 'hold'].includes(i.status || 'todo')) || (i.type === 'memo' && i.status !== 'done')));
    if (!list.length) { extractMemos(); return; } // 다듬을 게 없으면 노트에서 먼저 뽑는다
    if (!settings.apiKey) { toast('다듬으려면 Claude API 키가 필요해요.', '설정 열기', openSettings); return; }
    if (!navigator.onLine) { toast('인터넷에 연결되어 있지 않아요.'); return; }
    S.polishing = true; V.renderMemo();
    const refMap = {};
    const items = list.slice(0, 80).map((it, i) => { const ref = 'm' + (i + 1); refMap[ref] = it; return { ref, type: it.type, to: it.to, date: it.date, title: it.title, detail: it.detail }; });
    try {
      const out = await KK.claude.polish({ apiKey: settings.apiKey, model: settings.model, effort: settings.effort, items });
      const now = Date.now(), changed = [], before = new Map();
      out.forEach(x => {
        const it = refMap[x.ref]; if (!it) return;
        const detail = x.points.join('\n');
        if (it.title === x.title && (it.detail || '') === detail) return;
        before.set(it.id, { title: it.title, detail: it.detail });
        it.title = x.title; it.detail = detail; it.updatedAt = now; changed.push(it);
      });
      if (changed.length) db.putMany(changed);
      V.renderMemo(); V.renderResult();
      toast(changed.length ? changed.length + '건을 개조식으로 간결하게 다듬었어요' : '이미 간결해서 바꿀 게 없었어요', changed.length ? '되돌리기' : null, () => {
        changed.forEach(it => Object.assign(it, before.get(it.id)));
        db.putMany(changed); V.renderMemo();
      }, 9000);
    } catch (e) {
      toast(errCopy(e).replace('정리하지 못했어요', '다듬지 못했어요').replace('다시 정리해', '다시 해'), e.code === 'bad_key' ? '설정 열기' : null, openSettings, 7000);
    } finally { S.polishing = false; V.renderMemo(); }
  }

  /* 캘린더(그룹웨어 등) 일정을 끄적노트에서 상태 관리하도록 가져온다 — 캘린더 쪽 일정은 건드리지 않음 */
  function adoptEvent(ev) {
    const now = Date.now();
    const it = { id: 't-' + KK.uid(), kind: 'item', noteId: '', type: 'event', title: ev.title, date: ev.date, time: ev.time, endTime: ev.endTime, place: ev.place, priority: 'normal', detail: '', status: 'todo', locked: false, deleted: false, createdAt: now, updatedAt: now, doneAt: 0, gLinked: ev.calId + '|' + ev.id };
    S.items.set(it.id, it); db.put(it); V.renderSched();
    V.openItem(it);
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
    const list = [...S.items.values()].filter(i => !i.deleted && (i.type === 'event' || i.type === 'task') && i.date && i.date >= from && ['todo', 'doing'].includes(i.status || 'todo'));
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
    const docs = (await db.all()).filter(d => d.kind !== 'rec'); // 녹음 파일은 백업에서 뺀다(용량)
    saveFile('끄적노트-백업-' + D.today() + '.json', JSON.stringify({ app: 'kkeojeok', version: 3, exportedAt: new Date().toISOString(), docs }, null, 1), 'application/json');
  }
  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'kkeojeok' || !Array.isArray(data.docs)) throw new Error('형식');
      const docs = data.docs.filter(d => d && typeof d.id === 'string' && ['note', 'item', 'ink', 'imp', 'month'].includes(d.kind));
      await db.putMany(docs);
      await loadAll(); S.cur = null; openNote(lsGet('kk-last', '')); renderAll();
      toast('백업에서 ' + docs.filter(d => d.kind === 'note').length + '개 노트를 불러왔어요');
    } catch (e) { toast('백업 파일을 읽지 못했어요. 끄적노트에서 받은 .json 파일인지 확인해 주세요.'); }
  }

  /* ---------- 설정 ---------- */
  const dlg = $('dlgSettings');
  function openSettings() {
    $('apiKey').value = settings.apiKey; $('model').value = settings.model; $('effort').value = settings.effort; $('keyMsg').textContent = '';
    $('setAutoMin').checked = settings.autoMinutes !== false; $('setMinTasks').checked = settings.minutesTasks !== false; $('setRecWith').value = settings.recWith === 'web' ? 'web' : 'app';
    $('boardUrl').value = settings.boardUrl || (KK.board ? KK.board.DEFAULT_URL : ''); $('boardKey').value = settings.boardKey || ''; $('boardOwner').value = settings.boardOwner || '';
    $('boardAuto').checked = settings.boardAuto !== false; $('boardPull').checked = settings.boardPull !== false; $('boardMsg').textContent = '';
    $('btnDelNote').hidden = !curNote();
    V.renderGcalSettings();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function readSettingsForm() {
    settings.apiKey = $('apiKey').value.replace(/\s+/g, ''); settings.model = $('model').value; settings.effort = $('effort').value;
    settings.autoMinutes = $('setAutoMin').checked; settings.minutesTasks = $('setMinTasks').checked; settings.recWith = $('setRecWith').value;
    settings.boardUrl = $('boardUrl').value.trim(); settings.boardKey = $('boardKey').value.replace(/\s+/g, ''); settings.boardOwner = $('boardOwner').value.trim(); settings.boardAuto = $('boardAuto').checked; settings.boardPull = $('boardPull').checked;
    saveSettings();
  }
  const KEY_RE = /sk-ant-[A-Za-z0-9_\-]{20,}/;
  function keyMsg(ok, text) { const m = $('keyMsg'); m.className = ok ? 'okmsg' : 'errmsg'; m.textContent = text; }
  function setKey(raw) {
    const k = String(raw || '').replace(/\s+/g, '');
    const found = k.match(KEY_RE);
    $('apiKey').value = found ? found[0] : k;
    if (found) keyMsg(true, '키를 넣었어요. 연결 테스트를 눌러 확인해 보세요.');
    else keyMsg(false, 'sk-ant-로 시작하는 키가 아닌 것 같아요. 콘솔에서 키를 다시 복사해 주세요.');
  }
  $('btnPasteKey').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t || !t.trim()) { keyMsg(false, '클립보드가 비어 있어요. 콘솔에서 키를 다시 복사해 주세요.'); return; }
      setKey(t);
    } catch (e) {
      keyMsg(false, '클립보드를 읽을 수 없어요. 입력칸을 길게 눌러 붙여넣거나, 노트에 붙여넣고 아래 버튼을 써 주세요.');
    }
  });
  $('apiKey').addEventListener('paste', () => setTimeout(() => setKey($('apiKey').value), 0));
  $('btnShowKey').addEventListener('click', () => {
    const on = $('apiKey').classList.toggle('masked');
    $('btnShowKey').textContent = on ? '키 보기' : '키 숨기기';
  });
  $('btnKeyFromNote').addEventListener('click', () => {
    // 노트들 가운데 키가 붙어 있는 곳을 찾아 가져오고, 노트에서는 바로 지운다
    const all = [curNote(), ...V.notesSorted()].filter(Boolean);
    for (const n of all) {
      const src = n.id === S.cur ? bodyEl.value : (n.body || '');
      const m = src.match(KEY_RE);
      if (!m) continue;
      setKey(m[0]);
      const cleaned = src.replace(m[0], '').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
      n.body = cleaned; n.updatedAt = Date.now();
      if (n.id === S.cur) bodyEl.value = cleaned;
      db.put(n); renderEditorTop();
      return;
    }
    keyMsg(false, '노트에서 키를 찾지 못했어요. 쓰기 화면의 노트에 키를 붙여넣은 뒤 다시 눌러 주세요.');
  });
  dlg.addEventListener('close', () => { readSettingsForm(); V.renderResult(); processQueue(); });
  $('btnBoardTest').addEventListener('click', () => { readSettingsForm(); if (KK.board) KK.board.test($('boardMsg')); });
  $('btnBoardPaste').addEventListener('click', async () => {
    try { const t = (await navigator.clipboard.readText() || '').replace(/\s+/g, ''); if (t) { $('boardKey').value = t; $('boardMsg').className = 'okmsg'; $('boardMsg').textContent = '붙여넣었어요. 연결 테스트를 눌러 보세요.'; } }
    catch (e) { $('boardMsg').className = 'errmsg'; $('boardMsg').textContent = '클립보드를 읽을 수 없어요. 입력칸을 길게 눌러 붙여넣어 주세요.'; }
  });
  $('btnTestKey').addEventListener('click', async () => {
    readSettingsForm();
    const msg = $('keyMsg');
    if (!settings.apiKey) { msg.className = 'errmsg'; msg.textContent = 'API 키를 먼저 넣어 주세요.'; return; }
    msg.className = ''; msg.textContent = '확인 중…';
    try { await KK.claude.test({ apiKey: settings.apiKey, model: settings.model }); msg.className = 'okmsg'; msg.textContent = '연결됐어요.'; }
    catch (e) { msg.className = 'errmsg'; msg.textContent = errCopy(e); }
  });
  $('gClientId').addEventListener('change', e => {
    const G = KK.gcal; if (!G) return;
    const v = e.target.value.replace(/\s+/g, '');
    if (v === G.cfg.clientId) return;
    if (v && !/\.apps\.googleusercontent\.com$/.test(v)) { toast('클라이언트 ID는 .apps.googleusercontent.com 으로 끝나요. 다시 확인해 주세요.'); return; }
    G.cfg.clientId = v; G.cfg.connected = false; G.saveCfg();
    if (v) G.loadGIS().catch(() => {});
    V.renderGcalSettings();
  });
  $('btnExport').addEventListener('click', exportBackup);
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });
  $('btnDelNote').addEventListener('click', () => { dlg.close(); deleteNote(); });

  /* ---------- 이벤트 연결 ---------- */
  bodyEl.addEventListener('input', onBodyInput);
  titleEl.addEventListener('input', () => {
    const n = ensureNote(); n.title = titleEl.value; n.titleAuto = !titleEl.value.trim(); n.updatedAt = Date.now();
    scheduleSave(); clearTimeout(topTimer); topTimer = setTimeout(V.renderChips, 500);
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); organize(); }
  });
  $('btnOrganize').addEventListener('click', organize);
  $('btnStop').addEventListener('click', () => S.busy && S.busy.ctl.abort());
  $('btnNew').addEventListener('click', newNote);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnIcsAll').addEventListener('click', exportIcs);
  $('modeType').addEventListener('click', () => setMode('type'));
  $('modePen').addEventListener('click', () => setMode('pen'));
  $('search').addEventListener('input', e => { S.q = e.target.value; V.renderNotes(); });
  document.querySelectorAll('#segType button').forEach(b => b.addEventListener('click', () => {
    S.filter = b.dataset.f;
    document.querySelectorAll('#segType button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    V.renderSched();
  }));
  S.cview = ['list', 'week', 'month'].includes(lsGet('kk-cview', 'list')) ? lsGet('kk-cview', 'list') : 'list';
  document.querySelectorAll('#segView button').forEach(b => b.addEventListener('click', () => {
    S.cview = b.dataset.c; S.day = null; S.cdate = null; lsSet('kk-cview', S.cview);
    V.renderSched();
  }));
  document.querySelectorAll('#segStatus button').forEach(b => b.addEventListener('click', () => {
    S.sview = b.dataset.s; S.day = null;
    document.querySelectorAll('#segStatus button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    V.renderSched();
  }));
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.v)));
  $('btnPolish').addEventListener('click', polishMemos);
  document.querySelectorAll('#segMemo button').forEach(b => b.addEventListener('click', () => {
    S.mview = b.dataset.m;
    document.querySelectorAll('#segMemo button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    V.renderMemo();
  }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
    else if (D.today() !== S.lastDay) { S.lastDay = D.today(); dayChanged(); }
  });
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('online', () => { $('sync').dataset.s = 'ok'; $('sync').textContent = '기기에 저장됨'; processQueue(); });
  window.addEventListener('offline', () => { $('sync').dataset.s = 'busy'; $('sync').textContent = '오프라인 · 기기에 저장 중'; });
  setInterval(() => { if (D.today() !== S.lastDay) { S.lastDay = D.today(); dayChanged(); } }, 60000);
  function dayChanged() {
    if (KK.work) KK.work.rollover(); // 달이 바뀌었으면 새 달 노트로 넘긴다
    renderAll();
  }

  /* ---------- 삼성 노트 가져오기 (파일 선택 · 공유) ---------- */
  function fileToB64(f) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).slice(String(r.result).indexOf(',') + 1));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(f);
    });
  }
  async function imageToJpegB64(f) {
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.88);
      return url.slice(url.indexOf(',') + 1);
    } catch (e) { return null; }
  }
  function newImportedNote(title, body, extra) {
    const now = Date.now();
    const n = Object.assign({ id: 'n-' + KK.uid(), kind: 'note', title: title || '', titleAuto: true, body: body || '', summary: [], tags: [], createdAt: now, updatedAt: now, organizedAt: 0, pending: true, hasInk: false, imported: 'samsung-notes' }, extra || {});
    n.month = KK.work ? KK.work.curYM() : ''; n.series = n.id;
    S.notes.set(n.id, n);
    return n;
  }
  function audioDuration(blob) {
    return new Promise(res => {
      const url = URL.createObjectURL(blob), au = new Audio();
      const done = v => { URL.revokeObjectURL(url); res(v); };
      const t = setTimeout(() => done(0), 4000);
      au.preload = 'metadata';
      au.onloadedmetadata = () => { clearTimeout(t); done(isFinite(au.duration) ? Math.round(au.duration) : 0); };
      au.onerror = () => { clearTimeout(t); done(0); };
      au.src = url;
    });
  }
  const AUDIO_EXT = ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'webm', '3gp', 'amr'];
  const extOf = f => ((f.name || '').split('.').pop() || '').toLowerCase();
  const isAudioFile = f => (f.type || '').startsWith('audio/') || AUDIO_EXT.includes(extOf(f));
  const isTextFile = f => (f.type || '').startsWith('text/') || extOf(f) === 'txt';
  /* 녹음 시작 시각: 파일 이름에 날짜·시각(20261110_141530, 261110_141530)이 있으면 그걸, 없으면 받은 시각 − 길이 */
  function guessStart(name, dur) {
    const m = String(name || '').match(/(20\d{2}|\d{2})(\d{2})(\d{2})[_\- ]?(\d{2})(\d{2})(\d{2})?/);
    if (m) {
      const y = m[1].length === 2 ? 2000 + +m[1] : +m[1];
      const d = new Date(y, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      if (!isNaN(d) && +m[2] >= 1 && +m[2] <= 12 && +m[4] < 24 && Math.abs(Date.now() - d) < 400 * 864e5) return +d;
    }
    return Date.now() - (dur || 0) * 1000;
  }
  /* 음성 녹음 앱의 변환 글처럼 보이는지: 화자 표시(화자 1)나 시각(00:12)이 여러 줄에 있음 */
  function looksLikeTranscript(t, title) {
    const lines = String(t || '').split('\n');
    const marks = lines.filter(l => /^\s*[[(]?\d{1,2}:\d{2}(:\d{2})?[\])]?(\s|$)/.test(l) || /(화자|참석자|발화자|speaker)\s*\d+/i.test(l)).length;
    return marks >= 3 || (/녹음|녹취|음성|voice|record|transcri/i.test(title || '') && String(t).length > 200);
  }
  /* 최근 받은 녹음 가운데 짝이 맞는 것 (따로 공유한 녹음 파일과 변환 글을 묶을 때) */
  async function recentRec(pred, withinMs) {
    const now = Date.now();
    return (await db.all()).filter(d => d.kind === 'rec' && !d.draft && now - (d.createdAt || 0) < withinMs && pred(d))
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }
  async function importFiles(files, shared) {
    flushSave();
    const made = [], skipped = [], toMinutes = [];
    let recs = 0, appended = false, linked = false;
    // 녹음 파일과 변환 글(글 또는 .txt)을 함께 받으면 둘을 묶어 둔다 → 회의록을 자동으로 만든다
    let pairText = '';
    const hasAudio = files.some(isAudioFile);
    if (!db.usingFallback) {
      const parts = [];
      if (shared && shared.text && shared.text.trim()) parts.push(shared.text.trim());
      const txts = files.filter(isTextFile);
      for (const f of txts) { try { parts.push((await f.text()).trim()); } catch (e) { /* 무시 */ } }
      const text = cleanText(parts.filter(Boolean).join('\n\n')).trim();
      const title = [shared && shared.title, ...txts.map(f => f.name)].filter(Boolean).join(' ');
      if (text && hasAudio) pairText = text;
      else if (text && !hasAudio) {
        // 글만 왔을 때: 방금(30분 안) 받은 녹음에 글이 없으면 그 녹음의 변환 글로, 변환 글처럼 보이면 새 녹취 글로
        const tr = looksLikeTranscript(text, title);
        const audio = await recentRec(d => d.blob && !(d.text || '').trim() && !d.minutes, tr ? 3 * 3600e3 : 30 * 60e3);
        if (audio || tr) {
          const now = Date.now();
          const r = audio || { id: 'rec-' + KK.uid(), kind: 'rec', noteId: ensureNote().id, createdAt: now, startAt: guessStart(title, 0), duration: 0, mime: '', size: 0,
            name: ((shared && shared.title) || (txts[0] && txts[0].name.replace(/\.[^.]+$/, '')) || '녹취 글 ' + D.stamp(now)).slice(0, 60), draft: false, blob: null, src: 'share-text' };
          r.text = '[녹취록]\n' + text;
          await db.putRaw(r); recs++; linked = true; toMinutes.push(r);
          files = files.filter(f => !isTextFile(f)); shared = Object.assign({}, shared, { text: '' });
        }
      }
      if (pairText) { files = files.filter(f => !isTextFile(f)); shared = Object.assign({}, shared, { text: '' }); }
    }
    if (shared && shared.text && shared.text.trim()) {
      const cur = curNote();
      if (cur && !files.length) {
        // 음성 녹음 앱의 변환 글처럼 글만 공유되면 지금 쓰는 노트에 이어 붙인다
        appendToNote('\n[공유받은 글 · ' + D.stamp(Date.now()) + ']' + (shared.title ? ' ' + shared.title : '') + '\n' + shared.text.trim());
        cur.pending = true; db.put(cur); appended = true;
      } else {
        const n = newImportedNote(shared.title || '', shared.text.trim());
        await db.put(n); made.push(n);
      }
    }
    for (const f of files) {
      const name = (f.name || '').replace(/\.[^.]+$/, '') || '삼성 노트';
      const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
      const type = f.type || '';
      try {
        if (type.startsWith('audio/') || AUDIO_EXT.includes(ext)) {
          // 음성 녹음 앱 등에서 보낸 녹음 파일 → 지금 노트에 붙은 녹음으로 보관
          if (db.usingFallback) { skipped.push(f.name); continue; }
          const target = ensureNote();
          const dur = await audioDuration(f);
          // 변환 글을 먼저 따로 받아 둔 게 있으면(3시간 안) 그 녹취 글에 이 녹음 파일을 붙인다
          const waiting = !pairText && await recentRec(d => !d.blob && (d.text || '').trim(), 3 * 3600e3);
          const rec = waiting || { id: 'rec-' + KK.uid(), kind: 'rec', noteId: target.id, createdAt: Date.now(), startAt: guessStart(f.name, dur), draft: false, src: 'share' };
          Object.assign(rec, { duration: dur, mime: type || 'audio/mp4', size: f.size, blob: f });
          if (!waiting) rec.name = name || '녹음 파일';
          else if (!rec.minutes && rec.startAt && dur) rec.startAt = guessStart(f.name, dur);
          if (pairText && !linked) { rec.text = '[녹취록]\n' + pairText; linked = true; toMinutes.push(rec); }
          if (waiting) linked = true;
          await db.putRaw(rec); recs++;
          if (target.id === S.cur && !waiting) appendToNote('[녹음 파일 · ' + rec.name + ']');
          continue;
        }
        if (type.startsWith('text/') || ext === 'txt') {
          const n = newImportedNote(name, (await f.text()).trim());
          await db.put(n); made.push(n);
        } else if (type === 'application/pdf' || ext === 'pdf' || type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
          const isPdf = type === 'application/pdf' || ext === 'pdf';
          if (isPdf && f.size > 20 * 1024 * 1024) { skipped.push(f.name + '(20MB 초과)'); continue; }
          const data = isPdf ? await fileToB64(f) : await imageToJpegB64(f);
          if (!data) { skipped.push(f.name); continue; }
          const marker = '[삼성 노트 파일: ' + (f.name || name) + ' — 정리하면 내용이 글자로 옮겨져요]';
          const n = newImportedNote(name, marker, { hasImport: true, importMarker: marker });
          await db.putMany([n, { id: 'imp-' + n.id, kind: 'imp', noteId: n.id, fileKind: isPdf ? 'document' : 'image', media_type: isPdf ? 'application/pdf' : 'image/jpeg', name: f.name, data }]);
          made.push(n);
        } else skipped.push(f.name);
      } catch (e) { skipped.push(f.name); }
    }
    const tail = settings.apiKey ? (navigator.onLine ? ' · 정리를 시작해요' : ' · 인터넷이 연결되면 정리해요') : ' · API 키를 넣으면 정리돼요';
    if (recs && KK.voice) KK.voice.refresh();
    if (made.length) {
      S.cur = null; openNote(made[made.length - 1].id); renderAll(); setView('write');
      toast(made.length + '개 노트를 가져왔어요' + tail + (recs ? ' · 녹음 ' + recs + '개 보관' : '') + (skipped.length ? ' (못 읽은 파일 ' + skipped.length + '개)' : ''), null, null, 6000);
      processQueue();
    } else if (appended || recs) {
      renderAll(); setView(appended ? 'write' : 'rec');
      const parts = [];
      if (appended) parts.push('공유받은 글을 지금 노트에 붙였어요' + tail);
      const autoOn = settings.autoMinutes !== false;
      if (toMinutes.length) {
        parts.push(!autoOn ? '녹취 글을 받았어요. 녹음 탭에서 회의록을 만들 수 있어요'
          : !settings.apiKey ? '녹취 글을 받았어요. API 키를 넣으면 회의록을 자동으로 만들어요'
            : navigator.onLine ? '녹취 글을 받았어요. Claude가 회의록을 만들고 있어요' : '녹취 글을 받았어요. 인터넷이 연결되면 회의록을 만들어요');
      } else if (recs) parts.push(linked ? '녹음 파일을 받아 녹취 글과 묶었어요' : '녹음 ' + recs + '개를 녹음 탭에 보관했어요');
      toast(parts.join(' · '), recs && appended ? '녹음 탭' : null, () => setView('rec'), 7000);
      if (appended) processQueue();
    } else if (skipped.length) {
      toast('읽을 수 없는 파일이에요. 삼성 노트에서 PDF나 텍스트 파일로 공유해 주세요.', null, null, 6000);
    }
    if (KK.minutes) toMinutes.forEach(r => KK.minutes.auto(r)); // 녹취 글 → 회의록 자동으로
  }
  async function takeShared() {
    if (!/[?&]share=1/.test(location.search)) return;
    history.replaceState(null, '', location.pathname);
    try {
      const c = await caches.open('kk-share');
      const metaRes = await c.match('share-meta');
      if (!metaRes) return;
      const meta = await metaRes.json();
      const files = [];
      for (const key of meta.files || []) {
        const r = await c.match(key);
        if (!r) continue;
        const blob = await r.blob();
        files.push(new File([blob], decodeURIComponent(r.headers.get('x-name') || 'shared'), { type: r.headers.get('content-type') || blob.type }));
        await c.delete(key);
      }
      await c.delete('share-meta');
      await importFiles(files, { title: meta.title, text: meta.text });
    } catch (e) { toast('공유된 노트를 받지 못했어요. 노트 탭의 삼성 노트 가져오기로 다시 시도해 주세요.'); }
  }
  $('btnImportNote').addEventListener('click', () => $('importNoteFile').click());
  $('importNoteFile').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) importFiles(fs); });

  /* ---------- 붙여넣기 (다른 앱에서 복사한 글·이미지) ---------- */
  let lastCaret = null;
  ['keyup', 'click', 'select', 'input', 'blur'].forEach(ev => bodyEl.addEventListener(ev, () => { lastCaret = bodyEl.selectionEnd; }));
  const cleanText = t => String(t || '').replace(/\r\n?/g, '\n').replace(/[​-‍﻿]/g, '').replace(/ /g, ' ');
  function insertText(text) {
    ensureNote();
    if (S.mode === 'pen') setMode('type');
    const v = bodyEl.value;
    const atEnd = lastCaret == null || lastCaret > v.length;
    const s = atEnd ? v.length : Math.min(bodyEl.selectionStart, lastCaret), e = atEnd ? v.length : lastCaret;
    const before = v.slice(0, s);
    const glue = before && !before.endsWith('\n') && atEnd ? '\n' : '';
    bodyEl.setRangeText(glue + text, s, e, 'end');
    lastCaret = bodyEl.selectionEnd;
    onBodyInput();
  }
  async function attachImage(blob) {
    const n = ensureNote();
    if (n.hasImport) { toast('정리 대기 중인 첨부가 이미 있어요. 먼저 정리한 뒤 붙여넣어 주세요.'); return; }
    const data = await imageToJpegB64(blob);
    if (!data) { toast('이 이미지는 읽을 수 없어요.'); return; }
    const marker = '[붙여넣은 이미지 · ' + D.stamp(Date.now()) + ' — 정리하면 글자로 옮겨져요]';
    await db.put({ id: 'imp-' + n.id, kind: 'imp', noteId: n.id, fileKind: 'image', media_type: 'image/jpeg', name: '붙여넣은 이미지', data });
    n.hasImport = true; n.importMarker = marker;
    if (S.mode === 'pen') setMode('type');
    appendToNote(marker); // 표시 줄은 항상 맨 끝 새 줄에
    lastCaret = bodyEl.value.length;
    toast('이미지를 붙였어요. 정리하면 Claude가 글자로 옮겨요.');
  }
  async function pasteFromClipboard() {
    let text = '', image = null;
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        for (const ci of await navigator.clipboard.read()) {
          const imgType = ci.types.find(t => t.startsWith('image/'));
          if (imgType && !image) image = await ci.getType(imgType);
          if (ci.types.includes('text/plain') && !text) text = await (await ci.getType('text/plain')).text();
        }
      } else text = await navigator.clipboard.readText();
    } catch (e) {
      try { text = await navigator.clipboard.readText(); }
      catch (e2) { toast('클립보드를 읽을 수 없어요. 노트 빈 곳을 길게 눌러 "붙여넣기"를 고르거나, 다른 앱에서 공유 → 끄적노트를 써 주세요.', null, null, 9000); return; }
    }
    if (text && text.trim()) { insertText(cleanText(text)); toast('붙여넣었어요'); return; }
    if (image) { await attachImage(image); return; }
    toast('클립보드가 비어 있어요. 다른 앱에서 먼저 복사해 주세요.');
  }
  // 길게 눌러 붙여넣기·키보드 붙여넣기: 글은 깨끗하게, 이미지는 첨부로
  bodyEl.addEventListener('paste', e => {
    const cd = e.clipboardData; if (!cd) return;
    const txt = cd.getData('text/plain');
    const img = [...(cd.files || [])].find(f => f.type.startsWith('image/'));
    if (txt) { e.preventDefault(); lastCaret = bodyEl.selectionEnd; const s = bodyEl.selectionStart; bodyEl.setRangeText(cleanText(txt), s, bodyEl.selectionEnd, 'end'); lastCaret = bodyEl.selectionEnd; onBodyInput(); }
    else if (img) { e.preventDefault(); attachImage(img); }
  });
  $('btnPaste').addEventListener('click', pasteFromClipboard);

  /* 받아쓰기·검색에서 쓰는 도우미 */
  function appendToNote(text, sameLine) {
    const n = ensureNote();
    const cur = bodyEl.value.replace(/\s+$/, '');
    bodyEl.value = (cur ? cur + (sameLine ? ' ' : '\n') : '') + text;
    n.body = bodyEl.value; n.updatedAt = Date.now();
    scheduleSave(); renderEditorTop();
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function selectInNote(noteId, start, len) {
    setMode('type'); openNote(noteId); setView('write');
    requestAnimationFrame(() => {
      bodyEl.focus();
      bodyEl.setSelectionRange(start, start + len);
      const before = bodyEl.value.slice(0, start).split('\n').length - 1;
      bodyEl.scrollTop = Math.max(0, before * 34 - bodyEl.clientHeight / 3);
    });
  }

  KK.app = { S, settings, openNote, newNote, deleteNote, setView, setItemStatus, setItemPriority, bodyEdited, deleteItem, adoptEvent, ensureNote, appendToNote, selectInNote, curNote, renderAll, extractMemos, saveSettings };

  /* ---------- 시작 ---------- */
  async function loadAll() {
    const docs = await db.all();
    S.notes.clear(); S.items.clear();
    const migrate = [];
    docs.forEach(d => {
      if (d.kind === 'note') S.notes.set(d.id, d);
      else if (d.kind === 'item') {
        if (!d.status) { d.status = d.done ? 'done' : 'todo'; d.locked = !!d.done; migrate.push(d); } // v0.2 → v0.3
        S.items.set(d.id, d);
      }
    });
    if (migrate.length) db.putMany(migrate);
  }
  async function start() {
    await db.init();
    await loadAll();
    if (KK.work) await KK.work.init();
    if (db.usingFallback) $('storeNote').textContent = '이 브라우저는 간이 저장소를 써요. 백업을 자주 받아 두세요.';
    if (!navigator.onLine) window.dispatchEvent(new Event('offline'));
    setMode(lsGet('kk-mode', 'type') === 'pen' ? 'pen' : 'type');
    const moved = KK.work ? KK.work.rollover() : {}; // 달이 바뀌었으면 새 달 노트로
    let last = lsGet('kk-last', '');
    if (moved[last]) last = moved[last];
    const fallback = V.notesSorted().find(n => !n.closed) || V.notesSorted()[0] || {};
    openNote(S.notes.has(last) ? last : fallback.id || null);
    renderAll();
    setView('write');
    await takeShared();
    processQueue();
    if (KK.gcal && KK.gcal.ready() && KK.gcal.hasToken()) KK.gcal.sync();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 오프라인 캐시 없이도 동작 */ });
    }
  }
  start();
})();
