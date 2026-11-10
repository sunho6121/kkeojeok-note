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

  /* 끄적노트 일정 + 구글 캘린더 일정을 한 줄씩 묶고, 같은 일정은 하나로 합친다 */
  function unifiedRows(today) {
    const rows = liveItems().map(it => ({
      kind: 'kk', it, date: it.date, time: it.time, endTime: it.endTime, title: it.title, type: it.type,
      place: it.place, detail: it.detail, vs: viewStatus(it, today), srcs: [], dups: 0, link: '', createdAt: it.createdAt,
    }));
    const G = KK.gcal;
    if (!G || !G.cfg.connected) return rows;
    const byKk = new Map(rows.map(r => [r.it.id, r]));
    const gRows = [];
    G.events.forEach(e => {
      let host = (e.kk && byKk.get(e.kk)) || rows.find(r => r.it.gLinked === e.calId + '|' + e.id);
      const own = !!host && e.kk === (host.it && host.it.id);
      if (!host) host = rows.find(r => r.date && G.sameEvent(r, e)) || gRows.find(r => G.sameEvent(r, e));
      if (host) {
        if (!host.srcs.includes(e.calName)) host.srcs.push(e.calName);
        if (!own) host.dups++;
        if (!host.link) host.link = e.link;
        if (!host.place && e.place) host.place = e.place;
        return;
      }
      gRows.push({
        kind: 'g', ev: e, date: e.date, time: e.time, endTime: e.endTime, title: e.title, type: 'event',
        place: e.place, detail: e.detail, vs: e.date < today ? 'past' : 'cal', srcs: [e.calName], dups: 0, link: e.link, createdAt: 0,
      });
    });
    return rows.concat(gRows);
  }

  function itemRow(r, today) {
    const S = A().S;
    const timeCell = h('div', { class: 'tm' });
    if (r.time) { timeCell.append(r.time); if (r.endTime) timeCell.append(h('small', null, '~' + r.endTime)); }
    else if (r.date && r.date !== today && S.day !== r.date) timeCell.append(h('small', null, D.dayLabel(r.date).replace(/^\d+월 /, '')));
    else timeCell.append(h('small', null, r.type === 'event' ? '하루' : '할 일'));
    const it = r.it;
    const src = it ? S.notes.get(it.noteId) : null;
    const where = [src ? noteLabel(src) : null, ...r.srcs].filter(Boolean);
    const meta = h('div', { class: 'it-m' },
      it && it.priority === 'high' && OPEN.includes(it.status || 'todo') ? h('span', { class: 'pri' }, '중요') : null,
      r.vs === 'late' ? h('span', { class: 'pri' }, D.dayLabel(r.date) + ' 지남') : null,
      r.place ? h('span', null, r.place) : null,
      it && r.detail ? h('span', null, r.detail) : null,
      where.length ? h('span', null, '· ' + where.join(' · ')) : null,
      r.dups ? h('span', { class: 'dup' }, '같은 일정 ' + (r.dups + 1) + '곳 합침') : null);
    if (r.kind === 'g') {
      return h('li', { class: 'it ev gcal' + (r.vs === 'past' ? ' s-done' : '') },
        h('div', { class: 'chk', 'aria-hidden': 'true' }, svg(ICON.cal)),
        timeCell,
        h('button', { class: 'it-main', onclick: () => openRow(r) }, h('div', { class: 'it-t' }, r.title), meta),
        h('button', { class: 'st cal', onclick: () => openRow(r) }, r.vs === 'past' ? '지난 일정' : '캘린더'));
    }
    const st = it.status || 'todo';
    return h('li', { class: 'it ' + (it.type === 'event' ? 'ev' : 'tk') + ' s-' + st },
      h('button', {
        class: 'chk', 'aria-label': st === 'done' ? '완결 취소' : '완결로 표시',
        onclick: () => A().setItemStatus(it, st === 'done' ? 'todo' : 'done'),
      }, h('i', null, svg(ICON.check))),
      timeCell,
      h('button', { class: 'it-main', onclick: () => openRow(r) }, h('div', { class: 'it-t' }, it.title), meta),
      h('button', { class: 'st ' + r.vs + (it.locked ? ' lock' : ''), onclick: () => openRow(r), 'aria-label': '상태: ' + VIEW_LABEL[r.vs] + ', 바꾸기' }, VIEW_LABEL[r.vs]));
  }

  function group(title, list, today, cls, sub) {
    if (!list.length) return null;
    return h('section', { class: 'grp ' + (cls || '') },
      h('h3', null, title, sub ? h('span', { class: 'when' }, sub) : null, h('span', { class: 'when' }, list.length + '개')),
      h('ul', null, list.map(r => itemRow(r, today))));
  }

  function renderGbar() {
    const bar = $('gbar'), G = KK.gcal;
    bar.textContent = '';
    if (!G) { bar.hidden = true; return; }
    bar.hidden = false;
    if (!G.cfg.connected) {
      bar.append(h('span', null, '구글 캘린더를 연결하면 그룹웨어·구글 일정도 여기에 함께 보여요.'),
        h('button', { class: 'linkbtn', onclick: () => document.getElementById('btnSettings').click() }, '연결하기'));
      return;
    }
    if (G.syncing) { bar.append(h('span', null, '구글 캘린더와 맞추는 중…')); return; }
    if (!G.hasToken()) {
      bar.append(h('span', { class: 'warn' }, '구글 연결을 새로 고쳐야 해요 (1시간마다 필요할 수 있어요).'),
        h('button', { class: 'linkbtn', onclick: () => G.connect() }, '다시 연결'));
      return;
    }
    bar.append(h('span', null, '구글 캘린더 ' + G.events.length + '개 · ' + (G.cfg.lastSync ? D.stamp(G.cfg.lastSync) + ' 맞춤' : '아직 안 맞춤')),
      h('button', { class: 'linkbtn', onclick: () => G.sync(true) }, '지금 동기화'));
  }

  function renderSched() {
    const S = A().S, today = D.today();
    const all = unifiedRows(today);
    const typed = all.filter(r => S.filter === 'all' || r.type === S.filter);
    const weekAgo = Date.now() - 7 * 86400000;
    renderGbar();

    // 요약 숫자 (끄적노트 일정 기준 + 오늘 캘린더 일정)
    const late = all.filter(r => r.vs === 'late').length;
    const todayOpen = all.filter(r => r.date === today && ['todo', 'doing', 'cal'].includes(r.vs)).length;
    const doing = all.filter(r => r.vs === 'doing').length;
    const doneWeek = all.filter(r => r.it && r.it.status === 'done' && (r.it.doneAt || 0) >= weekAgo).length;
    const tiles = $('tiles'); tiles.textContent = '';
    [['warn', late, '미완결'], ['', todayOpen, '오늘 일정'], ['go', doing, '진행중'], ['ok', doneWeek, '최근 7일 완결']]
      .forEach(([c, v, l]) => tiles.append(h('div', { class: 'tile ' + (v ? c : '') }, h('b', null, v), h('span', null, l))));
    $('tabCnt').textContent = String(late + todayOpen || '');

    // 7일 띠
    const wk = $('week'); wk.textContent = '';
    for (let i = 0; i < 7; i++) {
      const d = D.addDays(new Date(), i), key = D.ymd(d);
      const its = typed.filter(r => r.date === key && ['todo', 'doing', 'cal'].includes(r.vs));
      wk.append(h('button', {
        class: 'day' + (key === today ? ' is-today' : '') + (d.getDay() === 0 ? ' sun' : ''),
        'aria-pressed': String(S.day === key), 'aria-label': D.dayLabel(key) + ' 일정 ' + its.length + '개',
        onclick: () => { S.day = S.day === key ? null : key; renderSched(); },
      }, h('span', { class: 'dw' }, i === 0 ? '오늘' : D.DOW[d.getDay()]), h('span', { class: 'dn' }, d.getDate()),
      h('span', { class: 'pips' }, its.slice(0, 4).map(r => h('span', { class: 'pip' + (r.type === 'task' ? ' t' : '') + (r.kind === 'g' ? ' g' : '') })))));
    }

    const box = $('slist'); box.textContent = '';
    const parts = [];
    const sorted = typed.slice().sort(sortItems);
    if (S.day) {
      parts.push(group(D.dayLabel(S.day), sorted.filter(r => r.date === S.day), today));
      if (!parts[0]) parts[0] = h('p', { class: 'empty' }, D.dayLabel(S.day) + '에는 일정이 없어요.');
    } else if (S.sview === 'done') {
      const done = typed.filter(r => r.it && r.it.status === 'done').sort((a, b) => (b.it.doneAt || 0) - (a.it.doneAt || 0));
      parts.push(group('완결', done.slice(0, 60), today));
      parts.push(group('지난 약속·일정', sorted.filter(r => r.vs === 'past').reverse().slice(0, 40), today));
    } else if (S.sview === 'other') {
      parts.push(group('보류', sorted.filter(r => r.it && r.it.status === 'hold'), today));
      parts.push(group('취소', sorted.filter(r => r.it && r.it.status === 'cancel'), today));
    } else {
      const open = sorted.filter(r => ['todo', 'doing', 'late', 'cal'].includes(r.vs));
      const diff = r => D.diffDays(today, r.date);
      parts.push(group('미완결', open.filter(r => r.vs === 'late'), today, 'overdue'));
      parts.push(group('오늘', open.filter(r => r.date && r.vs !== 'late' && diff(r) === 0), today, '', D.dayLabel(today)));
      parts.push(group('내일', open.filter(r => r.date && diff(r) === 1), today, '', D.dayLabel(D.ymd(D.addDays(new Date(), 1)))));
      parts.push(group('이번 7일', open.filter(r => r.date && diff(r) >= 2 && diff(r) <= 6), today));
      parts.push(group('그 뒤', open.filter(r => r.date && diff(r) > 6), today));
      parts.push(group('날짜 없는 할 일', open.filter(r => !r.date), today));
    }
    if (!parts.some(Boolean)) {
      parts.length = 0;
      parts.push(h('div', { class: 'empty' },
        h('p', null, S.sview === 'open' ? '남은 일정이 없어요.' : '해당하는 일정이 없어요.'),
        all.length ? null : h('p', null, '쓰기 탭의 노트에 "내일 10시 팀 회의", "금요일까지 보고서"처럼 적고 마지막 줄에 // 를 쓰면 여기에 정리돼요.')));
    }
    parts.filter(Boolean).forEach(p => box.append(p));
  }

  /* ---------- 일정 상세 (상태 바꾸기 · 캘린더 일정 보기) ---------- */
  function openRow(r) {
    const today = D.today();
    const it = r.it;
    $('itTitle').textContent = r.title;
    const src = it ? A().S.notes.get(it.noteId) : null;
    $('itMeta').textContent = [
      r.kind === 'g' ? '캘린더 일정 (' + r.srcs.join(', ') + ')' : (it.type === 'event' ? '약속' : '할 일'),
      r.date ? D.dayLabel(r.date) + (r.time ? ' ' + r.time + (r.endTime ? '~' + r.endTime : '') : '') : '날짜 없음',
      r.place, src ? '노트: ' + noteLabel(src) : '',
      r.srcs.length && r.kind === 'kk' ? '캘린더: ' + r.srcs.join(', ') : '',
    ].filter(Boolean).join(' · ') + (r.vs === 'late' ? ' · 기한이 지났어요' : '') + (r.dups ? ' · 같은 일정 ' + (r.dups + 1) + '곳을 하나로 보여 줘요' : '');
    const grid = $('itStatus'); grid.textContent = '';
    $('itStatusBox').hidden = r.kind === 'g';
    if (it) Object.entries(STATUS).forEach(([k, label]) => grid.append(h('button', {
      type: 'button', class: 'st-' + k, 'aria-pressed': String((it.status || 'todo') === k),
      onclick: () => { A().setItemStatus(it, k); $('dlgItem').close(); },
    }, label)));
    const acts = $('itActions'); acts.textContent = '';
    if (r.link) acts.append(h('a', { class: 'btn', href: r.link, target: '_blank', rel: 'noopener' }, svg(ICON.cal), '캘린더에서 보기'));
    else if (it) { const url = gcalUrl(it); if (url) acts.append(h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, svg(ICON.cal), '구글 캘린더에 추가')); }
    if (r.kind === 'g') acts.append(h('button', { type: 'button', class: 'btn', onclick: () => { $('dlgItem').close(); A().adoptEvent(r.ev); } }, svg(ICON.plus), '끄적노트에서 상태 관리'));
    if (src) acts.append(h('button', { type: 'button', class: 'btn', onclick: () => { $('dlgItem').close(); A().openNote(src.id); A().setView('write'); } }, svg(ICON.note), '노트로 가기'));
    if (it) acts.append(h('button', { type: 'button', class: 'btn danger', onclick: () => { $('dlgItem').close(); A().deleteItem(it); } }, svg(ICON.trash), '삭제'));
    $('dlgItem').showModal();
  }
  const openItem = it => openRow({ kind: 'kk', it, date: it.date, time: it.time, endTime: it.endTime, title: it.title, type: it.type, place: it.place, vs: viewStatus(it, D.today()), srcs: [], dups: 0, link: '' });

  /* ---------- 설정: 구글 캘린더 ---------- */
  function renderGcalSettings() {
    const G = KK.gcal, box = $('gcalBox');
    if (!G || !box) return;
    box.textContent = '';
    if (document.activeElement !== $('gClientId')) $('gClientId').value = G.cfg.clientId;
    if (!G.cfg.connected) {
      box.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => G.connect(true) }, '구글 계정 연결')));
      return;
    }
    box.append(h('p', null, (G.hasToken() ? '연결됨' : '연결됨 · 다시 연결 필요') + (G.cfg.lastSync ? ' · 마지막 동기화 ' + D.stamp(G.cfg.lastSync) : '')));
    box.append(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => (G.hasToken() ? G.sync(true) : G.connect()) }, G.hasToken() ? '지금 동기화' : '다시 연결'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => G.disconnect() }, '연결 해제')));
    if (G.cfg.cals.length) {
      box.append(h('h3', { style: 'margin-top:6px' }, '일정 탭에 보여줄 캘린더'));
      G.cfg.cals.forEach(c => {
        const id = 'gc-' + btoa(unescape(encodeURIComponent(c.id))).replace(/[^A-Za-z0-9]/g, '');
        box.append(h('label', { class: 'chkrow', for: id },
          h('input', { type: 'checkbox', id, checked: G.cfg.showCals[c.id] !== false, onchange: e => { G.cfg.showCals[c.id] = e.target.checked; G.saveCfg(); G.fetchEvents(true).then(renderSched).catch(() => {}); } }),
          c.primary ? c.name + ' (기본)' : c.name));
      });
      const writable = G.cfg.cals.filter(c => c.role === 'owner' || c.role === 'writer');
      const sel = h('select', { id: 'gWriteCal', onchange: e => { G.cfg.writeCal = e.target.value; G.saveCfg(); } },
        writable.map(c => h('option', { value: c.primary ? 'primary' : c.id, selected: (c.primary ? 'primary' : c.id) === G.cfg.writeCal }, c.name + (c.primary ? ' (기본)' : ''))));
      box.append(h('label', null, '끄적노트 일정을 넣을 캘린더', sel));
    }
    box.append(h('label', { class: 'chkrow', for: 'gAuto' },
      h('input', { type: 'checkbox', id: 'gAuto', checked: G.cfg.autoPush, onchange: e => { G.cfg.autoPush = e.target.checked; G.saveCfg(); } }),
      '정리한 일정을 구글 캘린더에 자동으로 넣기 (같은 일정이 이미 있으면 넣지 않음)'));
  }

  KK.views = { noteLabel, notesSorted, itemsOf, renderChips, renderResult, renderNotes, renderSched, openItem, gcalUrl, renderGcalSettings, unifiedRows };
})();
