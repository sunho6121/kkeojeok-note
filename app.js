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
  const DEFAULTS = { apiKey: '', model: 'claude-sonnet-5-5', effort: 'high', v: 2 };
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
  function renderEditorTop() { V.renderChips(); V.renderResult(); }
  function renderAll() {
    $('todayLabel').textContent = D.longToday();
    renderEditorTop(); V.renderNotes(); V.renderSched();
  }
  function setView(v) {
    document.body.dataset.view = v;
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.v === v ? 'page' : 'false'));
    if (v === 'write' && S.mode === 'pen') requestAnimationFrame(() => ink.resize());
    if (v === 'sched') V.renderSched();
    if (v === 'notes') V.renderNotes();
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
    S.showSummary = false;
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
    clearTimeout(topTimer); topTimer = setTimeout(renderEditorTop, 500);
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
    const cutoff = Date.now() - 60 * 86400000;
    const mine = [...S.items.values()]
      .filter(i => i.noteId === n.id && (!i.deleted || (i.deletedAt || 0) > cutoff))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-150);
    const refMap = {}, list = [];
    mine.forEach((it, idx) => {
      const ref = 'e' + (idx + 1);
      refMap[ref] = it;
      list.push({ ref, type: it.type, title: it.title, date: it.date, time: it.time, place: it.place, status: it.status || 'todo', locked: !!it.locked, deleted: !!it.deleted });
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

  const FIELDS = ['type', 'title', 'date', 'time', 'endTime', 'place', 'priority', 'detail'];
  function applyResult(n, out, hadInk, refMap, hadFile) {
    const now = Date.now();
    const isCur = n.id === S.cur;
    if (isCur) n.body = bodyEl.value;
    if (hadFile && n.importMarker) {
      n.body = (n.body || '').replace(n.importMarker, '').replace(/^\s+/, '');
      delete n.importMarker;
    }
    if ((hadInk || hadFile) && out.transcript) {
      const label = hadFile && !hadInk ? '[삼성 노트에서 가져옴 · ' : '[필기 옮김 · ';
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
    const mine = [...S.items.values()].filter(i => i.noteId === n.id);
    const tomb = new Set(mine.filter(i => i.deleted).map(key));
    const live = new Set(mine.filter(i => !i.deleted).map(key));
    const changed = [];
    let added = 0, updated = 0;
    out.items.forEach(r => {
      const t = r.ref ? refMap[r.ref] : null;
      if (t) {
        if (t.deleted) return;
        const before = JSON.stringify([FIELDS.map(f => t[f]), t.status]);
        FIELDS.forEach(f => { if (r[f] !== '' && r[f] != null) t[f] = r[f]; });
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
      S.items.set(doc.id, doc); changed.push(doc); live.add(k); added++;
    });
    db.putMany([n, ...changed]);
    return { added, updated };
  }

  let queueRunning = false;
  async function processQueue() {
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
    $('btnOrganize').hidden = !!on || !$('vbar').hidden;
    if (on) $('busyText').textContent = (n && n.id !== S.cur ? '「' + V.noteLabel(n) + '」 ' : '') + 'Claude가 메모를 꼼꼼히 읽고 있어요 · 길면 1분쯤 걸려요';
  }

  /* ---------- 일정 상태 ---------- */
  function setItemStatus(it, s) {
    const now = Date.now();
    it.status = s; it.locked = true; it.statusAt = now; it.updatedAt = now;
    it.doneAt = s === 'done' ? now : 0;
    db.put(it); V.renderSched(); V.renderResult();
  }
  function deleteItem(it) {
    it.deleted = true; it.deletedAt = Date.now();
    db.put(it); V.renderSched(); V.renderResult();
    toast('「' + it.title + '」을(를) 지웠어요', '되돌리기', () => { it.deleted = false; it.deletedAt = 0; db.put(it); V.renderSched(); V.renderResult(); });
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
    const list = [...S.items.values()].filter(i => !i.deleted && i.date && i.date >= from && ['todo', 'doing'].includes(i.status || 'todo'));
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
      const docs = data.docs.filter(d => d && typeof d.id === 'string' && ['note', 'item', 'ink', 'imp'].includes(d.kind));
      await db.putMany(docs);
      await loadAll(); S.cur = null; openNote(lsGet('kk-last', '')); renderAll();
      toast('백업에서 ' + docs.filter(d => d.kind === 'note').length + '개 노트를 불러왔어요');
    } catch (e) { toast('백업 파일을 읽지 못했어요. 끄적노트에서 받은 .json 파일인지 확인해 주세요.'); }
  }

  /* ---------- 설정 ---------- */
  const dlg = $('dlgSettings');
  function openSettings() {
    $('apiKey').value = settings.apiKey; $('model').value = settings.model; $('effort').value = settings.effort; $('keyMsg').textContent = '';
    $('btnDelNote').hidden = !curNote();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function readSettingsForm() {
    settings.apiKey = $('apiKey').value.replace(/\s+/g, ''); settings.model = $('model').value; settings.effort = $('effort').value; saveSettings();
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
  document.querySelectorAll('#segStatus button').forEach(b => b.addEventListener('click', () => {
    S.sview = b.dataset.s; S.day = null;
    document.querySelectorAll('#segStatus button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    V.renderSched();
  }));
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.v)));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
    else if (D.today() !== S.lastDay) { S.lastDay = D.today(); renderAll(); }
  });
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('online', () => { $('sync').dataset.s = 'ok'; $('sync').textContent = '기기에 저장됨'; processQueue(); });
  window.addEventListener('offline', () => { $('sync').dataset.s = 'busy'; $('sync').textContent = '오프라인 · 기기에 저장 중'; });
  setInterval(() => { if (D.today() !== S.lastDay) { S.lastDay = D.today(); renderAll(); } }, 60000);

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
    S.notes.set(n.id, n);
    return n;
  }
  async function importFiles(files, shared) {
    flushSave();
    const made = [], skipped = [];
    if (shared && shared.text && shared.text.trim()) {
      const n = newImportedNote(shared.title || '', shared.text.trim());
      await db.put(n); made.push(n);
    }
    for (const f of files) {
      const name = (f.name || '').replace(/\.[^.]+$/, '') || '삼성 노트';
      const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
      const type = f.type || '';
      try {
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
    if (made.length) {
      S.cur = null; openNote(made[made.length - 1].id); renderAll(); setView('write');
      const tail = settings.apiKey ? (navigator.onLine ? ' · 정리를 시작해요' : ' · 인터넷이 연결되면 정리해요') : ' · API 키를 넣으면 정리돼요';
      toast(made.length + '개 노트를 가져왔어요' + tail + (skipped.length ? ' (못 읽은 파일 ' + skipped.length + '개)' : ''), null, null, 6000);
      processQueue();
    } else if (skipped.length) {
      toast('읽을 수 없는 파일이에요. 삼성 노트에서 PDF나 텍스트 파일로 공유해 주세요.', null, null, 6000);
    }
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

  KK.app = { S, settings, openNote, newNote, setView, setItemStatus, deleteItem, ensureNote, appendToNote, selectInNote, curNote };

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
    if (db.usingFallback) $('storeNote').textContent = '이 브라우저는 간이 저장소를 써요. 백업을 자주 받아 두세요.';
    if (!navigator.onLine) window.dispatchEvent(new Event('offline'));
    setMode(lsGet('kk-mode', 'type') === 'pen' ? 'pen' : 'type');
    const last = lsGet('kk-last', '');
    openNote(S.notes.has(last) ? last : (V.notesSorted()[0] || {}).id || null);
    renderAll();
    setView('write');
    await takeShared();
    processQueue();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 오프라인 캐시 없이도 동작 */ });
    }
  }
  start();
})();
