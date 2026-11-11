'use strict';
/* 끄적노트 — 날마다 이어 쓰기
   - 노트에 날짜만 한 줄로 적으면(예: 11/11, 11.11(수), 11월 11일) 전날까지 못 끝낸 할 일·전달사항을 바로 아래에 불러와 정리해 넣는다.
   - 불러온 일 가운데 우선순위를 아직 안 정한 것이 있으면 '우선순위 정하기' 창을 띄워 높음·보통·낮음을 고르게 한다.
   - 불러온 줄은 기존 항목이라 Claude가 정리할 때 새 항목으로 만들지 않는다(app.js existingFor · claude.js 규칙). */
window.KK = window.KK || {};

(function () {
  const { $, h, toast } = KK.ui;
  const D = KK.date, db = KK.db;
  const A = () => KK.app;

  const PRI = [['high', '높음'], ['normal', '보통'], ['low', '낮음']];
  const PRI_KO = { high: '높음', normal: '보통', low: '낮음' };
  const RANK = { high: 0, normal: 1, low: 2 };
  const rank = it => (it.priority in RANK ? RANK[it.priority] : 1);
  const HEAD = '[이어서 할 일 · ';
  const MAX = 25;
  const md = s => { const d = D.parse(s); return (d.getMonth() + 1) + '/' + d.getDate(); };
  const dateLabel = s => md(s) + '(' + D.DOW[D.parse(s).getDay()] + ')';
  const prevDay = x => D.ymd(D.addDays(D.parse(x), -1));

  /* ---------- 날짜만 적은 줄 알아보기 ---------- */
  const DECO_L = /^[\s#■□▶▷►●○◆◇★☆※=\-–—*·•<[(【〈《「『]+/;
  const DECO_R = /[\s\]>】〉》」』=\-–—*·•:■□▶◀►●○◆◇★☆※]+$/;
  const DOW_RE = '(?:\\(?\\s*[월화수목금토일](?:요일)?\\s*\\)?)?';
  const RES = [
    new RegExp('^(\\d{4})\\s*[.\\-/년]\\s*(\\d{1,2})\\s*[.\\-/월]\\s*(\\d{1,2})\\s*[.일]?\\s*' + DOW_RE + '$'),
    new RegExp('^(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일?\\s*' + DOW_RE + '$'),
    new RegExp('^(\\d{1,2})\\s*[./]\\s*(\\d{1,2})\\s*\\.?\\s*' + DOW_RE + '$'),
  ];
  function toYmd(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    if (!y) {
      const now = new Date(); y = now.getFullYear();
      if (now.getMonth() === 11 && m === 1) y++;       // 12월에 1/2를 적으면 내년
      else if (now.getMonth() === 0 && m === 12) y--;  // 1월에 12/31을 적으면 작년
    }
    const s = y + '-' + D.pad(m) + '-' + D.pad(d);
    return D.isValid(s) ? s : null;
  }
  function dateOfLine(line) {
    let t = String(line || '').trim();
    if (!t || t.length > 24) return null;
    t = t.replace(DECO_L, '').replace(DECO_R, '');
    for (let i = 0; i < RES.length; i++) {
      const m = t.match(RES[i]);
      if (m) return i === 0 ? toYmd(+m[1], +m[2], +m[3]) : toYmd(0, +m[1], +m[2]);
    }
    return null;
  }
  // 어제 ~ 사흘 뒤 날짜만 '오늘 쓰는 날짜'로 본다 (지난 기록을 옮겨 적을 때는 불러오지 않음)
  const inWindow = x => { const k = D.diffDays(D.today(), x); return k >= -1 && k <= 3; };

  /* ---------- 못 끝낸 일 고르기 ---------- */
  const isWork = i => !i.deleted && (i.type === 'task' || i.type === 'notice');
  const isRunning = n => n && !n.closed && !n.imported;
  function carryList(x) {
    const start = D.parse(x).getTime();
    return [...A().S.items.values()].filter(i => isWork(i) && ['todo', 'doing'].includes(i.status || 'todo') &&
      !(i.carryDays || []).includes(x) && (i.date ? i.date < x : (i.createdAt || 0) < start));
  }
  const holdCount = x => [...A().S.items.values()].filter(i => isWork(i) && i.status === 'hold' && (!i.date || i.date < x)).length;
  const sortList = list => list.sort((a, b) => (a.status === 'done') - (b.status === 'done') || rank(a) - rank(b) ||
    (a.date || '9999').localeCompare(b.date || '9999') || (a.createdAt || 0) - (b.createdAt || 0));
  // 우선순위를 정해야 하는 일: 아직 사람이 안 정했고, 노트에 '급함·중요'로 적힌 것도 아님
  const needsPri = it => !it.priSet && (it.priority || 'normal') === 'normal' && !['done', 'cancel'].includes(it.status);

  /* ---------- 노트에 넣는 글 ---------- */
  function lineOf(it, x) {
    const st = it.status || 'todo', closed = st === 'done' || st === 'cancel';
    const tag = closed ? '' : it.priSet || it.priority === 'high' || it.priority === 'low' ? '[' + PRI_KO[it.priority || 'normal'] + '] ' : '';
    const bits = [];
    if (it.date) { const late = D.diffDays(it.date, x); bits.push(md(it.date) + '까지' + (late >= 2 ? '·' + late + '일 지남' : '')); }
    else bits.push('기한 없음');
    if (st === 'doing') bits.push('진행 중');
    if (st === 'done') bits.push('끝냄');
    if (st === 'cancel') bits.push('취소');
    return '- ' + tag + it.title + (it.type === 'notice' && it.to ? ' → ' + it.to : '') + ' · ' + bits.join(', ');
  }
  function blockText(x, list) {
    const open = list.filter(i => !['done', 'cancel'].includes(i.status)).length;
    const lines = [HEAD + md(prevDay(x)) + '까지 못 끝낸 ' + list.length + '건' + (open < list.length ? ', 남은 ' + open + '건' : '') + ']']
      .concat(list.slice(0, MAX).map(i => lineOf(i, x)));
    if (list.length > MAX) lines.push('- 외 ' + (list.length - MAX) + '건은 업무 탭에서 보기');
    return lines.join('\n');
  }
  const itemsOf = (n, x) => ((n.dailyCarry && n.dailyCarry[x] && n.dailyCarry[x].ids) || []).map(id => A().S.items.get(id)).filter(i => i && !i.deleted);

  /* 이 노트에 불러다 적은 항목 id (정리할 때 기존 항목으로 넘긴다) */
  function refs(n) {
    const s = new Set();
    Object.values((n && n.dailyCarry) || {}).forEach(d => (d.ids || []).forEach(id => s.add(id)));
    return s;
  }

  /* ---------- 날짜 줄을 적으면 불러오기 ---------- */
  let idle = null, composing = false;
  function onInput() {
    clearTimeout(idle);
    const el = $('body'), v = el.value, c = el.selectionStart;
    if (c == null || c !== el.selectionEnd) return;
    // 1) 날짜 줄 끝에서 줄을 바꿨을 때 → 곧바로
    if (v[c - 1] === '\n') {
      const ls = v.lastIndexOf('\n', c - 2) + 1;
      const x = dateOfLine(v.slice(ls, c - 1));
      if (x) setTimeout(() => { if ($('body').value === v) run(x, c, true); }, 60);
      return;
    }
    // 2) 날짜만 적고 잠깐 멈췄을 때 (커서가 그 줄 끝에 있을 때)
    const le = v.indexOf('\n', c);
    if (c !== (le < 0 ? v.length : le)) return;
    const x = dateOfLine(v.slice(v.lastIndexOf('\n', c - 1) + 1, c));
    if (x) idle = setTimeout(() => { if (!composing && $('body').value === v && $('body').selectionStart === c) run(x, c, false); }, 2500);
  }
  $('body').addEventListener('compositionstart', () => { composing = true; });
  $('body').addEventListener('compositionend', () => { composing = false; });

  // 이 날짜를 다른 노트에서 이미 불러왔는지
  const takenBy = x => [...A().S.notes.values()].find(n => n.dailyCarry && n.dailyCarry[x]);

  function run(x, pos, afterBreak) {
    const n = A().curNote();
    if (!isRunning(n) || !inWindow(x)) return;
    if (takenBy(x)) return; // 같은 날짜는 한 번만 (노트가 둘이어도)
    const list = sortList(carryList(x));
    n.dailyCarry = n.dailyCarry || {};
    n.dailyCarry[x] = { at: Date.now(), ids: list.map(i => i.id), text: '' };
    const hold = holdCount(x);
    if (!list.length) {
      A().bodyEdited();
      toast(md(prevDay(x)) + '까지 못 끝낸 일이 없어요' + (hold ? ' (보류 ' + hold + '건 빼고)' : ''));
      renderBar();
      return;
    }
    const el = $('body'), text = blockText(x, list);
    el.setRangeText((afterBreak ? '' : '\n') + text + '\n', pos, pos, 'end');
    n.dailyCarry[x].text = text;
    list.forEach(i => { i.carryDays = (i.carryDays || []).concat(x).slice(-60); });
    db.putMany(list);
    A().bodyEdited();
    afterLoad(n, x, list, hold);
  }
  function afterLoad(n, x, list, hold) {
    const need = list.filter(needsPri).length;
    renderBar();
    if (need) setTimeout(() => openPri(n, x), 300);
    else toast(md(prevDay(x)) + '까지 못 끝낸 일 ' + list.length + '건을 불러왔어요' + (hold ? ' · 보류 ' + hold + '건은 뺐어요' : ''), '우선순위', () => openPri(n, x), 7000);
  }

  /* 쓰기 화면 위 안내 줄의 '지금 불러오기' (필기로 쓸 때 등) */
  function loadToday() {
    const n = A().ensureNote(), x = D.today();
    if (!isRunning(n) || takenBy(x)) { renderBar(); return; }
    const el = $('body');
    const cur = el.value.replace(/\s+$/, '');
    const lines = cur.split('\n');
    // 맨 끝 줄이 이미 오늘 날짜면 그 아래에, 아니면 날짜 줄부터 적는다
    const hasDate = dateOfLine(lines[lines.length - 1]) === x;
    el.value = hasDate ? cur + '\n' : (cur ? cur + '\n\n' : '') + dateLabel(x) + '\n';
    A().bodyEdited();
    run(x, el.value.length, true);
    el.scrollTop = el.scrollHeight;
  }

  /* ---------- 우선순위 정하기 창 ---------- */
  let pri = null; // { n, x, rows: [{ it, pick, done }] }
  function openPri(n, x) {
    n = n || A().curNote(); x = x || D.today();
    if (!n) return;
    const list = sortList(itemsOf(n, x).filter(i => !['done', 'cancel'].includes(i.status || 'todo')));
    if (!list.length) { toast('우선순위를 정할 일이 없어요'); return; }
    // 정해야 하는 일을 위로
    list.sort((a, b) => needsPri(b) - needsPri(a));
    pri = { n, x, rows: list.map(it => { const p = it.priority || 'normal'; return { it, pick: it.priSet || p !== 'normal' ? p : '', done: false }; }) };
    const need = list.filter(needsPri).length;
    $('pHead').textContent = md(x) + ' 이어서 할 일 · 우선순위';
    $('pText').textContent = need
      ? '전날까지 못 끝낸 일 ' + list.length + '건 가운데 ' + need + '건은 우선순위가 아직 없어요. 높음·보통·낮음을 골라 주세요. 이미 끝낸 일은 \'끝냄\'을 누르세요.'
      : '전날까지 못 끝낸 일 ' + list.length + '건이에요. 바꿀 것만 고르세요. 이미 끝낸 일은 \'끝냄\'을 누르세요.';
    renderPri();
    if (!$('dlgPri').open) { $('dlgPri').showModal(); $('pHead').focus(); } // 첫 버튼이 눌린 것처럼 보이지 않게
  }
  function renderPri() {
    const box = $('pList'); box.textContent = '';
    pri.rows.forEach(r => {
      const it = r.it, meta = [];
      if (it.date) { const late = D.diffDays(it.date, D.today()); meta.push(md(it.date) + '까지' + (late >= 2 ? ' · ' + late + '일 지남' : '')); }
      else meta.push('기한 없음');
      if (it.status === 'doing') meta.push('진행 중');
      const times = (it.carryDays || []).length;
      if (times >= 2) meta.push(times + '번째 넘어옴');
      if (it.type === 'notice') meta.push('전달' + (it.to ? ' → ' + it.to : ''));
      box.append(h('li', { class: 'prow' + (r.done ? ' done' : '') + (!r.pick && !r.done ? ' need' : '') },
        h('div', { class: 'pmain' },
          h('span', { class: 'pt' }, it.title),
          h('span', { class: 'pm' }, meta.join(' · '), !r.pick && !r.done ? h('b', null, ' · 정해 주세요') : null)),
        h('div', { class: 'pctl' },
          h('div', { class: 'seg pseg', role: 'group', 'aria-label': it.title + ' 우선순위' }, PRI.map(([k, label]) => h('button', {
            type: 'button', class: 'p-' + k, 'aria-pressed': String(r.pick === k), disabled: r.done,
            onclick: () => { r.pick = k; renderPri(); },
          }, label))),
          h('button', { type: 'button', class: 'pdone', 'aria-pressed': String(r.done), onclick: () => { r.done = !r.done; renderPri(); } }, '끝냄'))));
    });
    const left = pri.rows.filter(r => !r.pick && !r.done).length;
    $('pSave').textContent = left ? '저장 (' + left + '건은 보통으로)' : '저장';
  }
  function savePri() {
    if (!pri) return;
    const { n, x } = pri, now = Date.now(), changed = [];
    pri.rows.forEach(r => {
      const it = r.it;
      let ch = false;
      const p = r.pick || 'normal';
      if (!r.done && (p !== (it.priority || 'normal') || !it.priSet)) { it.priority = p; it.priSet = true; ch = true; }
      if (r.done && it.status !== 'done') { it.status = 'done'; it.locked = true; it.statusAt = now; it.doneAt = now; ch = true; }
      if (ch) { it.updatedAt = now; changed.push(it); }
    });
    if (changed.length) {
      db.putMany(changed);
      if (KK.board) KK.board.sync(changed);
      if (KK.gcal) KK.gcal.syncSoon();
    }
    const done = pri.rows.filter(r => r.done).length;
    pri = null;
    $('dlgPri').close();
    const same = rewrite(n, x);
    A().renderAll(); renderBar();
    toast('우선순위를 정했어요' + (done ? ' · 끝낸 일 ' + done + '건' : '') + (same ? '' : ' · 노트의 목록은 이미 고쳐 써서 그대로 두었어요'));
  }
  // 노트에 넣은 목록을 고치지 않았으면 새 우선순위 순서로 다시 적는다
  function rewrite(n, x) {
    const d = n.dailyCarry && n.dailyCarry[x];
    if (!d || !d.text) return true;
    const isCur = n.id === A().S.cur, el = $('body');
    const body = isCur ? el.value : n.body || '';
    const at = body.indexOf(d.text);
    if (at < 0) return false;
    const text = blockText(x, sortList(itemsOf(n, x)));
    const nb = body.slice(0, at) + text + body.slice(at + d.text.length);
    d.text = text;
    if (isCur) {
      const c = el.selectionStart;
      el.value = nb;
      const pos = c > at ? c + (nb.length - body.length) : c;
      el.setSelectionRange(pos, pos);
      A().bodyEdited();
    } else { n.body = nb; n.updatedAt = Date.now(); db.put(n); }
    return true;
  }
  $('pSave').addEventListener('click', savePri);
  $('pLater').addEventListener('click', () => { pri = null; $('dlgPri').close(); renderBar(); });

  /* ---------- 쓰기 화면 위 안내 줄 ---------- */
  function renderBar() {
    const el = $('daybar');
    if (!el) return;
    el.textContent = '';
    const n = A().curNote(), x = D.today();
    if (!isRunning(n) || n.dayBarOff === x) { el.hidden = true; return; }
    const close = h('button', { class: 'linkbtn', style: 'margin-left:0', 'aria-label': '안내 닫기', onclick: () => { n.dayBarOff = x; db.put(n); renderBar(); } }, '닫기');
    const mineToday = n.dailyCarry && n.dailyCarry[x];
    if (mineToday) {
      const need = itemsOf(n, x).filter(needsPri).length;
      if (!need) { el.hidden = true; return; }
      el.hidden = false;
      el.append(h('span', null, '오늘 불러온 일 중 우선순위를 안 정한 일 ' + need + '건'),
        h('button', { class: 'linkbtn', onclick: () => openPri(n, x) }, '우선순위 정하기'), close);
      return;
    }
    if (takenBy(x)) { el.hidden = true; return; }
    const cnt = carryList(x).length;
    if (!cnt) { el.hidden = true; return; }
    el.hidden = false;
    el.append(h('span', null, md(prevDay(x)) + '까지 못 끝낸 일 ' + cnt + '건 · 노트에 오늘 날짜만 한 줄로 적으면(예: ' + md(x) + ') 불러와요'),
      h('button', { class: 'linkbtn', onclick: loadToday }, '지금 불러오기'), close);
  }

  KK.daily = { onInput, refs, renderBar, openPri, dateOfLine, carryList, rank, PRI, PRI_KO };
})();
