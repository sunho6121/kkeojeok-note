'use strict';
/* 끄적노트 — 그리기: 노트 칩·정리 결과·노트 목록·일정·일정 상세 */
window.KK = window.KK || {};

(function () {
  const { $, h, svg, ICON, STATUS, OPEN, viewStatus, VIEW_LABEL } = KK.ui;
  const D = KK.date;
  const A = () => KK.app;

  function noteLabel(n) {
    if (!n) return '새 노트';
    if (n.title) return n.title;
    const first = (n.body || '').split('\n').map(s => s.trim()).find(Boolean);
    return first ? first.slice(0, 30) : (n.hasInk ? '필기 노트' : '빈 노트');
  }
  const notesSorted = () => [...A().S.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const liveItems = () => [...A().S.items.values()].filter(i => !i.deleted);
  const itemsOf = id => liveItems().filter(i => i.noteId === id);

  /* ---------- 쓰기 화면 위쪽 ---------- */
  function renderChips() {
    const S = A().S, box = $('noteChips');
    box.textContent = '';
    let list = notesSorted().slice(0, 4);
    if (S.cur && !list.some(n => n.id === S.cur)) list = [A().S.notes.get(S.cur), ...list.slice(0, 3)];
    list.sort((a, b) => a.createdAt - b.createdAt); // 쓰는 중에 칩 순서가 바뀌지 않게
    if (!S.cur) box.append(h('button', { class: 'nchip', 'aria-current': 'true' }, '새 노트'));
    list.forEach(n => box.append(h('button', {
      class: 'nchip', 'aria-current': String(n.id === S.cur), title: noteLabel(n),
      onclick: () => A().openNote(n.id),
    }, noteLabel(n))));
    box.append(h('button', { class: 'nchip add', onclick: () => A().newNote() }, '+ 새 노트'));
  }

  function renderResult() {
    const S = A().S, n = S.cur ? S.notes.get(S.cur) : null;
    const bar = $('rbar'), box = $('result');
    bar.textContent = ''; box.textContent = '';
    box.hidden = true;
    if (!n || (!n.organizedAt && !n.pending)) {
      bar.append(h('span', null, '마지막 줄에 // → 정리'));
      return;
    }
    if (n.pending) bar.append(h('span', { class: 'chip wait' }, '정리 대기'));
    if (!n.organizedAt) {
      bar.append(h('span', null, A().settings.apiKey ? '인터넷이 연결되면 자동으로 정리해요' : '설정에서 API 키를 넣으면 정리돼요'));
      return;
    }
    const its = itemsOf(n.id), today = D.today();
    const cnt = s => its.filter(i => viewStatus(i, today) === s).length;
    bar.append(h('span', { class: 'chip' }, '정리됨'), h('span', { class: 'when' }, D.stamp(n.organizedAt)));
    const parts = [];
    if (cnt('late')) parts.push('미완결 ' + cnt('late'));
    if (cnt('todo')) parts.push('예정 ' + cnt('todo'));
    if (cnt('doing')) parts.push('진행중 ' + cnt('doing'));
    if (cnt('done')) parts.push('완결 ' + cnt('done'));
    if (parts.length) bar.append(h('button', { class: 'more', onclick: () => A().setView('sched') }, parts.join(' · ')));
    if (n.updatedAt > n.organizedAt + 1500 && !n.pending) bar.append(h('span', { class: 'stale' }, '고친 내용은 다시 정리하면 반영돼요'));
    if ((n.summary && n.summary.length) || (n.tags && n.tags.length)) {
      bar.append(h('button', { class: 'more', 'aria-expanded': String(!!S.showSummary), onclick: () => { S.showSummary = !S.showSummary; renderResult(); } }, S.showSummary ? '요약 접기' : '요약 보기'));
      if (S.showSummary) {
        box.hidden = false;
        if (n.summary.length) box.append(h('ul', null, n.summary.map(s => h('li', null, s))));
        if (n.tags.length) box.append(h('div', null, n.tags.map(t => h('span', { class: 'chip plain', style: 'margin-right:6px' }, '#' + t))));
      }
    }
  }

  /* ---------- 노트 목록 ---------- */
  function renderNotes() {
    const S = A().S, ul = $('noteList');
    ul.textContent = '';
    const q = (S.q || '').trim().toLowerCase();
    const list = notesSorted().filter(n => !q || [n.title, n.body, (n.tags || []).join(' ')].join(' ').toLowerCase().includes(q));
    if (!list.length) {
      ul.append(h('li', { class: 'empty' }, q ? '찾는 노트가 없어요.' : '아직 노트가 없어요. 쓰기 탭에서 바로 적어 보세요.'));
      return;
    }
    const today = D.today();
    list.forEach(n => {
      const lines = (n.body || '').split('\n').map(s => s.trim()).filter(Boolean);
      const snippet = (n.summary && n.summary[0]) || lines.slice(n.title ? 0 : 1, 3).join(' · ');
      const its = itemsOf(n.id);
      const open = its.filter(i => ['todo', 'doing', 'late'].includes(viewStatus(i, today))).length;
      const chips = [h('span', { class: 'when' }, D.short(n.updatedAt))];
      if (n.pending) chips.push(h('span', { class: 'chip wait' }, '정리 대기'));
      else if (!n.organizedAt && (lines.length || n.hasInk)) chips.push(h('span', { class: 'chip new' }, '새 메모'));
      else if (n.organizedAt && n.updatedAt > n.organizedAt + 1500) chips.push(h('span', { class: 'chip plain' }, '수정됨'));
      if (open) chips.push(h('span', { class: 'chip' }, '할 것 ' + open));
      if (n.hasInk) chips.push(h('span', { class: 'chip plain' }, '필기'));
      (n.tags || []).slice(0, 2).forEach(t => chips.push(h('span', { class: 'chip plain' }, '#' + t)));
      ul.append(h('li', null, h('button', {
        class: 'ncard', 'aria-current': String(n.id === S.cur),
        onclick: () => { A().openNote(n.id); A().setView('write'); },
      }, h('div', { class: 't' }, noteLabel(n)), snippet ? h('div', { class: 's' }, snippet) : null, h('div', { class: 'm' }, chips))));
    });
  }

  /* ---------- 일정 ---------- */
  function sortItems(a, b) {
    return (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99') || a.createdAt - b.createdAt;
  }

  function gcalUrl(it) {
    if (!it.date) return null;
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
      dates = it.date.replace(/-/g, '') + '/' + D.ymd(D.addDays(D.parse(it.date), 1)).replace(/-/g, '');
    }
    const p = new URLSearchParams({ action: 'TEMPLATE', text: it.title, dates, ctz: 'Asia/Seoul' });
    if (it.place) p.set('location', it.place);
    if (it.detail) p.set('details', it.detail);
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }

  function itemRow(it, today) {
    const S = A().S, vs = viewStatus(it, today);
    const timeCell = h('div', { class: 'tm' });
    if (it.time) { timeCell.append(it.time); if (it.endTime) timeCell.append(h('small', null, '~' + it.endTime)); }
    else if (it.date && it.date !== today && S.day !== it.date) timeCell.append(h('small', null, D.dayLabel(it.date).replace(/^\d+월 /, '')));
    else timeCell.append(h('small', null, it.type === 'event' ? '하루' : '할 일'));
    const src = S.notes.get(it.noteId);
    const meta = h('div', { class: 'it-m' },
      it.priority === 'high' && OPEN.includes(it.status || 'todo') ? h('span', { class: 'pri' }, '중요') : null,
      vs === 'late' ? h('span', { class: 'pri' }, D.dayLabel(it.date) + ' 지남') : null,
      it.place ? h('span', null, it.place) : null,
      it.detail ? h('span', null, it.detail) : null,
      src ? h('span', null, '· ' + noteLabel(src)) : null);
    const st = it.status || 'todo';
    return h('li', { class: 'it ' + (it.type === 'event' ? 'ev' : 'tk') + ' s-' + st },
      h('button', {
        class: 'chk', 'aria-label': st === 'done' ? '완결 취소' : '완결로 표시',
        onclick: () => A().setItemStatus(it, st === 'done' ? 'todo' : 'done'),
      }, h('i', null, svg(ICON.check))),
      timeCell,
      h('button', { class: 'it-main', onclick: () => openItem(it) }, h('div', { class: 'it-t' }, it.title), meta),
      h('button', { class: 'st ' + vs + (it.locked ? ' lock' : ''), onclick: () => openItem(it), 'aria-label': '상태: ' + VIEW_LABEL[vs] + ', 바꾸기' }, VIEW_LABEL[vs]));
  }

  function group(title, list, today, cls, sub) {
    if (!list.length) return null;
    return h('section', { class: 'grp ' + (cls || '') },
      h('h3', null, title, sub ? h('span', { class: 'when' }, sub) : null, h('span', { class: 'when' }, list.length + '개')),
      h('ul', null, list.map(it => itemRow(it, today))));
  }

  function renderSched() {
    const S = A().S, today = D.today();
    const all = liveItems();
    const typed = all.filter(x => S.filter === 'all' || x.type === S.filter);
    const vsOf = x => viewStatus(x, today);
    const weekAgo = Date.now() - 7 * 86400000;

    // 요약 숫자
    const late = all.filter(x => vsOf(x) === 'late').length;
    const todayOpen = all.filter(x => x.date === today && ['todo', 'doing'].includes(vsOf(x))).length;
    const doing = all.filter(x => vsOf(x) === 'doing').length;
    const doneWeek = all.filter(x => x.status === 'done' && (x.doneAt || 0) >= weekAgo).length;
    const tiles = $('tiles'); tiles.textContent = '';
    [['warn', late, '미완결'], ['', todayOpen, '오늘 할 것'], ['go', doing, '진행중'], ['ok', doneWeek, '최근 7일 완결']]
      .forEach(([c, v, l]) => tiles.append(h('div', { class: 'tile ' + (v ? c : '') }, h('b', null, v), h('span', null, l))));
    $('tabCnt').textContent = String(late + todayOpen || '');

    // 7일 띠
    const wk = $('week'); wk.textContent = '';
    for (let i = 0; i < 7; i++) {
      const d = D.addDays(new Date(), i), key = D.ymd(d);
      const its = typed.filter(x => x.date === key && ['todo', 'doing'].includes(vsOf(x)));
      wk.append(h('button', {
        class: 'day' + (key === today ? ' is-today' : '') + (d.getDay() === 0 ? ' sun' : ''),
        'aria-pressed': String(S.day === key), 'aria-label': D.dayLabel(key) + ' 할 것 ' + its.length + '개',
        onclick: () => { S.day = S.day === key ? null : key; renderSched(); },
      }, h('span', { class: 'dw' }, i === 0 ? '오늘' : D.DOW[d.getDay()]), h('span', { class: 'dn' }, d.getDate()),
      h('span', { class: 'pips' }, its.slice(0, 4).map(x => h('span', { class: 'pip' + (x.type === 'task' ? ' t' : '') })))));
    }

    const box = $('slist'); box.textContent = '';
    const parts = [];
    const sorted = typed.slice().sort(sortItems);
    if (S.day) {
      parts.push(group(D.dayLabel(S.day), sorted.filter(x => x.date === S.day), today));
      if (!parts[0]) parts[0] = h('p', { class: 'empty' }, D.dayLabel(S.day) + '에는 일정이 없어요.');
    } else if (S.sview === 'done') {
      const done = typed.filter(x => x.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
      parts.push(group('완결', done.slice(0, 60), today));
      parts.push(group('지난 약속', sorted.filter(x => vsOf(x) === 'past').reverse().slice(0, 30), today));
    } else if (S.sview === 'other') {
      parts.push(group('보류', sorted.filter(x => x.status === 'hold'), today));
      parts.push(group('취소', sorted.filter(x => x.status === 'cancel'), today));
    } else {
      const open = sorted.filter(x => ['todo', 'doing', 'late'].includes(vsOf(x)));
      const diff = x => D.diffDays(today, x.date);
      parts.push(group('미완결', open.filter(x => vsOf(x) === 'late'), today, 'overdue'));
      parts.push(group('오늘', open.filter(x => x.date && diff(x) === 0), today, '', D.dayLabel(today)));
      parts.push(group('내일', open.filter(x => x.date && diff(x) === 1), today, '', D.dayLabel(D.ymd(D.addDays(new Date(), 1)))));
      parts.push(group('이번 7일', open.filter(x => x.date && diff(x) >= 2 && diff(x) <= 6), today));
      parts.push(group('그 뒤', open.filter(x => x.date && diff(x) > 6), today));
      parts.push(group('날짜 없는 할 일', open.filter(x => !x.date), today));
    }
    if (!parts.some(Boolean)) {
      parts.length = 0;
      parts.push(h('div', { class: 'empty' },
        h('p', null, S.sview === 'open' ? '남은 일정이 없어요.' : '해당하는 일정이 없어요.'),
        all.length ? null : h('p', null, '쓰기 탭의 노트에 "내일 10시 팀 회의", "금요일까지 보고서"처럼 적고 마지막 줄에 // 를 쓰면 여기에 정리돼요.')));
    }
    parts.filter(Boolean).forEach(p => box.append(p));
  }

  /* ---------- 일정 상세 (상태 바꾸기) ---------- */
  let dlgItem = null;
  function openItem(it) {
    dlgItem = it;
    const today = D.today();
    $('itTitle').textContent = it.title;
    const src = A().S.notes.get(it.noteId);
    $('itMeta').textContent = [
      it.type === 'event' ? '약속' : '할 일',
      it.date ? D.dayLabel(it.date) + (it.time ? ' ' + it.time + (it.endTime ? '~' + it.endTime : '') : '') : '날짜 없음',
      it.place, src ? '노트: ' + noteLabel(src) : '',
    ].filter(Boolean).join(' · ') + (viewStatus(it, today) === 'late' ? ' · 기한이 지났어요' : '');
    const grid = $('itStatus'); grid.textContent = '';
    Object.entries(STATUS).forEach(([k, label]) => grid.append(h('button', {
      type: 'button', class: 'st-' + k, 'aria-pressed': String((it.status || 'todo') === k),
      onclick: () => { A().setItemStatus(it, k); $('dlgItem').close(); },
    }, label)));
    const acts = $('itActions'); acts.textContent = '';
    const url = gcalUrl(it);
    if (url) acts.append(h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, svg(ICON.cal), '구글 캘린더에 추가'));
    if (src) acts.append(h('button', { type: 'button', class: 'btn', onclick: () => { $('dlgItem').close(); A().openNote(src.id); A().setView('write'); } }, svg(ICON.note), '노트로 가기'));
    acts.append(h('button', { type: 'button', class: 'btn danger', onclick: () => { $('dlgItem').close(); A().deleteItem(it); } }, svg(ICON.trash), '삭제'));
    $('dlgItem').showModal();
  }

  KK.views = { noteLabel, notesSorted, itemsOf, renderChips, renderResult, renderNotes, renderSched, openItem, gcalUrl };
})();
