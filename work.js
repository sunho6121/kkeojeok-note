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
      const N = {
        id: 'n-' + KK.uid(), kind: 'note', title: L.title, titleAuto: L.titleAuto !== false, body: '', summary: [], tags: [],
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

  function row(it, today) {
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
          it.type === 'notice' ? h('em', null, '전달') : null,
          it.source === 'minutes' ? h('em', null, '회의') : null,
          it.board && !it.board.gone ? h('em', { class: 'go' }, '보드') : null,
          it.board && !it.board.gone && ['확인 필요', '지연'].includes(it.board.label) && st !== 'done' ? h('em', null, '보드: ' + it.board.label) : null,
          st === 'doing' ? h('em', { class: 'go' }, '진행중') : null,
          st === 'hold' ? h('em', null, '보류') : null)),
      h('span', { class: 'wdate' + (vs === 'late' ? ' late' : '') }, st === 'done' ? (it.doneAt ? mdT(it.doneAt) : '') : when));
  }
  function section(title, list, today) {
    if (!list.length) return null;
    return h('div', { class: 'wsec' }, h('h4', null, title, h('span', null, list.length)), h('ul', null, list.map(i => row(i, today))));
  }

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
      const open = work.filter(i => OPEN.includes(i.status || 'todo')).sort(byDate);
      const wk = D.ymd(D.addDays(new Date(), 6));
      const late = open.filter(i => viewStatus(i, today) === 'late');
      const active = open.filter(i => i.status !== 'hold' && !late.includes(i));
      left.append(h('h3', null, '할 일', h('b', null, open.length)));
      const parts = [
        section('기한 지남', late, today),
        section('이번 주', active.filter(i => i.date && i.date <= wk), today),
        section('다음', active.filter(i => i.date && i.date > wk), today),
        section('기한 없음', active.filter(i => !i.date), today),
        section('보류', open.filter(i => i.status === 'hold'), today),
      ].filter(Boolean);
      if (parts.length) parts.forEach(p => left.append(p));
      else left.append(h('p', { class: 'wempty' }, '남은 할 일이 없어요. 노트에 할 일을 적고 정리하면 여기에 모여요.'));
    } else {
      const carried = work.filter(i => (i.carried || []).includes(view)).sort(byDate);
      left.append(h('h3', null, '다음 달로 넘긴 일', h('b', null, carried.length)));
      if (carried.length) left.append(h('div', { class: 'wsec' }, h('ul', null, carried.map(i => row(i, today)))));
      else left.append(h('p', { class: 'wempty' }, '넘긴 일이 없어요.'));
    }

    // 오른쪽: 한 일 (끝낸 업무 + 회의)
    const right = h('section', { class: 'wcol' });
    const done = work.filter(i => i.status === 'done' && inMonth(doneTime(i), view)).map(i => ({ t: doneTime(i), it: i }));
    const meet = recs.map(r => ({ t: r.startAt || r.createdAt, r }));
    const all = done.concat(meet).sort((a, b) => b.t - a.t);
    right.append(h('h3', null, '한 일', h('b', null, all.length)));
    if (all.length) {
      right.append(h('div', { class: 'wsec' }, h('ul', null, all.map(x => x.it ? row(x.it, today)
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

  KK.work = { init, rollover, render, renderCarry, processMonths, queueMonth, show, ym, curYM, mon, monthLabel, monthText };
})();
