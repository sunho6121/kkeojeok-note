'use strict';
/* 끄적노트 — 녹음으로 회의록 만들기
   ① 회의 내용 글(녹취록·메모) → ② 기본 정보 → Claude가 간결하게 요약 → ③ 미리보기·고쳐 쓰기 → 한글·Word·PDF로 받기 */
(function () {
  const { $, h, toast } = KK.ui;
  const D = KK.date, db = KK.db, G = KK.docgen;
  const A = () => KK.app;

  let rec = null;          // 지금 열린 녹음
  let model = null;        // 회의록 내용 (요약·안건·결정·조치·첨부)
  let editing = false;
  let running = null;      // { rec, ctrl } — 만드는 중인 회의록
  let saveTimer = null;
  let oldTitle = null;

  const cleanText = t => String(t || '').replace(/\r\n?/g, '\n').replace(/[​-‍﻿]/g, '').replace(/ /g, ' ');
  const clone = o => JSON.parse(JSON.stringify(o));
  const startOf = r => r.startAt || r.createdAt;
  function durText(sec) {
    const s = Math.round(sec || 0), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
    return hh ? hh + '시간 ' + mm + '분' : mm ? mm + '분' : s + '초';
  }
  function whenOf(r) {
    const s = new Date(startOf(r)), e = new Date(startOf(r) + (r.duration || 0) * 1000);
    const hm = d => D.pad(d.getHours()) + ':' + D.pad(d.getMinutes());
    return s.getFullYear() + '. ' + (s.getMonth() + 1) + '. ' + s.getDate() + '.(' + D.DOW[s.getDay()] + ') ' + hm(s) + ((r.duration || 0) >= 60 ? '~' + hm(e) : '');
  }
  function setMsg(id, text, kind, spin) {
    const el = $(id);
    el.className = 'mmsg' + (kind ? ' ' + kind : '');
    el.textContent = '';
    if (spin) el.append(h('span', { class: 'spin', 'aria-hidden': 'true' }));
    el.append(text || '');
  }

  /* ---------- 열기·닫기 ---------- */
  function open(r) {
    if (!r) return;
    rec = r; editing = false;
    model = r.minutes ? clone(r.minutes) : null;
    const n = A().S.notes.get(r.noteId);
    $('mRecMeta').textContent = (r.name || '녹음') + ' · ' + (r.blob ? durText(r.duration) : '녹취 글만 있음') + (n ? ' · 「' + KK.views.noteLabel(n) + '」 노트' : '');
    $('mSrc').value = r.text != null ? r.text : (r.memo ? '[녹음하면서 쓴 메모]\n' + r.memo : '');
    const meta = r.mmeta || {};
    $('mTitle').value = meta.title || '';
    $('mWhen').value = meta.when || whenOf(r);
    $('mPlace').value = meta.place || '';
    $('mAtt').value = meta.attendees || '';
    $('mPick').hidden = true;
    setMsg('mSrcMsg', ''); setMsg('mDlMsg', '');
    countSrc(); renderRun(); renderOut();
    if (!$('dlgMinutes').open) $('dlgMinutes').showModal();
    $('dlgMinutes').querySelector('.dlg').scrollTop = 0;
  }
  function close() { $('dlgMinutes').close(); }
  $('dlgMinutes').addEventListener('close', () => {
    flushSave();
    if (oldTitle != null) { document.title = oldTitle; oldTitle = null; }
    rec = null;
  });
  $('mClose').addEventListener('click', close);

  /* ---------- 저장 ---------- */
  function readMeta() {
    return { title: $('mTitle').value.trim(), when: $('mWhen').value.trim(), place: $('mPlace').value.trim(), attendees: $('mAtt').value.trim() };
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 600); }
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!rec) return;
    rec.text = $('mSrc').value;
    rec.mmeta = readMeta();
    if (model) rec.minutes = model;
    db.putRaw(rec).catch(() => setMsg('mMsg', '저장하지 못했어요. 저장 공간을 확인해 주세요.', 'err'));
  }

  /* ---------- ① 회의 내용 글 ---------- */
  function countSrc() {
    const n = $('mSrc').value.trim().length;
    $('mSrcCount').textContent = n ? n.toLocaleString() + '자' + (n > 150000 ? ' · 너무 길면 앞뒤를 나눠 주세요' : '') : '';
  }
  function appendSrc(text, label) {
    const t = cleanText(text).trim();
    if (!t) return false;
    const cur = $('mSrc').value.replace(/\s+$/, '');
    $('mSrc').value = (cur ? cur + '\n\n' : '') + (label ? '[' + label + ']\n' : '') + t;
    $('mSrc').scrollTop = $('mSrc').scrollHeight;
    countSrc(); scheduleSave();
    return true;
  }
  $('mSrc').addEventListener('input', () => { countSrc(); scheduleSave(); });
  $('mPaste').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (appendSrc(t)) setMsg('mSrcMsg', '붙여넣었어요.', 'ok');
      else setMsg('mSrcMsg', '클립보드가 비어 있어요. 다른 앱에서 먼저 복사해 주세요.', 'err');
    } catch (e) {
      setMsg('mSrcMsg', '클립보드를 읽을 수 없어요. 위 칸을 길게 눌러 "붙여넣기"를 골라 주세요.', 'err');
    }
  });
  $('mFile').addEventListener('click', () => $('mFileIn').click());
  $('mFileIn').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { setMsg('mSrcMsg', '5MB보다 큰 파일은 불러올 수 없어요.', 'err'); return; }
    if (appendSrc(await f.text(), f.name)) setMsg('mSrcMsg', '「' + f.name + '」을(를) 넣었어요.', 'ok');
    else setMsg('mSrcMsg', '파일에 글이 없어요.', 'err');
  });

  /* 노트에서 가져오기: 받아쓰기·공유받은 글·녹음 표시 줄을 기준으로 나눈 덩어리를 골라 넣는다 */
  const MARK = /^\[(받아쓰기|공유받은 글|녹음|녹음 파일|붙여넣은 이미지|삼성 노트 파일)[^\]]*\]/;
  function noteBlocks(body) {
    const out = [];
    let cur = { head: '', lines: [] };
    const push = () => { const t = cur.lines.join('\n').trim(); if (t) out.push({ head: cur.head, text: t }); };
    String(body || '').split('\n').forEach(line => {
      const m = line.trim().match(MARK);
      if (m) { push(); cur = { head: m[0], lines: [] }; const rest = line.trim().slice(m[0].length).trim(); if (rest) cur.lines.push(rest); }
      else cur.lines.push(line);
    });
    push();
    return out;
  }
  $('mFromNote').addEventListener('click', () => {
    const box = $('mPick');
    if (!box.hidden) { box.hidden = true; return; }
    const n = rec && A().S.notes.get(rec.noteId);
    box.textContent = '';
    if (!n || !(n.body || '').trim()) { setMsg('mSrcMsg', '이 녹음이 붙은 노트에 글이 없어요.', 'err'); return; }
    const blocks = noteBlocks(n.body).reverse().slice(0, 20);
    const list = h('div', { class: 'mpick' });
    blocks.forEach((b, i) => list.append(h('label', null,
      h('input', { type: 'checkbox', 'data-i': i }),
      h('div', null, h('small', null, (b.head || '노트 앞부분') + ' · ' + b.text.length.toLocaleString() + '자'), h('div', { class: 'pv' }, b.text)))));
    box.append(
      h('p', { style: 'margin:0' }, '「' + KK.views.noteLabel(n) + '」 노트를 받아쓰기·공유받은 글·녹음 표시마다 나눴어요. 아래쪽에 쓴 것이 위에 나와요.'),
      list,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => {
          const picked = [...list.querySelectorAll('input:checked')].map(c => blocks[+c.dataset.i]).reverse();
          if (!picked.length) { setMsg('mSrcMsg', '넣을 부분을 골라 주세요.', 'err'); return; }
          picked.forEach(b => appendSrc(b.text, (b.head || '노트').replace(/^\[|\]$/g, '')));
          box.hidden = true;
          setMsg('mSrcMsg', picked.length + '개 부분을 넣었어요.', 'ok');
        } }, '고른 부분 넣기'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { box.hidden = true; } }, '닫기')));
    box.hidden = false;
  });

  /* ---------- ② 기본 정보 ---------- */
  ['mTitle', 'mWhen', 'mPlace', 'mAtt'].forEach(id => $(id).addEventListener('input', () => { scheduleSave(); if (model && !editing) renderPreview(); }));

  /* ---------- Claude로 만들기 ---------- */
  function errCopy(e) {
    switch (e.code) {
      case 'bad_key': return 'API 키가 맞지 않아요. 설정에서 키를 확인해 주세요.';
      case 'forbidden': return '이 API 키로는 쓸 수 없어요. Anthropic 콘솔에서 권한·결제를 확인해 주세요.';
      case 'bad_model': return '선택한 모델을 쓸 수 없어요. 설정에서 다른 모델을 골라 주세요.';
      case 'rate': return '요청이 많거나 사용 한도에 닿았어요. 잠시 뒤 다시 해 주세요.';
      case 'server': return 'Claude 서버가 바빠요. 잠시 뒤 다시 해 주세요.';
      case 'too_large': return '글이 너무 길어요. 앞뒤로 나눠서 따로 만들어 주세요.';
      case 'refused': return '이 내용으로는 회의록을 만들지 못했어요.';
      case 'offline': return '인터넷에 연결되어 있지 않아요.';
      case 'cancelled': return '그만뒀어요.';
      case 'bad_output': return e.message || '결과를 읽지 못했어요. 한 번 더 해 주세요.';
      default: return '회의록을 만들지 못했어요: ' + (e.message || '알 수 없는 오류');
    }
  }
  function renderRun() {
    const mine = running && rec && running.rec.id === rec.id;
    $('mRun').disabled = !!running;
    $('mRun').textContent = model ? '다시 만들기' : 'Claude로 회의록 만들기';
    $('mStop').hidden = !mine;
    if (mine) setMsg('mMsg', 'Claude가 회의록을 쓰는 중이에요. 글이 길면 1~2분 걸려요.', '', true);
    else if (running) setMsg('mMsg', '다른 녹음의 회의록을 만드는 중이에요. 끝난 뒤에 해 주세요.');
    else setMsg('mMsg', model ? '' : '글을 넣고 누르면 Claude가 핵심만 간결하게 정리해요.');
  }
  function fromClaude(o, meta) {
    const actions = o.actions.map(a => {
      const tail = [a.owner && '담당: ' + a.owner, a.due && '기한: ' + a.due].filter(Boolean).join(' / ');
      return a.task + (tail ? ' (' + tail + ')' : '');
    });
    if (o.next) actions.push('다음 회의: ' + o.next);
    return {
      title: meta.title || o.title, when: meta.when, place: meta.place || o.place, attendees: meta.attendees || o.attendees,
      summary: o.summary, agenda: o.agenda, decisions: o.decisions, actions, attachments: o.attachments,
    };
  }
  /* 회의록 만들기 핵심 — 창에서 누를 때와 공유받아 자동으로 만들 때 함께 쓴다 */
  async function generate(r, text, meta) {
    const s = A().settings, ctrl = new AbortController();
    running = { rec: r, ctrl };
    if (rec && rec.id === r.id) renderRun();
    if (KK.voice) KK.voice.refresh();
    try {
      const out = await KK.claude.minutes({
        apiKey: s.apiKey, model: s.model, effort: s.effort, text, signal: ctrl.signal,
        meta: Object.assign({ date: D.ymd(new Date(startOf(r))) }, meta),
      });
      const m = fromClaude(out, meta);
      r.minutes = m; r.minutesAt = Date.now(); r.minutesModel = s.model; r.text = text;
      r.mmeta = { title: m.title, when: m.when, place: m.place, attendees: m.attendees };
      r.minutesActions = out.actions;
      r.autoMinutes = 'done';
      await db.putRaw(r);
      const added = s.minutesTasks === false ? 0 : syncTasks(r, m, out.actions);
      return { m, added };
    } finally {
      running = null;
      if (rec && rec.id === r.id) renderRun();
      if (KK.voice) KK.voice.refresh();
    }
  }

  /* 회의록의 향후조치 → 업무(할 일). 다시 만들면 손대지 않은 이전 항목은 바꿔 넣는다 */
  function syncTasks(r, m, actions) {
    const S = A().S, now = Date.now();
    const norm = t => String(t || '').replace(/\s+/g, '').toLowerCase();
    const mine = [...S.items.values()].filter(i => i.recId === r.id && i.source === 'minutes');
    const drop = mine.filter(i => !i.locked && (i.status || 'todo') === 'todo');
    drop.forEach(i => S.items.delete(i.id));
    if (drop.length) db.delMany(drop.map(i => i.id));
    const have = new Set([...S.items.values()].filter(i => !i.deleted).map(i => norm(i.title)));
    const n = S.notes.get(r.noteId);
    const noteId = n && !n.closed ? n.id : (S.cur || (n ? n.id : ''));
    const docs = [];
    (actions || []).forEach(a => {
      const title = a.task + (a.owner ? ' (' + a.owner + ')' : '');
      if (have.has(norm(title)) || have.has(norm(a.task))) return;
      have.add(norm(title));
      docs.push({
        id: 't-' + KK.uid(), kind: 'item', noteId, type: 'task', title: title.slice(0, 80), date: a.dueDate || '', time: '', endTime: '', place: '', to: '',
        priority: 'normal', detail: '회의: ' + (m.title || r.name || ''), status: 'todo', locked: false, deleted: false,
        createdAt: now, updatedAt: now, doneAt: 0, source: 'minutes', recId: r.id,
      });
    });
    // 결정사항 → 중요 메모 (회의에서 정해진 것)
    (m.decisions || []).forEach(t => {
      const title = String(t).trim().slice(0, 60);
      if (!title || have.has(norm(title))) return;
      have.add(norm(title));
      docs.push({
        id: 't-' + KK.uid(), kind: 'item', noteId, type: 'memo', title, date: '', time: '', endTime: '', place: '', to: '',
        priority: 'normal', detail: '회의 결정 · ' + (m.title || r.name || ''), status: 'todo', locked: false, deleted: false,
        createdAt: now, updatedAt: now, doneAt: 0, source: 'minutes', recId: r.id,
      });
    });
    docs.forEach(d => S.items.set(d.id, d));
    if (docs.length) db.putMany(docs);
    if (A().renderAll) A().renderAll();
    if (KK.gcal && docs.some(d => d.date)) KK.gcal.syncSoon();
    return docs.filter(d => d.type === 'task').length;
  }

  async function run() {
    if (running || !rec) return;
    const text = $('mSrc').value.trim();
    const s = A().settings;
    if (text.length < 20) { setMsg('mMsg', '회의 내용 글이 너무 짧아요. 녹취록이나 메모를 먼저 넣어 주세요.', 'err'); $('mSrc').focus(); return; }
    if (!s.apiKey) { setMsg('mMsg', '설정에서 Claude API 키를 먼저 넣어 주세요.', 'err'); return; }
    if (!navigator.onLine) { setMsg('mMsg', '인터넷에 연결되어 있지 않아요. 연결된 뒤 다시 눌러 주세요.', 'err'); return; }
    if (model && !confirm('지금 회의록을 지우고 새로 만들까요? 고친 내용도 사라져요.')) return;
    flushSave();
    const r = rec, meta = readMeta();
    try {
      const { m, added } = await generate(r, text, meta);
      if (rec && rec.id === r.id && $('dlgMinutes').open) {
        model = clone(m); editing = false;
        $('mTitle').value = m.title; $('mPlace').value = m.place; $('mAtt').value = m.attendees;
        renderRun(); renderOut();
        setMsg('mMsg', '회의록을 만들었어요.' + (added ? ' 향후조치 ' + added + '건을 업무 탭에 넣었어요.' : '') + ' 아래에서 확인하고 내려받으세요.', 'ok');
        $('mOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        toast('「' + (m.title || r.name) + '」 회의록이 준비됐어요', '보기', () => open(r), 8000);
      }
    } catch (e) {
      if (rec && rec.id === r.id) setMsg('mMsg', errCopy(e), e.code === 'cancelled' ? '' : 'err');
      else if (e.code !== 'cancelled') toast(errCopy(e), null, null, 7000);
    }
  }
  $('mRun').addEventListener('click', run);

  /* ---------- 공유받은 녹취 글로 자동 만들기 ---------- */
  const queue = [];
  let draining = false;
  function auto(r) {
    if (!r || A().settings.autoMinutes === false) return false;
    if (!queue.includes(r.id)) queue.push(r.id);
    r.autoMinutes = 'pending';
    db.putRaw(r).then(drain);
    return true;
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const s = A().settings;
        if (!navigator.onLine || !s.apiKey) break; // 남은 건 연결되면 다시
        while (running) await new Promise(x => setTimeout(x, 700));
        const r = await db.get(queue[0]);
        if (!r || r.minutes || !(r.text || '').trim() || r.autoMinutes !== 'pending') { queue.shift(); continue; }
        try {
          const meta = Object.assign({ when: whenOf(r) }, r.mmeta || {});
          const { m, added } = await generate(r, r.text.trim(), { title: meta.title || '', when: meta.when || whenOf(r), place: meta.place || '', attendees: meta.attendees || '' });
          toast('「' + (m.title || r.name) + '」 회의록을 만들었어요' + (added ? ' · 할 일 ' + added + '건을 업무에 넣었어요' : ''), '보기', () => open(r), 9000);
        } catch (e) {
          if (e.code === 'offline') break;
          r.autoMinutes = 'error'; db.putRaw(r);
          if (e.code !== 'cancelled') toast('회의록을 자동으로 만들지 못했어요: ' + errCopy(e), '열기', () => open(r), 9000);
        }
        queue.shift();
      }
    } finally { draining = false; }
  }
  /* 앱을 다시 열거나 인터넷이 연결되면, 기다리던 자동 회의록을 이어서 만든다 */
  async function resume() {
    if (db.usingFallback) return;
    (await db.all()).filter(d => d.kind === 'rec' && d.autoMinutes === 'pending' && !d.minutes).forEach(d => { if (!queue.includes(d.id)) queue.push(d.id); });
    drain();
  }
  const isRunning = id => !!(running && running.rec.id === id) || queue.includes(id);
  $('mStop').addEventListener('click', () => { if (running) running.ctrl.abort(); });

  /* ---------- ③ 미리보기·고쳐 쓰기·내려받기 ---------- */
  function docModel() {
    const meta = readMeta();
    return Object.assign({}, model, { title: meta.title || model.title, when: meta.when, place: meta.place, attendees: meta.attendees });
  }
  function renderPreview() { $('mPreview').innerHTML = G.html(docModel()); }
  function renderOut() {
    $('mOut').hidden = !model;
    if (!model) return;
    renderPreview();
    $('mPreview').hidden = editing;
    $('mEdit').hidden = !editing;
    $('mEditBtn').textContent = editing ? '고친 내용 적용' : '글 고치기';
    const at = rec && rec.minutesAt;
    $('mMade').textContent = at ? D.stamp(at) + ' 만듦' : '';
  }
  function applyEdit() {
    if (!editing) return;
    model = G.fromText($('mEdit').value, model);
    editing = false;
    flushSave();
  }
  $('mEditBtn').addEventListener('click', () => {
    if (editing) { applyEdit(); renderOut(); setMsg('mDlMsg', '고친 내용을 적용했어요.', 'ok'); return; }
    $('mEdit').value = G.text(model);
    editing = true; renderOut();
    setMsg('mDlMsg', '# 로 시작하는 줄은 칸 이름이에요. ○는 항목, -는 세부 항목, "1. "은 안건 제목이에요.');
    $('mEdit').focus();
  });

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function printPdf(m, base) {
    $('printArea').innerHTML = G.html(m);
    if (oldTitle == null) oldTitle = document.title;
    document.title = base; // 저장할 PDF 파일 이름이 된다
    setMsg('mDlMsg', '인쇄 화면이 열리면 프린터를 "PDF로 저장"으로 고르고 저장(다운로드) 버튼을 누르세요.');
    setTimeout(() => {
      try { window.print(); } catch (e) { setMsg('mDlMsg', '이 기기에서는 인쇄 화면을 열 수 없어요. 한글이나 Word 파일로 받아 주세요.', 'err'); }
    }, 80);
  }
  function download(fmt) {
    if (!model || !rec) return;
    applyEdit(); renderOut();
    const m = docModel();
    const base = G.fileBase(m, D.ymd(new Date(startOf(rec))));
    if (fmt === 'pdf') { printPdf(m, base); return; }
    try {
      const bytes = fmt === 'hwpx' ? G.hwpx(m) : G.docx(m);
      const type = fmt === 'hwpx' ? 'application/hwp+zip' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      saveBlob(new Blob([bytes], { type }), base + '.' + fmt);
      setMsg('mDlMsg', '「' + base + '.' + fmt + '」을(를) 다운로드 폴더에 저장했어요.', 'ok');
    } catch (e) {
      setMsg('mDlMsg', '파일을 만들지 못했어요: ' + (e.message || e), 'err');
    }
  }
  $('dlgMinutes').querySelectorAll('[data-fmt]').forEach(b => b.addEventListener('click', () => download(b.dataset.fmt)));

  KK.minutes = { open, noteBlocks, whenOf, auto, resume, isRunning };
})();
