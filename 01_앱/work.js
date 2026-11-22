'use strict';
/* 끄적노트 — 월별 노트 · 월간 업무 요약 · 업무 탭
   - 노트는 달마다 새로 시작한다. 달이 바뀌면 지난달 노트를 닫고, 안 끝난 일을 새 달 노트로 넘기고, 지난달 업무를 Claude가 요약한다.
   - 업무 탭: 할 일(앞으로 할 업무) / 한 일(이 달에 끝낸 업무·회의) / 월간 업무 요약 */
window.KK = window.KK || {};

(function () {
  const { $, h, svg, ICON, toast, viewStatus } = KK.ui;
  const D = KK.date, db = KK.db;
  const A = () => KK.app;
  const V = () => KK.views;

  const ym = t => { const d = new Date(t); return d.getFullYear() + '-' + D.pad(d.getMonth() + 1); };
  const curYM = () => ym(Date.now());
  const monthLabel = m => { const [y, mo] = m.split('-'); return y + '년 ' + (+mo) + '월'; };
  const mon = m => (+m.split('-')[1]) + '월';
  const addMonth = (m, k) => { const [y, mo] = m.split('-').map(Number); return ym(new Date(y, mo - 1 + k, 1)); };
  const range = m => { const [y, mo] = m.split('-').map(Number); return [new Date(y, mo - 1, 1).getTime(), new Date(y, mo, 1).getTime()]; };
  const inMonth = (t, m) => { const [a, b] = range(m); return t >= a && t < b; };
  const md = s => { const d = D.parse(s); return (d.getMonth() + 1) + '/' + d.getDate(); };
  const mdT = t => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate(); };

  const months = new Map(); // 'month-YYYY-MM' → 월간 요약 문서
  let view = null;          // 업무 탭에서 보는 달
  let genMonth = null;      // 요약을 만드는 중인 달

  /* ---------- 시작: 예전 노트에 달 붙이기 ---------- */
  async function init() {
    const S = A().S, fix = [];
    S.notes.forEach(n => {
      if (!n.month) { n.month = ym(n.createdAt || Date.now()); fix.push(n); }
      if (!n.series) { n.series = n.id; if (!fix.includes(n)) fix.push(n); }
    });
    if (fix.length) db.putMany(fix);
    months.clear();
    (await db.all()).filter(d => d.kind === 'month').forEach(d => months.set(d.id, d));
  }

  /* ---------- 달 넘기기 ---------- */
  const OPEN = ['todo', 'doing', 'hold'];
  function carryable(it, cur) {
    if (it.deleted) return false;
    const st = it.status || 'todo';
    if (it.type === 'event') return ['todo', 'doing'].includes(st) && (!it.date || it.date >= cur + '-01');
    if (it.type === 'memo') return st !== 'done';
    return OPEN.includes(st);
  }
  function rollover() {
    const S = A().S, cur = curYM(), moved = {}, ended = new Set();
    const latest = new Map();
    S.notes.forEach(n => {
      if (!n.month) return;
      const k = n.series || n.id, L = latest.get(k);
      if (!L || n.month > L.month || (n.month === L.month && n.createdAt > L.createdAt)) latest.set(k, n);
    });
    const now = Date.now(), save = [];
    latest.forEach(L => {
      if (L.imported || L.closed || L.month >= cur) return;
      const items = [...S.items.values()].filter(i => i.noteId === L.id && carryable(i, cur));
      if (!(L.body || '').trim() && !L.hasInk && !items.length) { L.month = cur; save.push(L); return; } // 빈 노트는 그대로 이번 달로
      // 새 달 노트 이름은 정해 둠: 두 기기(태블릿·노트북)가 따로 달을 넘겨도 같은 노트 하나로 맞춰짐 (kk-v28)
      const nid = 'n-' + String(L.series || L.id).replace(/^n-/, '') + '-' + cur;
      if (S.notes.has(nid)) return;
      const N = {
        id: nid, kind: 'note', title: L.title, titleAuto: L.titleAuto !== false, body: '', summary: [], tags: [],
        createdAt: now, updatedAt: now, organizedAt: 0, pending: false, hasInk: false,
        month: cur, series: L.series || L.id, prevMonth: L.month, prevNoteId: L.id, carried: items.length,
      };
      items.forEach(i => { i.noteId = N.id; i.carried = (i.carried || []).concat(L.month); i.updatedAt = now; });
      L.closed = true; L.closedAt = now; L.nextNoteId = N.id;
      S.notes.set(N.id, N);
      save.push(L, N, ...items);
      moved[L.id] = N.id;
      ended.add(L.month);
    });
    // 다른 기기와 맞춘 뒤: 이미 닫힌 지난달 노트에, 닫기 전에 만든 안 끝난 일이 남아 있으면 이번 달 노트로 (kk-v28)
    S.notes.forEach(L => {
      if (!L.closed || !L.nextNoteId || !L.closedAt) return;
      let N = S.notes.get(L.nextNoteId), guard = 0;
      while (N && N.closed && N.nextNoteId && S.notes.has(N.nextNoteId) && guard++ < 24) N = S.notes.get(N.nextNoteId);
      if (!N || N.closed || N.month !== cur) return;
      [...S.items.values()].forEach(i => {
        if (i.noteId !== L.id || !carryable(i, cur) || (i.carried || []).includes(L.month) || (i.createdAt || 0) > L.closedAt) return;
        i.noteId = N.id; i.carried = (i.carried || []).concat(L.month); i.updatedAt = now; save.push(i);
      });
    });
    if (save.length) db.putMany(save);
    ended.forEach(m => queueMonth(m, false, true));
    if (S.cur && moved[S.cur]) A().openNote(moved[S.cur]);
    if (Object.keys(moved).length) {
      const pm = [...ended].sort().pop();
      toast(mon(cur) + ' 노트를 새로 시작했어요. ' + mon(pm) + '의 안 끝난 일은 넘겨 두었어요', mon(pm) + ' 요약', () => show(pm), 9000);
    }
    return moved;
  }

  /* ---------- 월간 업무 요약 (Claude) ---------- */
  const TYPE_KO = { event: '약속', task: '할 일', notice: '전달', memo: '메모' };
  const ST_KO = { todo: '예정', doing: '진행중', hold: '보류', done: '완결', cancel: '취소', late: '기한 지남', past: '지난 약속' };
  async function monthText(m) {
    const S = A().S, out = [];
    const notes = [...S.notes.values()].filter(n => n.month === m && (n.body || '').trim()).sort((a, b) => a.createdAt - b.createdAt);
    if (notes.length) out.push('## 노트');
    notes.forEach(n => {
      let body = n.body.trim();
      if (body.length > 30000) body = '…(앞부분 줄임)\n' + body.slice(-30000);
      out.push('### ' + V().noteLabel(n) + '\n' + body);
    });
    const today = D.today();
    const items = [...S.items.values()].filter(i => !i.deleted && (
      (i.date && i.date.slice(0, 7) === m) || (i.doneAt && inMonth(i.doneAt, m)) || inMonth(i.createdAt || 0, m) || (i.carried || []).includes(m)));
    if (items.length) {
      out.push('## 일정·할 일 (종류 | 제목 | 날짜 | 지금 상태)');
      items.forEach(i => out.push([TYPE_KO[i.type] || '할 일', i.title + (i.to ? ' → ' + i.to : ''), i.date || '-',
        ST_KO[viewStatus(i, today)] + (i.doneAt ? ' (' + mdT(i.doneAt) + ' 끝냄)' : '')].join(' | ')));
    }
    if (!db.usingFallback) {
      const recs = (await db.all()).filter(d => d.kind === 'rec' && d.minutes && inMonth(d.startAt || d.createdAt, m));
      recs.forEach(r => {
        out.push('## 회의록: ' + (r.minutes.title || r.name) + ' (' + (r.minutes.when || '') + ')');
        (r.minutes.summary || []).forEach(s => out.push('- ' + s));
        (r.minutes.decisions || []).forEach(s => out.push('- 결정: ' + s));
      });
    }
    let text = out.join('\n');
    if (text.length > 90000) text = text.slice(-90000);
    return text;
  }
  function queueMonth(m, partial, quiet) {
    const id = 'month-' + m;
    const doc = months.get(id) || { id, kind: 'month', month: m };
    if (!partial && doc.status === 'done' && !doc.partial && quiet) return;
    doc.status = 'pending'; doc.partial = !!partial; doc.err = '';
    months.set(id, doc); db.put(doc);
    render();
    processMonths();
  }
  let busy = false;
  async function processMonths() {
    if (busy) return;
    busy = true;
    try {
      const list = [...months.values()].filter(d => d.status === 'pending').sort((a, b) => a.month.localeCompare(b.month));
      for (const doc of list) {
        const s = A().settings;
        if (!navigator.onLine || !s.apiKey) break;
        const text = await monthText(doc.month);
        if (!text.trim()) { doc.status = 'empty'; db.put(doc); render(); continue; }
        genMonth = doc.month; render();
        try {
          const sum = await KK.claude.monthly({ apiKey: s.apiKey, model: s.model, effort: s.effort, label: monthLabel(doc.month), text, partial: doc.partial });
          Object.assign(doc, { status: 'done', summary: sum, at: Date.now(), model: s.model, err: '' });
          if (!doc.partial && view !== doc.month) toast(mon(doc.month) + ' 업무 요약이 준비됐어요', '보기', () => show(doc.month), 8000);
        } catch (e) {
          genMonth = null;
          if (e.code === 'offline') break;
          doc.status = 'error'; doc.err = errText(e);
        }
        genMonth = null;
        db.put(doc); render(); renderCarry();
      }
    } finally { busy = false; genMonth = null; render(); }
  }
  function errText(e) {
    return ({ bad_key: 'API 키가 맞지 않아요', forbidden: 'API 키 권한·결제를 확인해 주세요', rate: '사용 한도에 닿았어요. 잠시 뒤 다시 해 주세요', server: 'Claude 서버가 바빠요. 잠시 뒤 다시 해 주세요', bad_model: '설정의 모델을 바꿔 주세요' })[e.code] || ('만들지 못했어요: ' + (e.message || '알 수 없는 오류'));
  }

  /* ---------- 업무 탭 ---------- */
  const isWork = i => !i.deleted && (i.type === 'task' || i.type === 'notice');
  const doneTime = i => i.doneAt || i.statusAt || i.updatedAt || 0;
  function show(m) { view = m || curYM(); A().setView('work'); }
  function updateBadge() {
    const today = D.today();
    const late = [...A().S.items.values()].filter(i => isWork(i) && viewStatus(i, today) === 'late').length;
    $('workTabCnt').textContent = late ? String(late) : '';
  }
  function firstMonth() {
    const S = A().S;
    let m = curYM();
    S.notes.forEach(n => { if (n.month && n.month < m) m = n.month; });
    S.items.forEach(i => { if (!i.deleted && i.createdAt) { const x = ym(i.createdAt); if (x < m) m = x; } });
    months.forEach(d => { if (d.month < m) m = d.month; });
    return m;
  }

  function row(it, today, showGroup) {
    const st = it.status || 'todo', vs = viewStatus(it, today);
    let when = '';
    if (vs === 'late') when = md(it.date) + ' 지남';
    else if (it.date === today) when = '오늘';
    else if (it.date) when = md(it.date) + '(' + D.DOW[D.parse(it.date).getDay()] + ')';
    return h('li', { class: 'wrow s-' + st + (vs === 'late' ? ' late' : '') },
      h('button', { class: 'chk', 'aria-label': st === 'done' ? '안 끝난 걸로 되돌리기' : '끝냄으로 표시', onclick: () => A().setItemStatus(it, st === 'done' ? 'todo' : 'done') }, h('i', null, svg(ICON.check))),
      h('button', { class: 'wmain', onclick: () => V().openItem(it) },
        h('span', { class: 'wt' }, it.title),
        h('span', { class: 'wtag' },
          it.priority === 'high' && st !== 'done' ? h('em', { class: 'hi' }, '높음') : null,
          it.priority === 'low' && st !== 'done' ? h('em', null, '낮음') : null,
          showGroup && gname(it.group) ? h('em', { class: 'grp' }, gname(it.group)) : null,
          it.type === 'notice' ? h('em', null, '전달') : null,
          it.source === 'minutes' ? h('em', null, '회의') : null,
          it.board && !it.board.gone ? h('em', { class: 'go' }, '보드') : null,
          it.board && !it.board.gone && ['확인 필요', '지연'].includes(it.board.label) && st !== 'done' ? h('em', null, '보드: ' + it.board.label) : null,
          st === 'doing' ? h('em', { class: 'go' }, '진행중') : null,
          st === 'hold' ? h('em', null, '보류') : null)),
      h('span', { class: 'wdate' + (vs === 'late' ? ' late' : '') }, st === 'done' ? (it.doneAt ? mdT(it.doneAt) : '') : when));
  }
  function section(title, list, today, showGroup) {
    if (!list.length) return null;
    return h('div', { class: 'wsec' }, h('h4', null, title, h('span', null, list.length)), h('ul', null, list.map(i => row(i, today, showGroup))));
  }

  /* ---------- 업무별 묶기 (kk-v27) ----------
     하나의 업무(사업·행사·회의·보고서 등)에서 나온 할 일·전달을 item.group(업무 이름)으로 묶어 보여 준다.
     - 정리할 때 Claude가 group을 붙임(claude.js). 전에 정리된 것은 '업무별로 묶기' 버튼으로 한 번에(제목·내용만 보냄)
     - group: undefined = 아직 안 묶음, '' = 묶을 업무 없음
     - 사람이 고치면(항목의 '업무 바꾸기', 묶음 이름 바꾸기·합치기·풀기) userFields.group → 다시 정리해도 Claude가 안 바꿈 */
  const gname = s => String(s || '').trim();
  const PEN = '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/>';
  const FOLDER = '<path d="M3 7.5V18a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2.5H4a1 1 0 0 0-1 1z"/>';
  function groupNames() {
    const cut = Date.now() - 60 * 86400000, last = new Map();
    A().S.items.forEach(i => {
      const g = gname(i.group);
      if (!g || i.deleted || i.status === 'cancel') return;
      const t = Math.max(i.updatedAt || 0, i.groupAt || 0, i.createdAt || 0);
      if (!OPEN.includes(i.status || 'todo') && t < cut) return;
      last.set(g, Math.max(last.get(g) || 0, t));
    });
    return [...last.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  }
  const workBy = () => (A().settings.workBy === 'date' ? 'date' : 'group');
  const folded = new Set(); // 접어 둔 묶음(앱을 연 동안만)

  // 할 일을 업무별로: 같은 업무가 2개 이상(이번 달에 끝낸 것 포함)이면 묶음, 아니면 '그 밖의 할 일'
  function groupParts(open, work, today, rk, byDate) {
    const cur = curYM(), members = new Map();
    work.forEach(i => {
      const g = gname(i.group);
      if (!g || i.status === 'cancel') return;
      if (!OPEN.includes(i.status || 'todo') && !(i.status === 'done' && inMonth(doneTime(i), cur))) return;
      if (!members.has(g)) members.set(g, []);
      members.get(g).push(i);
    });
    const blocks = [], rest = [], seen = new Set();
    open.forEach(i => {
      const g = gname(i.group);
      if (g && members.get(g).length >= 2) { seen.add(g); return; }
      rest.push(i);
    });
    seen.forEach(g => {
      const list = members.get(g);
      const op = list.filter(i => OPEN.includes(i.status || 'todo')).sort((a, b) => rk(a) - rk(b) || byDate(a, b));
      const dn = list.filter(i => i.status === 'done').sort((a, b) => doneTime(b) - doneTime(a));
      const late = op.some(i => viewStatus(i, today) === 'late');
      const due = op.filter(i => i.date && i.status !== 'hold').map(i => i.date).sort()[0] || '';
      blocks.push({ g, op, dn, late, due });
    });
    blocks.sort((a, b) => (b.late - a.late) || (a.due || '9999').localeCompare(b.due || '9999') || a.g.localeCompare(b.g));
    const out = blocks.map(b => {
      const d = h('details', { class: 'wgrp', open: !folded.has(b.g) },
        h('summary', null,
          h('span', { class: 'gname' }, b.g),
          h('span', { class: 'gprog' + (b.late ? ' late' : '') }, b.dn.length + '/' + (b.dn.length + b.op.length) + (b.late ? ' · 기한 지남' : b.due ? ' · ' + md(b.due) + '까지' : '')),
          h('button', { type: 'button', class: 'gedit', title: '업무 이름 바꾸기·합치기', 'aria-label': '「' + b.g + '」 업무 이름 바꾸기·합치기', onclick: e => { e.preventDefault(); e.stopPropagation(); openGroup({ name: b.g }); } }, svg(PEN))),
        h('ul', null, b.op.map(i => row(i, today)), b.dn.map(i => row(i, today))));
      d.addEventListener('toggle', () => { if (d.open) folded.delete(b.g); else folded.add(b.g); });
      return d;
    });
    const r = section(blocks.length ? '그 밖의 할 일' : '할 일', rest.sort((a, b) => rk(a) - rk(b) || byDate(a, b)), today, true);
    if (r) out.push(r);
    return out;
  }

  // 아직 안 묶은 할 일을 Claude에게 보내 업무별로 묶기
  let grouping = false;
  const notGrouped = () => [...A().S.items.values()].filter(i => isWork(i) && OPEN.includes(i.status || 'todo') && i.group === undefined);
  async function groupNow() {
    const st = A().settings;
    if (!st.apiKey) { toast('업무별로 묶으려면 설정에서 Claude API 키를 넣어 주세요.', '설정 열기', () => A().openSettings(), 7000); return; }
    if (!navigator.onLine) { toast('인터넷에 연결되면 묶을 수 있어요.'); return; }
    const todo = notGrouped().slice(0, 150);
    if (!todo.length || grouping) return;
    const known = new Map();
    [...A().S.items.values()].filter(i => isWork(i) && gname(i.group) && i.status !== 'cancel').forEach(i => {
      const g = gname(i.group);
      if (!known.has(g)) known.set(g, []);
      if (known.get(g).length < 4) known.get(g).push(i.title);
    });
    const refs = {};
    const items = todo.map((i, k) => { const ref = 'g' + (k + 1); refs[ref] = i; return { ref, type: i.type, title: i.title, date: i.date || '', to: i.to || '', detail: (i.detail || '').replace(/\s+/g, ' ').slice(0, 80), src: (i.src || '').slice(0, 60) }; });
    grouping = true; render();
    try {
      const out = await KK.claude.groupItems({ apiKey: st.apiKey, model: st.model, items, known: [...known.entries()].slice(0, 40) });
      const got = new Map(out.map(x => [x.ref, x.group])), now = Date.now(), save = [];
      Object.entries(refs).forEach(([ref, it]) => {
        if (it.group !== undefined || (it.userFields && it.userFields.group)) return; // 그사이 정해졌으면 그대로
        it.group = gname(got.get(ref)).slice(0, 30); it.groupAt = now;
        save.push(it);
      });
      if (save.length) db.putMany(save);
      const names = new Set(save.map(i => i.group).filter(Boolean));
      toast(save.length + '개를 살펴 ' + names.size + '개 업무로 묶었어요. 잘못 묶인 것은 눌러서 「업무 바꾸기」로 고칠 수 있어요', null, null, 9000);
    } catch (e) {
      const M = { bad_key: 'API 키가 맞지 않아요. 설정에서 키를 확인해 주세요.', offline: '인터넷에 연결되면 묶을 수 있어요.', rate: '요청이 많거나 사용 한도에 닿았어요. 잠시 뒤 다시 눌러 주세요.', server: 'Claude 서버가 바빠요. 잠시 뒤 다시 눌러 주세요.' };
      if (e.code !== 'cancelled') toast(M[e.code] || '업무별로 묶지 못했어요: ' + (e.message || '알 수 없는 오류'), null, null, 7000);
    } finally { grouping = false; render(); }
  }

  /* 업무 고르기 창: { item } 그 일의 업무 바꾸기 / { name } 묶음 이름 바꾸기·합치기·풀기 */
  let gCtx = null;
  function openGroup(ctx) {
    gCtx = ctx;
    const it = ctx.item, cur = it ? gname(it.group) : ctx.name;
    const cnt = it ? 1 : [...A().S.items.values()].filter(i => !i.deleted && gname(i.group) === cur).length;
    $('gHead').textContent = it ? '업무 바꾸기' : '업무 이름 바꾸기';
    $('gInfo').textContent = it ? '「' + it.title + '」 · 지금: ' + (cur || '묶인 업무 없음')
      : '「' + cur + '」에 묶인 일 ' + cnt + '개를 함께 바꿔요.';
    const names = groupNames().filter(n => n !== cur).slice(0, 24), list = $('gList');
    list.textContent = '';
    names.forEach(n => list.append(h('button', { type: 'button', onclick: () => applyGroup(n) }, n)));
    $('gListL').textContent = it ? '이 업무로 옮기기' : '다른 업무에 합치기';
    $('gListL').hidden = list.hidden = !names.length;
    $('gNameL').textContent = it ? '새 업무 이름' : '업무 이름';
    $('gName').value = it ? '' : cur;
    $('gName').placeholder = it ? '예: 하반기 대표협의체' : '';
    $('gNone').textContent = it ? '묶음에서 빼기' : '묶음 풀기';
    $('gNone').hidden = !cur;
    $('gMsg').textContent = '';
    $('dlgGroup').showModal();
  }
  function applyGroup(name) {
    const ctx = gCtx;
    if (!ctx) return;
    name = gname(name).slice(0, 30);
    const now = Date.now(), merge = !ctx.item && name && groupNames().includes(name);
    const list = ctx.item ? [ctx.item] : [...A().S.items.values()].filter(i => !i.deleted && gname(i.group) === ctx.name);
    const before = list.map(i => [i, i.group, i.groupAt, i.userFields ? Object.assign({}, i.userFields) : undefined]);
    list.forEach(i => { i.group = name; i.groupAt = now; i.userFields = Object.assign({}, i.userFields || {}, { group: now }); });
    db.putMany(list);
    gCtx = null; $('dlgGroup').close();
    if ($('dlgItem').open) $('dlgItem').close();
    render();
    const msg = ctx.item ? (name ? '「' + name + '」 업무로 옮겼어요' : '업무 묶음에서 뺐어요')
      : !name ? '「' + ctx.name + '」 묶음을 풀었어요' : merge ? '「' + name + '」 업무로 합쳤어요' : '업무 이름을 「' + name + '」(으)로 바꿨어요';
    toast(msg, '되돌리기', () => {
      before.forEach(([i, g, ga, uf]) => {
        if (g === undefined) delete i.group; else i.group = g;
        if (ga === undefined) delete i.groupAt; else i.groupAt = ga;
        if (uf === undefined) delete i.userFields; else i.userFields = uf;
      });
      db.putMany(list); render();
    }, 8000);
  }
  $('gSave').addEventListener('click', () => {
    if (!gCtx) return;
    const v = gname($('gName').value);
    if (!v) { $('gMsg').textContent = gCtx.item ? '업무 이름을 적거나 위에서 골라 주세요.' : '이름을 적어 주세요. 묶음을 없애려면 「묶음 풀기」를 누르세요.'; $('gName').focus(); return; }
    if (!gCtx.item && v === gCtx.name) { gCtx = null; $('dlgGroup').close(); return; }
    applyGroup(v);
  });
  $('gNone').addEventListener('click', () => applyGroup(''));
  $('gCancel').addEventListener('click', () => { gCtx = null; $('dlgGroup').close(); });
  // 일정 상세 창(업무 탭에서 할 일을 누르면 뜸)의 '업무 바꾸기' 버튼
  const groupBtn = it => h('button', { type: 'button', class: 'btn', onclick: () => openGroup({ item: it }) }, svg(FOLDER), gname(it.group) ? '업무: ' + gname(it.group) : '업무 정하기');


  let token = 0;
  async function render() {
    updateBadge();
    if (document.body.dataset.view !== 'work') return;
    const my = ++token;
    const S = A().S, today = D.today(), cur = curYM();
    if (!view || view > cur) view = cur;
    const isCur = view === cur, first = firstMonth();
    const recs = db.usingFallback ? [] : (await db.all()).filter(d => d.kind === 'rec' && d.minutes && inMonth(d.startAt || d.createdAt, view));
    if (my !== token) return;
    const box = $('workView'); box.textContent = '';

    // 머리줄: 달 넘기기
    box.append(h('div', { class: 'whead' },
      h('button', { class: 'btn ghost nav', 'aria-label': '이전 달', disabled: view <= first, onclick: () => { view = addMonth(view, -1); render(); } }, '‹'),
      h('h2', null, monthLabel(view)),
      h('button', { class: 'btn ghost nav', 'aria-label': '다음 달', disabled: isCur, onclick: () => { view = addMonth(view, 1); render(); } }, '›'),
      isCur ? null : h('button', { class: 'linkbtn', onclick: () => { view = cur; render(); } }, '이번 달로'),
      isCur && KK.board ? h('button', { class: 'btn', style: 'margin-left:auto', onclick: () => KK.board.openUpload() },
        '업무보드에 올리기' + (KK.board.candidates().length ? ' · ' + KK.board.candidates().length : '')) : null,
      isCur && KK.board && KK.board.ready() ? boardSyncBtn() : null));

    const work = [...S.items.values()].filter(isWork);
    const byDate = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt;

    // 왼쪽: 할 일 (이번 달) / 넘긴 일 (지난 달)
    const left = h('section', { class: 'wcol' });
    if (isCur) {
      const rk = i => (KK.daily ? KK.daily.rank(i) : 1);
      const open = work.filter(i => OPEN.includes(i.status || 'todo')).sort((a, b) => rk(a) - rk(b) || byDate(a, b)); // 같은 묶음 안에서는 우선순위 높은 것부터
      const wk = D.ymd(D.addDays(new Date(), 6));
      const late = open.filter(i => viewStatus(i, today) === 'late');
      const active = open.filter(i => i.status !== 'hold' && !late.includes(i));
      const by = workBy(), ng = notGrouped().length;
      const pick = v => { A().settings.workBy = v; A().saveSettings(); render(); };
      left.append(h('div', { class: 'wtools' },
        h('h3', null, '할 일', h('b', null, open.length)),
        h('div', { class: 'seg', role: 'group', 'aria-label': '할 일 보기' },
          h('button', { type: 'button', 'aria-pressed': String(by === 'group'), onclick: () => pick('group') }, '업무별'),
          h('button', { type: 'button', 'aria-pressed': String(by === 'date'), onclick: () => pick('date') }, '기한별')),
        by === 'group' && (ng || grouping) ? h('button', { type: 'button', class: 'btn', disabled: grouping, title: '아직 업무가 정해지지 않은 할 일의 제목·내용을 Claude에게 보내 업무별로 묶어요', onclick: groupNow },
          grouping ? '묶는 중…' : '업무별로 묶기 · ' + ng) : null));
      const parts = (by === 'group' ? groupParts(open, work, today, rk, byDate) : [
        section('기한 지남', late, today, true),
        section('이번 주', active.filter(i => i.date && i.date <= wk), today, true),
        section('다음', active.filter(i => i.date && i.date > wk), today, true),
        section('기한 없음', active.filter(i => !i.date), today, true),
        section('보류', open.filter(i => i.status === 'hold'), today, true),
      ]).filter(Boolean);
      if (parts.length) parts.forEach(p => left.append(p));
      else left.append(h('p', { class: 'wempty' }, '남은 할 일이 없어요. 노트에 할 일을 적고 정리하면 여기에 모여요.'));
    } else {
      const carried = work.filter(i => (i.carried || []).includes(view)).sort(byDate);
      left.append(h('h3', null, '다음 달로 넘긴 일', h('b', null, carried.length)));
      if (carried.length) left.append(h('div', { class: 'wsec' }, h('ul', null, carried.map(i => row(i, today, true)))));
      else left.append(h('p', { class: 'wempty' }, '넘긴 일이 없어요.'));
    }

    // 오른쪽: 한 일 (끝낸 업무 + 회의)
    const right = h('section', { class: 'wcol' });
    const done = work.filter(i => i.status === 'done' && inMonth(doneTime(i), view)).map(i => ({ t: doneTime(i), it: i }));
    const meet = recs.map(r => ({ t: r.startAt || r.createdAt, r }));
    const all = done.concat(meet).sort((a, b) => b.t - a.t);
    right.append(h('h3', null, '한 일', h('b', null, all.length)));
    if (all.length) {
      right.append(h('div', { class: 'wsec' }, h('ul', null, all.map(x => x.it ? row(x.it, today, true)
        : h('li', { class: 'wrow meet' },
          h('span', { class: 'chk', 'aria-hidden': 'true' }, svg(ICON.note)),
          h('button', { class: 'wmain', onclick: () => KK.minutes.open(x.r) }, h('span', { class: 'wt' }, x.r.minutes.title || x.r.name), h('span', { class: 'wtag' }, h('em', null, '회의록'))),
          h('span', { class: 'wdate' }, mdT(x.t)))))));
    } else right.append(h('p', { class: 'wempty' }, isCur ? '이번 달에 끝낸 일이 아직 없어요. 할 일의 네모를 누르면 끝낸 일로 옮겨져요.' : '이 달에 끝낸 일 기록이 없어요.'));

    box.append(h('div', { class: 'wcols' }, left, right));
    box.append(summaryCard(view, isCur));
  }

  // 보드와 맞춘 시각 · 누르면 지금 받아 오기
  function boardSyncBtn() {
    const st = KK.board.status();
    const label = st.state === 'ok' && st.at ? '보드 ' + D.pad(new Date(st.at).getHours()) + ':' + D.pad(new Date(st.at).getMinutes()) + ' 맞춤'
      : st.state === 'old' ? '보드에서 받기 준비 중' : '보드에서 받기';
    return h('button', { class: 'linkbtn', style: 'margin-left:4px', title: '업무보드의 바뀐 상태와 내 담당 업무를 지금 받아 와요', onclick: () => KK.board.pull(true) }, '↻ ' + label);
  }

  function summaryCard(m, isCur) {
    const doc = months.get('month-' + m), s = A().settings;
    const card = h('section', { class: 'wsum' });
    const made = doc && doc.status === 'done' && doc.summary;
    card.append(h('div', { class: 'wsum-h' },
      h('h3', null, mon(m) + ' 업무 요약', made && doc.partial ? h('span', { class: 'when' }, mdT(doc.at) + '까지') : made ? h('span', { class: 'when' }, mdT(doc.at) + ' 만듦') : null),
      genMonth === m ? null : h('button', { class: 'btn', onclick: () => queueMonth(m, isCur) }, made ? '다시 만들기' : isCur ? '지금까지 요약 만들기' : '요약 만들기')));
    if (genMonth === m) card.append(h('p', { class: 'mmsg' }, h('span', { class: 'spin' }), 'Claude가 ' + mon(m) + ' 기록을 요약하는 중이에요…'));
    else if (doc && doc.status === 'pending') card.append(h('p', { class: 'mmsg' }, !s.apiKey ? '설정에서 API 키를 넣으면 요약을 만들어요.' : !navigator.onLine ? '인터넷이 연결되면 요약을 만들어요.' : '곧 요약을 만들어요.'));
    else if (doc && doc.status === 'error') card.append(h('p', { class: 'mmsg err' }, doc.err || '요약을 만들지 못했어요.'));
    else if (doc && doc.status === 'empty') card.append(h('p', { class: 'mmsg' }, '이 달에는 요약할 기록이 없어요.'));
    if (made) {
      const S = doc.summary;
      if (S.headline) card.append(h('p', { class: 'wline' }, S.headline));
      if (S.areas.length) card.append(h('div', { class: 'wareas' }, S.areas.map(a => h('div', { class: 'warea' }, h('b', null, a.area), h('ul', null, a.points.map(p => h('li', null, p)))))));
      const lists = [['끝낸 일', S.done], ['넘어가는 일', S.carry], ['기억할 것', S.notes]].filter(x => x[1].length);
      if (lists.length) card.append(h('div', { class: 'wlists' }, lists.map(([t, l]) => h('div', null, h('b', null, t), h('ul', null, l.map(x => h('li', null, x)))))));
    } else if (!doc || !doc.status) {
      card.append(h('p', { class: 'mmsg' }, isCur ? '달이 바뀌면 이 달 업무를 자동으로 요약해요. 지금까지 내용을 미리 보려면 위 버튼을 누르세요.' : '이 달 요약이 아직 없어요.'));
    }
    return card;
  }

  /* ---------- 쓰기 화면: 새 달 노트 안내 · 지난달 노트 안내 ---------- */
  function renderCarry() {
    const S = A().S, el = $('carry');
    const n = S.cur ? S.notes.get(S.cur) : null;
    el.textContent = '';
    if (n && n.closed) {
      const next = n.nextNoteId && S.notes.get(n.nextNoteId);
      el.hidden = false; el.className = 'carry old';
      el.append(h('span', null, mon(n.month) + ' 노트예요 (지난 달). 고쳐 쓸 수는 있지만 새 내용은 이번 달 노트에 적어 주세요.'),
        next ? h('button', { class: 'linkbtn', onclick: () => A().openNote(next.id) }, mon(next.month) + ' 노트로 가기') : null);
      return;
    }
    if (!n || !n.prevMonth || n.carryHidden) { el.hidden = true; return; }
    const doc = months.get('month-' + n.prevMonth);
    el.hidden = false; el.className = 'carry';
    el.append(h('span', null, mon(n.month) + ' 노트 · ' + mon(n.prevMonth) + '에서 넘어온 일 ' + (n.carried || 0) + '건' + (doc && doc.status === 'done' && doc.summary.headline ? ' · ' + doc.summary.headline : '')),
      h('button', { class: 'linkbtn', onclick: () => show(n.prevMonth) }, mon(n.prevMonth) + ' 요약 보기'),
      h('button', { class: 'linkbtn', style: 'margin-left:0', 'aria-label': '안내 닫기', onclick: () => { n.carryHidden = true; db.put(n); renderCarry(); } }, '닫기'));
  }

  KK.work = { init, rollover, render, renderCarry, processMonths, queueMonth, show, ym, curYM, mon, monthLabel, monthText, groupNames, groupBtn, openGroup };
})();
