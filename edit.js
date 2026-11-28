'use strict';
/* 끄적노트 — 고치기
   - 일정·할 일·전달·메모의 내용(종류·제목·날짜·시간·장소·대상·내용)을 고치는 창
   - 고치면 그 일이 적힌 노트 부분을 ~~취소선~~으로 지우고 바로 아래에 "↳ 고침(날짜): 새 내용"을 적는다
   - 직접 고친 칸은 다시 정리해도 Claude가 바꾸지 않는다(item.userFields)
   - 노트 이름 바꾸기·삭제 창
   - 노트 입력칸 뒤에 ~~ ~~ 구간을 취소선으로 그려 보이게 한다 */
window.KK = window.KK || {};

(function () {
  const { $, h, svg, toast } = KK.ui;
  const D = KK.date, db = KK.db;
  const A = () => KK.app;
  const PEN = '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/>';
  const TYPE_KO = { event: '약속', task: '할 일', notice: '전달', memo: '메모' };
  const FIELDS = ['type', 'title', 'date', 'time', 'endTime', 'place', 'to', 'detail'];
  const STRIKE = /~~(?:(?!~~)[^\n])+~~/g;
  const mdw = s => { const d = D.parse(s); return (d.getMonth() + 1) + '/' + d.getDate() + '(' + D.DOW[d.getDay()] + ')'; };
  const todayMD = () => { const d = new Date(); return (d.getMonth() + 1) + '/' + d.getDate(); };

  /* ---------- 노트 입력칸의 취소선 그리기 ---------- */
  const bodyEl = $('body'), mark = $('bodyMark');
  function paint() {
    if (!mark) return;
    const v = bodyEl.value;
    mark.textContent = '';
    if (!v.includes('~~')) return;
    let last = 0, m;
    STRIKE.lastIndex = 0;
    while ((m = STRIKE.exec(v))) { mark.append(v.slice(last, m.index), h('del', null, m[0])); last = m.index + m[0].length; }
    mark.append(v.slice(last) + '\n');
    mark.scrollTop = bodyEl.scrollTop;
  }
  let raf = 0;
  bodyEl.addEventListener('input', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); });
  bodyEl.addEventListener('scroll', () => { if (mark) mark.scrollTop = bodyEl.scrollTop; });

  /* ---------- 노트에서 그 일이 적힌 곳 찾기 ---------- */
  function inStrike(body, i) {
    STRIKE.lastIndex = 0;
    let m;
    while ((m = STRIKE.exec(body))) if (i >= m.index && i < m.index + m[0].length) return true;
    return false;
  }
  function findExact(body, s) {
    if (!s || s.length < 2) return -1;
    let i = body.indexOf(s);
    while (i >= 0 && inStrike(body, i)) i = body.indexOf(s, i + 1);
    return i;
  }
  const JOSA = /(에서|으로|까지|에게|께서|을|를|이|가|은|는|에|로|와|과|의|께|도)$/;
  const toks = s => String(s || '').replace(/[()[\]·,.:~→\-–!?'"“”‘’]/g, ' ').split(/\s+/)
    .map(w => (w.length >= 3 ? w.replace(JOSA, '') : w)).filter(w => w.length >= 2); // '회의'처럼 짧은 낱말은 그대로
  // 제목 낱말이 가장 많이 들어 있는 구절(쉼표·가운뎃점으로 나눈 조각). 같으면 먼저 적힌 것
  function findFuzzy(body, it) {
    const tk = toks(it.title), ex = toks(it.place).concat(toks(it.to));
    if (!tk.length) return null;
    let best = null, off = 0;
    body.split('\n').forEach(line => {
      const ls = off; off += line.length + 1;
      if (/^\s*(↳ 고침|\[이어서 할 일)/.test(line)) return;
      const re = /[^,，;·/]+/g;
      let m;
      while ((m = re.exec(line))) {
        const raw = m[0], text = raw.trim();
        if (!text) continue;
        const s0 = ls + m.index + (raw.length - raw.replace(/^\s+/, '').length);
        if (inStrike(body, s0) || text.startsWith('~~')) continue;
        const hit = tk.filter(t => text.includes(t)).length;
        if (!hit) continue;
        const score = hit / tk.length + (ex.some(t => text.includes(t)) ? 0.2 : 0);
        if (score >= 0.6 && (!best || score > best.score)) best = { start: s0, len: text.length, score };
      }
    });
    return best;
  }

  /* ---------- 노트에 적는 글 ---------- */
  function whenText(it) {
    const end = it.type === 'task' || it.type === 'notice' ? '까지' : '';
    if (it.date) return mdw(it.date) + (it.time ? ' ' + it.time + (it.endTime ? '~' + it.endTime : '') : '') + end;
    return it.time ? it.time + (it.endTime ? '~' + it.endTime : '') : '';
  }
  function descOf(it, withDetail) {
    const parts = [it.title + (it.type === 'notice' && it.to ? ' → ' + it.to : '')];
    const w = it.type === 'memo' ? '' : whenText(it);
    if (w) parts.push(w);
    if (it.type === 'event' && it.place) parts.push(it.place);
    if (withDetail && it.detail) parts.push(it.detail.split('\n')[0].trim().slice(0, 40));
    return parts.join(' · ');
  }

  // 노트에 취소선 + 고친 내용. 돌려주는 값은 되돌리기용
  function writeToNote(it, old, typeChanged, detailChanged) {
    const S = A().S;
    const n = S.notes.get(it.noteId) || (S.cur ? S.notes.get(S.cur) : null);
    if (!n) return null;
    const isCur = n.id === S.cur;
    const body = isCur ? bodyEl.value : (n.body || '');
    const fresh = !!n.organizedAt && n.updatedAt <= n.organizedAt + 1500 && !n.pending;
    const content = (typeChanged ? '[' + TYPE_KO[it.type] + '] ' : '') + descOf(it, detailChanged);
    const line = '↳ 고침(' + todayMD() + '): ' + content;

    let start = -1, len = 0, how = '';
    for (const [s, k] of [[old.editSrc, '지난 고침'], [old.src, '원문']]) {
      const i = findExact(body, s);
      if (i >= 0) { start = i; len = s.length; how = k; break; }
    }
    if (start < 0) { const f = findFuzzy(body, old); if (f) { start = f.start; len = f.len; how = '비슷한 구절'; } }

    let nb, caretAt = -1;
    if (start >= 0) {
      const struck = '~~' + body.substr(start, len) + '~~';
      const after = body.slice(0, start) + struck + body.slice(start + len);
      // 그 줄 끝, 바로 아래 이어지는 '↳ 고침' 줄들 뒤에 새 줄
      let eol = after.indexOf('\n', start + struck.length);
      if (eol < 0) eol = after.length;
      for (;;) {
        if (eol >= after.length) break;
        const nx = after.indexOf('\n', eol + 1), next = after.slice(eol + 1, nx < 0 ? after.length : nx);
        if (/^\s*↳ 고침/.test(next)) eol = nx < 0 ? after.length : nx; else break;
      }
      nb = after.slice(0, eol) + '\n' + line + after.slice(eol);
      caretAt = start;
    } else {
      // 못 찾으면 노트 끝에 기록으로
      const cur = body.replace(/\s+$/, '');
      nb = (cur ? cur + '\n' : '') + '~~' + descOf(old, false) + '~~\n' + line;
      how = '노트 끝';
    }
    it.editSrc = content;
    const now = Date.now();
    if (isCur) {
      const c = bodyEl.selectionStart, st = bodyEl.scrollTop;
      bodyEl.value = nb;
      const pos = caretAt >= 0 && c <= caretAt ? c : c + (nb.length - body.length);
      try { bodyEl.setSelectionRange(pos, pos); } catch (e) { /* 무시 */ }
      bodyEl.scrollTop = st;
      A().bodyEdited();
      paint();
    } else { n.body = nb; n.updatedAt = now; }
    if (fresh) n.organizedAt = n.updatedAt; // 앱이 적은 줄이라 '다시 정리하면 반영' 안내를 띄우지 않음
    db.put(n);
    return { n, prev: body, next: nb, how };
  }

  /* ---------- 일정 고치기 창 ---------- */
  let cur = null, typePick = 'task';
  function show(id, on) { const el = $(id); if (el) el.hidden = !on; }
  function layout() {
    const t = typePick;
    document.querySelectorAll('#eType button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
    show('eToL', t === 'notice');
    show('eWhen', t !== 'memo');
    show('eTimeL', t === 'event' || t === 'task');
    show('eEndL', t === 'event');
    show('ePlaceL', t === 'event');
    $('eDateL').textContent = t === 'event' ? '날짜' : t === 'notice' ? '전달 기한' : '기한';
  }
  function openItem(it) {
    if (!it) return;
    cur = it; typePick = it.type || 'task';
    $('eHead').textContent = TYPE_KO[typePick] + ' 고치기';
    $('eTitle').value = it.title || '';
    $('eTo').value = it.to || '';
    $('eDate').value = it.date || '';
    $('eTime').value = it.time || '';
    $('eEnd').value = it.endTime || '';
    $('ePlace').value = it.place || '';
    $('eDetail').value = it.detail || '';
    $('eMsg').textContent = '';
    const S = A().S, n = S.notes.get(it.noteId);
    $('eNoteL').hidden = !(n || S.cur);
    layout();
    $('dlgEdit').showModal();
    $('eHead').focus();
  }
  document.querySelectorAll('#eType button').forEach(b => b.addEventListener('click', () => { typePick = b.dataset.t; layout(); }));
  $('eCancel').addEventListener('click', () => { cur = null; $('dlgEdit').close(); });

  function save() {
    const it = cur;
    if (!it) return;
    const t = typePick;
    const v = {
      type: t,
      title: $('eTitle').value.trim().slice(0, 80),
      to: t === 'notice' ? $('eTo').value.trim().slice(0, 40) : (it.to || ''),
      date: t === 'memo' ? (it.date || '') : $('eDate').value,
      time: t === 'event' || t === 'task' ? $('eTime').value : (t === 'memo' ? (it.time || '') : ''),
      endTime: t === 'event' ? $('eEnd').value : (t === 'memo' ? (it.endTime || '') : ''),
      place: t === 'event' ? $('ePlace').value.trim().slice(0, 60) : (it.place || ''),
      detail: $('eDetail').value.trim().slice(0, 600),
    };
    if (!v.title) { $('eMsg').textContent = '제목을 적어 주세요.'; $('eTitle').focus(); return; }
    if (v.date && !D.isValid(v.date)) { $('eMsg').textContent = '날짜를 다시 골라 주세요.'; return; }
    if (v.time && v.endTime && v.endTime < v.time && t === 'event') { $('eMsg').textContent = '끝나는 시간이 시작보다 빨라요.'; return; }
    const changed = FIELDS.filter(f => (v[f] || '') !== (it[f] || ''));
    if (!changed.length) { cur = null; $('dlgEdit').close(); toast('바뀐 내용이 없어요'); return; }

    const old = JSON.parse(JSON.stringify(it));
    const now = Date.now();
    changed.forEach(f => { it[f] = v[f]; });
    // 종류가 바뀌면 그 종류에 없는 상태는 '예정'으로
    if (changed.includes('type') && ['notice', 'memo'].includes(t) && ['doing', 'hold'].includes(it.status)) it.status = 'todo';
    it.userFields = Object.assign({}, it.userFields || {});
    changed.forEach(f => { it.userFields[f] = now; });
    it.editedAt = now; it.updatedAt = now;

    let noteRes = null;
    if ($('eNote').checked && !$('eNoteL').hidden) noteRes = writeToNote(it, old, changed.includes('type'), changed.includes('detail'));
    db.put(it);
    after([it]);
    cur = null; $('dlgEdit').close();

    const where = noteRes ? (noteRes.how === '노트 끝' ? ' · 노트 끝에 고친 기록을 적었어요' : ' · 노트의 원래 내용에 취소선을 긋고 고친 내용을 적었어요') : '';
    toast('고쳤어요' + where, '되돌리기', () => undo(it, old, noteRes), 8000);
  }
  $('eSave').addEventListener('click', save);

  function undo(it, old, noteRes) {
    Object.keys(it).forEach(k => { if (!(k in old)) delete it[k]; });
    Object.assign(it, old);
    it.updatedAt = Date.now();
    db.put(it);
    if (noteRes) {
      const { n, prev, next } = noteRes, S = A().S;
      if (n.id === S.cur && bodyEl.value === next) { bodyEl.value = prev; A().bodyEdited(); paint(); }
      else if (n.id !== S.cur && n.body === next) { n.body = prev; db.put(n); }
      else toast('일정은 되돌렸어요. 노트는 그 뒤에 고쳐 써서 그대로 두었어요.');
    }
    after([it]);
  }
  function after(list) {
    const V = KK.views;
    V.renderSched(); V.renderResult(); V.renderMemo(); V.renderNotes();
    if (KK.work) KK.work.render();
    if (KK.daily) KK.daily.renderBar();
    if (KK.gcal) KK.gcal.syncSoon();
    if (KK.board) KK.board.sync(list);
  }

  /* ---------- 노트 이름 바꾸기 · 삭제 창 ---------- */
  let curNote = null;
  function openNote(n) {
    if (!n) return;
    curNote = n;
    const S = A().S, its = [...S.items.values()].filter(i => !i.deleted && i.noteId === n.id);
    const sch = its.filter(i => i.type === 'event' || i.type === 'task').length, memo = its.length - sch;
    $('nTitle').value = n.title || '';
    $('nInfo').textContent = [
      n.month && KK.work ? KK.work.monthLabel(n.month) + ' 노트' + (n.closed ? '(지난 달)' : '') : '',
      '만든 날 ' + D.stamp(n.createdAt), '마지막 고침 ' + D.stamp(n.updatedAt),
      '일정·할 일 ' + sch + '개', '전달·메모 ' + memo + '개',
    ].filter(Boolean).join(' · ');
    $('dlgNote').showModal();
    $('nHead').focus();
  }
  $('nCancel').addEventListener('click', () => { curNote = null; $('dlgNote').close(); });
  $('nSave').addEventListener('click', () => {
    const n = curNote;
    if (!n) return;
    const v = $('nTitle').value.trim().slice(0, 60);
    if (v !== (n.title || '')) {
      n.title = v; n.titleAuto = !v; n.updatedAt = Date.now();
      if (n.organizedAt && n.updatedAt <= n.organizedAt + 600000) n.organizedAt = Math.max(n.organizedAt, n.updatedAt); // 이름만 바꿈
      db.put(n);
      if (n.id === A().S.cur) $('noteTitle').value = v;
      A().renderAll();
      toast(v ? '노트 이름을 「' + v + '」(으)로 바꿨어요' : '노트 이름을 비웠어요. 정리할 때 자동으로 붙어요');
    }
    curNote = null; $('dlgNote').close();
  });
  $('nOpen').addEventListener('click', () => {
    const n = curNote; curNote = null; $('dlgNote').close();
    if (n) { A().openNote(n.id); A().setView('write'); }
  });
  $('nDel').addEventListener('click', () => {
    const n = curNote; curNote = null; $('dlgNote').close();
    if (n) { A().openNote(n.id); A().deleteNote(); } // 지운 뒤 '되돌리기' 알림이 뜸
  });

  // 노트 탭 카드 옆 연필 버튼
  const noteBtn = n => h('button', { class: 'nedit', type: 'button', title: '이름 바꾸기·삭제', 'aria-label': '「' + KK.views.noteLabel(n) + '」 노트 이름 바꾸기·삭제', onclick: e => { e.stopPropagation(); openNote(n); } }, svg(PEN));
  const itemBtn = it => h('button', { type: 'button', class: 'btn', onclick: () => { $('dlgItem').close(); openItem(it); } }, svg(PEN), '고치기');

  KK.edit = { openItem, openNote, paint, noteBtn, itemBtn, findFuzzy, descOf };
})();
