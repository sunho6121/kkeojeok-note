'use strict';
/* 끄적노트 — 공공보건의료사업팀 업무보드 연결
   끄적노트의 할 일 → 보드 '업무 목록' (내가 골라서 올림). 올린 업무는 끄적노트에서 상태·기한이 바뀌면 보드에도 맞춘다.
   보드 쪽 /api/ext/* (Bearer 연결 키, CORS) 가 필요하다 — 요청서: 업무보드 끄적노트 연결 요청 */
window.KK = window.KK || {};

(function () {
  const { $, h, toast } = KK.ui;
  const D = KK.date, db = KK.db;
  const A = () => KK.app;

  const DEFAULT_URL = 'https://uuh-board.uuh-phc.workers.dev';
  const CATEGORIES = ['회의·행사', '보고·문서', '교육', '예산·행정', '환자·기관 연계', '조사·분석'];
  const ST = { todo: '예정', doing: '진행 중', hold: '대기', done: '완료', cancel: '취소' };

  const cfg = () => {
    const s = A().settings;
    return { url: String(s.boardUrl || DEFAULT_URL).trim().replace(/\/+$/, ''), key: s.boardKey || '', owner: s.boardOwner || '', auto: s.boardAuto !== false };
  };
  const ready = () => !!cfg().key;

  /* ---------- 보드 API ---------- */
  function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
  async function call(method, path, body) {
    const c = cfg();
    if (!c.key) throw fail('no_key');
    let res;
    try {
      res = await fetch(c.url + path, {
        method, mode: 'cors', credentials: 'omit',
        headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw fail(navigator.onLine ? 'blocked' : 'offline'); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 무시 */ }
    if (res.status === 401 || res.status === 403) throw fail('bad_key');
    if (res.status === 404 && /^\/api\/ext\/(ping|tasks)$/.test(path)) throw fail('not_ready');
    if (res.status === 404) throw fail('not_found');
    if (!res.ok) throw fail('server', (data && data.error) || 'HTTP ' + res.status);
    return data || {};
  }
  function errText(e) {
    return ({
      no_key: '설정 → 업무보드 연결에서 연결 키를 넣어 주세요.',
      bad_key: '업무보드 연결 키가 맞지 않아요. 보드에서 새로 받은 키를 넣어 주세요.',
      not_ready: '업무보드가 아직 끄적노트 연결을 받도록 바뀌지 않았어요.',
      blocked: '업무보드에 연결할 수 없어요. 보드가 아직 끄적노트 연결을 받도록 바뀌지 않았거나 주소가 다를 수 있어요.',
      offline: '인터넷에 연결되어 있지 않아요.',
    })[e.code] || ('업무보드 오류: ' + (e.message || '알 수 없음'));
  }

  /* ---------- 끄적노트 할 일 → 보드 업무 ---------- */
  const CAT_RULES = [
    [/회의|행사|심포지엄|협의체|워크숍|간담회|설명회|포럼/, '회의·행사'],
    [/교육|강의|연수|특강|훈련|성과공유회/, '교육'],
    [/예산|정산|구매|계약|지출|집행|출장|품의|행정/, '예산·행정'],
    [/환자|기관|연계|의뢰|협력|보건소|의료원/, '환자·기관 연계'],
    [/조사|분석|통계|연구|설문|데이터|지표/, '조사·분석'],
    [/보고|문서|계획서|결과|공문|작성|제출|자료|회신/, '보고·문서'],
  ];
  const guessCat = t => (CAT_RULES.find(([re]) => re.test(t)) || [null, ''])[1];
  const dueLabel = d => (d ? '~' + (+d.slice(5, 7)) + '/' + (+d.slice(8, 10)) : '');
  function statusOf(it) {
    const st = it.status || 'todo';
    if ((st === 'todo' || st === 'doing') && it.date && it.date < D.today()) return '지연';
    return ST[st] || '예정';
  }
  const extId = it => 'kk-' + it.id;
  const candidates = () => [...A().S.items.values()]
    .filter(i => !i.deleted && i.type === 'task' && !i.board && ['todo', 'doing', 'hold'].includes(i.status || 'todo'))
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt);

  /* 올린 업무의 상태·기한·제목이 바뀌면 보드에도 (설정에서 끌 수 있음) */
  const fp = it => [statusOf(it), it.date || '', it.title].join('|');
  async function sync(items) {
    if (!ready() || !cfg().auto) return;
    const list = (items || []).filter(i => i && i.board && !i.deleted && fp(i) !== i.board.fp);
    for (const it of list) {
      try {
        await call('PATCH', '/api/ext/tasks/' + encodeURIComponent(it.board.ext), { status: statusOf(it), due: it.date || '', due_label: dueLabel(it.date), task: it.title.slice(0, 120) });
        it.board.fp = fp(it); it.board.dirty = false; it.board.at = Date.now();
      } catch (e) {
        if (e.code === 'not_found') { it.board.gone = true; it.board.fp = fp(it); } // 보드에서 지운 업무
        else it.board.dirty = true;
      }
      db.put(it);
    }
  }
  function flush() {
    if (!ready() || !navigator.onLine) return;
    sync([...A().S.items.values()].filter(i => i.board && (i.board.dirty || fp(i) !== i.board.fp)));
  }

  /* ---------- 올리기 창 ---------- */
  let picks = [];
  function openUpload() {
    const dlg = $('dlgBoard');
    $('bOwner').value = cfg().owner;
    $('bArea').value = A().settings.boardArea || '';
    setMsg('');
    picks = candidates().map(it => ({ it, on: true, cat: guessCat(it.title + ' ' + (it.detail || '')) }));
    renderList();
    if (!ready()) setMsg('설정 → 업무보드 연결에서 연결 키를 먼저 넣어 주세요.', 'err');
    if (!dlg.open) dlg.showModal();
  }
  function setMsg(t, kind, spin) {
    const el = $('bMsg');
    el.className = 'mmsg' + (kind ? ' ' + kind : '');
    el.textContent = '';
    if (spin) el.append(h('span', { class: 'spin' }));
    el.append(t || '');
  }
  function renderList() {
    const box = $('bList');
    box.textContent = '';
    if (!picks.length) { box.append(h('p', { class: 'wempty' }, '보드에 올릴 할 일이 없어요. 이미 다 올렸거나, 남은 할 일이 없어요.')); updateGo(); return; }
    box.append(h('ul', { class: 'blist' }, picks.map(p => h('li', null,
      h('input', { type: 'checkbox', checked: p.on, 'aria-label': p.it.title + ' 올리기', onchange: e => { p.on = e.target.checked; updateGo(); } }),
      h('span', { class: 'bt' }, p.it.title, p.it.date ? h('small', null, dueLabel(p.it.date) + (statusOf(p.it) === '지연' ? ' 지남' : '')) : null),
      h('select', { 'aria-label': '분류', onchange: e => { p.cat = e.target.value; } },
        h('option', { value: '' }, '분류 없음'), CATEGORIES.map(c => h('option', { value: c, selected: c === p.cat }, c)))))));
    updateGo();
  }
  function updateGo() {
    const n = picks.filter(p => p.on).length;
    $('bGo').disabled = !n || !ready();
    $('bGo').textContent = n ? '보드에 ' + n + '건 올리기' : '보드에 올리기';
  }
  async function upload() {
    const go = picks.filter(p => p.on);
    if (!go.length) return;
    const owner = $('bOwner').value.trim().slice(0, 40), area = $('bArea').value.trim().slice(0, 40);
    A().settings.boardOwner = owner; A().settings.boardArea = area; A().saveSettings();
    $('bGo').disabled = true;
    let ok = 0, failed = null;
    for (const p of go) {
      setMsg('올리는 중… ' + (ok + 1) + '/' + go.length, '', true);
      const it = p.it;
      try {
        const r = await call('POST', '/api/ext/tasks', {
          ext_id: extId(it), task: it.title.slice(0, 120), owner, area, category: p.cat, priority: it.priority === 'high' ? '높음' : '보통',
          due: it.date || '', due_label: dueLabel(it.date), status: statusOf(it), note: (it.detail || '').slice(0, 300),
        });
        it.board = { ext: extId(it), id: r.id || '', at: Date.now(), fp: fp(it) };
        db.put(it); ok++;
        p.done = true;
      } catch (e) { failed = e; break; }
    }
    picks = picks.filter(p => !p.done);
    renderList();
    if (KK.work) KK.work.render();
    if (failed) setMsg((ok ? ok + '건은 올렸어요. ' : '') + errText(failed), 'err');
    else { setMsg(ok + '건을 업무보드에 올렸어요.', 'ok'); toast('업무보드에 ' + ok + '건을 올렸어요', '보드 열기', () => window.open(cfg().url, '_blank', 'noopener'), 7000); }
  }
  $('bGo').addEventListener('click', upload);
  $('bClose').addEventListener('click', () => $('dlgBoard').close());
  $('bAll').addEventListener('click', () => { const on = !picks.every(p => p.on); picks.forEach(p => { p.on = on; }); renderList(); });

  /* ---------- 설정: 연결 테스트 ---------- */
  async function test(msgEl) {
    msgEl.className = ''; msgEl.textContent = '확인 중…';
    try {
      const r = await call('GET', '/api/ext/ping');
      msgEl.className = 'okmsg'; msgEl.textContent = '연결됐어요' + (r.name ? ' · ' + r.name : '') + (r.board ? ' · ' + r.board : '');
      if (r.name && !A().settings.boardOwner) { A().settings.boardOwner = r.name; $('boardOwner').value = r.name; A().saveSettings(); }
    } catch (e) { msgEl.className = 'errmsg'; msgEl.textContent = errText(e); }
  }

  KK.board = { DEFAULT_URL, ready, openUpload, sync, flush, test, candidates, statusOf };
})();
