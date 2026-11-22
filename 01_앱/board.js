'use strict';
/* 끄적노트 — 공공보건의료사업팀 업무보드 연결
   끄적노트의 할 일 → 보드 '업무 목록' (내가 골라서 올림). 올린 업무는 끄적노트에서 상태·기한이 바뀌면 보드에도 맞춘다.
   kk-v29: 같은 업무·비슷한 일은 보드 한 줄로 합쳐 올리고, 보드에 이미 있는 같은 업무에는 더한다. 겹쳐 올라간 줄은 골라서 하나로.
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

  /* ---------- 같은 업무 묶음 (kk-v29) ----------
     보드 업무 한 줄 = 끄적노트 할 일 하나 또는 여럿(같은 업무·비슷한 일). it.board.ext(없으면 id)가 같으면 한 줄.
     it.board.title = 여럿을 묶었거나 이름이 다른 보드 업무에 더했을 때의 보드 업무 이름
     it.board.fp  = 마지막으로 맞췄을 때의 끄적노트 쪽 지문(보드 말로 바꾼 값)
     it.board.bfp = 마지막으로 맞췄을 때의 보드 쪽 지문 */
  const fp = it => [statusOf(it), it.date || '', it.title].join('|');
  const bfp = t => [t.status || '', t.due || '', t.task || ''].join('|');
  const keyOf = it => it.board.ext || String(it.board.id || '');
  const OPEN3 = ['todo', 'doing', 'hold'];
  const SIM = 0.6;
  // 비슷한 일 판단: 팀 이름·'관련'·'작성' 같은 흔한 말은 빼고 견줌
  const STOP = /공공보건의료사업팀|공공보건의료|울산대학교병원|울산대병원|관련|관한|대한|위한|작성|검토|준비|제출|진행|확인|요청|처리|및|등/g;
  const nrm = t => String(t || '').toLowerCase().replace(/^\s*\[[^\]]*\]\s*/, '').replace(STOP, '').replace(/[\s[\]().,·:;!?~\-_/'"「」『』<>]/g, '');
  const bigr = x => { const o = []; for (let i = 0; i < x.length - 1; i++) o.push(x.slice(i, i + 2)); return o; };
  function sim(x, y) {
    const a = nrm(x), b = nrm(y);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const sh = a.length <= b.length ? a : b, lo = sh === a ? b : a;
    if (sh.length >= 3 && lo.includes(sh) && sh.length / lo.length >= 0.4) return 0.9;
    const A2 = bigr(a), pool = bigr(b), nb = pool.length;
    if (!A2.length || !nb) return 0;
    let m = 0;
    A2.forEach(g => { const i = pool.indexOf(g); if (i >= 0) { m++; pool.splice(i, 1); } });
    return (2 * m) / (A2.length + nb);
  }
  function bundles() {
    const m = new Map();
    A().S.items.forEach(i => {
      if (!i.board || !keyOf(i)) return;
      const k = keyOf(i);
      if (!m.has(k)) m.set(k, { key: k, all: [] });
      m.get(k).all.push(i);
    });
    m.forEach(b => {
      b.items = b.all.filter(i => !i.deleted).sort((x, y) => (x.board.at || 0) - (y.board.at || 0) || (x.createdAt || 0) - (y.createdAt || 0));
      b.lead = b.items[0] || b.all[0];
      b.title = b.lead.board.title || b.lead.title;
    });
    return m;
  }
  function groupOf(items) {
    const c = new Map();
    items.forEach(i => { const g = (i.group || '').trim(); if (g) c.set(g, (c.get(g) || 0) + 1); });
    const top = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : '';
  }
  // 여럿이면: 가장 가까운 남은 기한, 다 끝났으면 마지막 기한
  function bundleDue(items) {
    if (items.length === 1) return items[0].date || '';
    const open = items.filter(i => OPEN3.includes(i.status || 'todo') && i.date).map(i => i.date).sort();
    return open[0] || items.map(i => i.date).filter(Boolean).sort().pop() || '';
  }
  // 여럿이면: 다 끝나야 완료(모두 취소면 취소), 기한 지난 일이 있으면 지연, 하나라도 진행이면 진행 중
  function bundleStatus(items) {
    if (items.length === 1) return statusOf(items[0]);
    const open = items.filter(i => OPEN3.includes(i.status || 'todo'));
    if (!open.length) return items.every(i => i.status === 'cancel') ? '취소' : '완료';
    if (open.some(i => ['todo', 'doing'].includes(i.status || 'todo') && i.date && i.date < D.today())) return '지연';
    if (open.some(i => i.status === 'doing')) return '진행 중';
    if (open.every(i => i.status === 'hold')) return '대기';
    return '예정';
  }
  function valsOf(b) {
    const due = bundleDue(b.items);
    return { status: bundleStatus(b.items), due, due_label: dueLabel(due), task: String(b.title || '').slice(0, 120) };
  }
  const fpv = v => [v.status, v.due, v.task].join('|');

  /* ---------- 끄적노트 → 보드: 상태·기한·이름이 바뀌면 보드에도 (설정에서 끌 수 있음) ---------- */
  async function sync(items) {
    if (!ready() || !cfg().auto) return;
    const keys = new Set((items || []).filter(i => i && i.board && keyOf(i)).map(keyOf));
    if (!keys.size) return;
    const B = bundles();
    for (const k of keys) {
      const b = B.get(k);
      if (!b || !b.items.length || b.items.some(i => i.board.gone)) continue;
      const v = valsOf(b), f = fpv(v);
      if (b.items.every(i => i.board.fp === f && !i.board.dirty)) continue;
      try {
        await call('PATCH', '/api/ext/tasks/' + encodeURIComponent(k), v);
        b.items.forEach(i => { i.board.fp = f; i.board.bfp = f; i.board.label = v.status; i.board.dirty = false; });
      } catch (e) {
        if (e.code === 'not_found') b.items.forEach(i => { i.board.gone = true; i.board.fp = f; }); // 보드에서 지운 업무
        else b.items.forEach(i => { i.board.dirty = true; });
      }
      await db.putMany(b.items);
    }
  }
  function flush() {
    if (!ready() || !navigator.onLine) return;
    sync([...A().S.items.values()].filter(i => i.board));
    pull();
  }

  /* ---------- 보드 → 끄적노트: 보드에서 바뀐 상태·기한을 받고, 내 담당 업무를 가져온다 ---------- */
  const BACK = { '예정': 'todo', '진행 중': 'doing', '대기': 'hold', '확인 필요': 'todo', '지연': 'todo', '완료': 'done', '취소': 'cancel' };
  const norm = s => String(s || '').replace(/\s+/g, '');
  const mine = (owner, me) => !!me && norm(owner).includes(norm(me));
  let pulling = false, lastPull = 0, pullState = '', lastList = null;
  function curNoteId() {
    const S = A().S, cm = KK.work ? KK.work.curYM() : '';
    const n = S.cur && S.notes.get(S.cur);
    if (n && !n.closed && (!cm || n.month === cm)) return n.id;
    const m = [...S.notes.values()].filter(x => !x.closed && !x.imported && (!cm || x.month === cm)).sort((a, b) => a.createdAt - b.createdAt)[0];
    return m ? m.id : (n ? n.id : '');
  }
  function applyBoard(it, t, now) {
    const st = BACK[t.status] || 'todo';
    if (t.task) it.title = String(t.task).slice(0, 120);
    it.date = D.isValid(t.due || '') ? t.due : '';
    if (st !== (it.status || 'todo')) { it.status = st; it.statusAt = now; it.doneAt = st === 'done' ? now : 0; }
    if (t.priority && !it.priSet) it.priority = t.priority === '높음' ? 'high' : 'normal'; // 끄적노트에서 정한 우선순위는 그대로
    it.updatedAt = now;
  }
  // 여럿을 묶은 줄: 보드에서 이름을 바꾸면 이름만, 완료·취소면 남은 할 일을 모두 끝냄(기한은 할 일마다 그대로)
  function applyBundle(b, t, now) {
    const old = String(b.lead.board.bfp || '').split('|');
    if (t.task && t.task !== old[2]) b.items.forEach(i => { i.board.title = String(t.task).slice(0, 120); });
    if (t.status !== old[0] && (t.status === '완료' || t.status === '취소')) {
      const st = t.status === '완료' ? 'done' : 'cancel';
      b.items.forEach(i => { if (OPEN3.includes(i.status || 'todo')) { i.status = st; i.statusAt = now; i.doneAt = st === 'done' ? now : 0; i.updatedAt = now; } });
    }
  }
  async function pull(force) {
    if (!ready() || pulling || !navigator.onLine) return;
    if (!force && Date.now() - lastPull < 60e3) return;
    pulling = true;
    try {
      const r = await call('GET', '/api/ext/tasks');
      lastPull = Date.now(); pullState = 'ok';
      lastList = Array.isArray(r.tasks) ? r.tasks : [];
      reconcile(lastList);
    } catch (e) {
      pullState = (e.code === 'not_ready' || e.code === 'not_found' || e.code === 'server') ? 'old' : 'err'; // old: 보드에 목록 읽기가 아직 없음
    } finally { pulling = false; if (KK.work) KK.work.render(); }
  }
  function reconcile(list) {
    const S = A().S, now = Date.now(), changed = [], me = (cfg().owner || '').trim();
    const byExt = new Map(), byId = new Map();
    list.forEach(t => { if (t.ext_id) byExt.set(String(t.ext_id), t); if (t.id != null) byId.set(String(t.id), t); });
    const seen = new Set();
    let updated = 0, added = 0;
    bundles().forEach(b => {
      const any = b.lead;
      const t = (any.board.ext && byExt.get(any.board.ext)) || (any.board.id != null && any.board.id !== '' && byId.get(String(any.board.id)));
      if (!t) {
        b.all.forEach(it => {
          if (it.deleted) return;
          if (it.board.src === 'board') { it.deleted = true; it.deletedAt = now; changed.push(it); } // 보드에서 지운 업무는 끄적노트에서도 지움
          else if (!it.board.gone) { it.board.gone = true; changed.push(it); }
        });
        return;
      }
      seen.add(String(t.id));
      const live = b.items; // 끄적노트에서 지운 것은 다시 가져오지 않음
      live.forEach(it => {
        if (!it.board.id) { it.board.id = t.id; changed.includes(it) || changed.push(it); }
        if (it.board.label !== t.status) { it.board.label = t.status; changed.includes(it) || changed.push(it); }
      });
      if (!live.length || bfp(t) === live[0].board.bfp) return;
      // 보드에서 바뀜 → 끄적노트에 반영 (보드 쪽이 이김)
      if (live.length === 1 && !live[0].board.title) applyBoard(live[0], t, now);
      else applyBundle(b, t, now);
      b.title = b.lead.board.title || b.lead.title;
      const f = fpv(valsOf(b));
      live.forEach(it => { it.board.bfp = bfp(t); it.board.fp = f; it.board.gone = false; it.board.dirty = false; changed.includes(it) || changed.push(it); });
      updated++;
    });
    if (A().settings.boardPull !== false && me) {
      const noteId = curNoteId();
      list.forEach(t => {
        if (seen.has(String(t.id)) || (t.ext_id && byExt.has(String(t.ext_id)) && String(t.ext_id).startsWith('kk-'))) return; // 끄적노트에서 올린 것(다른 기기 포함)은 건너뜀
        if (['완료', '취소'].includes(t.status) || !mine(t.owner, me)) return;
        const it = {
          id: 't-' + KK.uid(), kind: 'item', noteId, type: 'task', title: String(t.task || '').slice(0, 120), date: '', time: '', endTime: '', place: '', to: '',
          priority: 'normal', detail: [t.area, t.category].filter(Boolean).join(' · '), status: 'todo', locked: false, deleted: false,
          createdAt: now, updatedAt: now, doneAt: 0, source: 'board', board: { id: t.id, ext: '', src: 'board', label: t.status, at: now },
        };
        applyBoard(it, t, now);
        it.board.bfp = bfp(t); it.board.fp = fp(it);
        if (!it.title) return;
        S.items.set(it.id, it); changed.push(it); added++;
      });
    }
    if (changed.length) { db.putMany(changed); A().renderAll(); }
    if (added || updated) toast(['업무보드에서', added ? '내 담당 업무 ' + added + '건을 가져오고' : '', updated ? '바뀐 업무 ' + updated + '건을 맞췄어요' : ''].filter(Boolean).join(' ').replace(/가져오고$/, '가져왔어요'), null, null, 6000);
  }
  // 앱을 보고 있는 동안 5분마다 보드에서 받아 온다
  setInterval(() => { if (document.visibilityState === 'visible') pull(); }, 5 * 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
  const status = () => ({ state: pullState, at: lastPull });

  /* ---------- 올리기 창 (kk-v29: 합쳐 올리기·보드에 있는 업무에 더하기·겹친 줄 정리) ---------- */
  let rows = [], dups = [], touched = false;
  const shortest = items => items.map(i => i.title).sort((a, b) => a.length - b.length)[0];
  // 더할 수 있는 보드 업무: 끄적노트에서 올린 줄(다른 기기 포함)·보드에서 가져온 내 담당, 완료·취소 아닌 것
  function existing() {
    const out = [];
    bundles().forEach(b => {
      if (!b.items.length || b.lead.board.gone || ['완료', '취소'].includes(b.lead.board.label)) return;
      out.push({ key: b.key, ext: b.lead.board.ext || '', id: b.lead.board.id || '', title: b.title, group: groupOf(b.items), src: b.lead.board.src === 'kk' ? 'kk' : 'link', bfp: b.lead.board.bfp || '', label: b.lead.board.label || '' });
    });
    const me = (cfg().owner || '').trim(), have = new Set(out.map(e => String(e.id)).filter(Boolean));
    (lastList || []).forEach(t => {
      if (have.has(String(t.id)) || ['완료', '취소'].includes(t.status) || !mine(t.owner, me)) return;
      if (t.ext_id && String(t.ext_id).startsWith('kk-')) return; // 끄적노트에서 올린 것은 위에서
      out.push({ key: String(t.id), ext: '', id: t.id, title: String(t.task || ''), group: '', src: 'link', bfp: bfp(t), label: t.status });
    });
    return out;
  }
  function finishRow(r, ex) {
    r.items.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt);
    r.title = r.items.length > 1 ? (r.group || shortest(r.items)) : r.items[0].title;
    if (r.on == null) r.on = true;
    if (r.cat == null) r.cat = guessCat(r.items.map(i => i.title + ' ' + (i.detail || '')).join(' '));
    r.link = r.nolink ? null : ((ex || existing()).find(e => (r.group && e.group && sim(e.group, r.group) >= 0.8) || sim(e.title, r.title) >= SIM || r.items.some(i => sim(e.title, i.title) >= SIM)) || null);
    return r;
  }
  // 같은 업무(업무 이름)·비슷한 일은 한 줄로
  function propose() {
    const cands = candidates(), out = [];
    cands.forEach(it => {
      const g = (it.group || '').trim();
      if (!g) return;
      let r = out.find(x => x.group === g || sim(x.group, g) >= 0.8);
      if (!r) { r = { group: g, items: [] }; out.push(r); }
      r.items.push(it);
    });
    cands.filter(it => !(it.group || '').trim()).forEach(it => {
      const r = out.find(x => x.items.some(y => sim(y.title, it.title) >= SIM) || (x.group && sim(x.group, it.title) >= SIM));
      if (r) r.items.push(it); else out.push({ group: '', items: [it] });
    });
    const ex = existing();
    return out.map(r => finishRow(r, ex));
  }
  // 보드에 겹쳐 올라간 줄(끄적노트에서 올린 것끼리): 같은 업무이거나 이름이 비슷함
  function findDups() {
    const list = [...bundles().values()].filter(b => b.items.length && !b.lead.board.gone && String(b.key).startsWith('kk-') && !['완료', '취소'].includes(b.lead.board.label));
    const used = new Set(), sets = [];
    list.forEach((b, i) => {
      if (used.has(b.key)) return;
      const g = groupOf(b.items);
      const same = list.filter((c, j) => j > i && !used.has(c.key) && ((g && groupOf(c.items) === g) || sim(c.title, b.title) >= SIM));
      if (!same.length) return;
      const set = [b, ...same];
      set.forEach(x => used.add(x.key));
      sets.push({ list: set, on: true });
    });
    return sets;
  }
  const keepOf = d => d.list.slice().sort((a, b) => b.items.length - a.items.length || (a.lead.board.at || 0) - (b.lead.board.at || 0))[0];
  const dupTitle = d => { const all = d.list.flatMap(x => x.items); return groupOf(all) || keepOf(d).title; };
  function openUpload() {
    const dlg = $('dlgBoard');
    $('bOwner').value = cfg().owner;
    $('bArea').value = A().settings.boardArea || '';
    setMsg('');
    touched = false;
    rows = propose(); dups = findDups();
    render();
    if (!ready()) setMsg('설정 → 업무보드 연결에서 연결 키를 먼저 넣어 주세요.', 'err');
    if (!dlg.open) dlg.showModal();
    if (ready()) pull(true).then(() => { if (!touched && dlg.open) { rows = propose(); dups = findDups(); render(); } });
  }
  function setMsg(t, kind, spin) {
    const el = $('bMsg');
    el.className = 'mmsg' + (kind ? ' ' + kind : '');
    el.textContent = '';
    if (spin) el.append(h('span', { class: 'spin' }));
    el.append(t || '');
  }
  function render() { renderDups(); renderList(); }
  function renderDups() {
    const box = $('bDup');
    box.textContent = '';
    if (!dups.length) return;
    const n = () => dups.filter(d => d.on).length;
    const go = h('button', { type: 'button', class: 'btn', id: 'bDupGo', onclick: mergeDups }, '고른 ' + n() + '묶음 하나로 합치기');
    box.append(h('div', { class: 'bdup' },
      h('b', null, '보드에 겹쳐 올라간 업무 ' + dups.length + '묶음'),
      h('p', null, '하나만 남기고 나머지는 보드에서 \'취소\'로 바꿔요(보드는 지우기가 안 돼요). 끄적노트 할 일은 남긴 줄에 모아요.'),
      h('ul', { class: 'blist' }, dups.map(d => h('li', null,
        h('input', { type: 'checkbox', checked: d.on, 'aria-label': dupTitle(d) + ' 합치기', onchange: e => { d.on = e.target.checked; go.textContent = '고른 ' + n() + '묶음 하나로 합치기'; go.disabled = !n(); } }),
        h('span', { class: 'bt' }, d.list.map(x => '「' + x.title + '」').join(' · '), h('span', { class: 'bsub' }, '→ 「' + dupTitle(d) + '」 한 줄로 남김'))))),
      h('div', { class: 'row' }, go)));
  }
  function renderList() {
    const box = $('bList');
    box.textContent = '';
    if (!rows.length) { box.append(h('p', { class: 'wempty' }, '보드에 올릴 할 일이 없어요. 이미 다 올렸거나, 남은 할 일이 없어요.')); updateGo(); return; }
    box.append(h('ul', { class: 'blist' }, rows.map((r, idx) => {
      const due = bundleDue(r.items), multi = r.items.length > 1;
      const sub = [];
      if (multi) sub.push(h('span', { class: 'bsub' }, r.items.length + '건 합침: ' + r.items.map(i => i.title).join(' · '), ' ',
        h('button', { type: 'button', class: 'linkbtn', onclick: () => { touched = true; const ex = existing(); rows.splice(idx, 1, ...r.items.map(it => finishRow({ group: '', items: [it], on: r.on, cat: r.cat }, ex))); renderList(); } }, '따로 올리기')));
      if (r.link) sub.push(h('span', { class: 'bsub link' }, '→ 보드의 「' + r.link.title + '」에 더함(새 줄 안 만듦)', ' ',
        h('button', { type: 'button', class: 'linkbtn', onclick: () => { touched = true; r.nolink = true; r.link = null; renderList(); } }, '새로 올리기')));
      return h('li', null,
        h('input', { type: 'checkbox', checked: r.on, 'aria-label': r.title + ' 올리기', onchange: e => { r.on = e.target.checked; updateGo(); } }),
        h('span', { class: 'bt' }, r.title, due ? h('small', null, dueLabel(due) + (bundleStatus(r.items) === '지연' ? ' 지남' : '')) : null, sub),
        r.link ? h('span') : h('select', { 'aria-label': '분류', onchange: e => { r.cat = e.target.value; } },
          h('option', { value: '' }, '분류 없음'), CATEGORIES.map(c => h('option', { value: c, selected: c === r.cat }, c))));
    })));
    updateGo();
  }
  function updateGo() {
    const on = rows.filter(r => r.on), n = on.reduce((s, r) => s + r.items.length, 0);
    $('bGo').disabled = !on.length || !ready();
    $('bGo').textContent = !on.length ? '보드에 올리기' : on.length === n ? '보드에 ' + n + '건 올리기' : '할 일 ' + n + '건을 보드 ' + on.length + '줄로 올리기';
  }
  async function upload() {
    const go = rows.filter(r => r.on);
    if (!go.length) return;
    const owner = $('bOwner').value.trim().slice(0, 40), area = $('bArea').value.trim().slice(0, 40);
    A().settings.boardOwner = owner; A().settings.boardArea = area; A().saveSettings();
    $('bGo').disabled = true;
    let ok = 0, joined = 0, items = 0, failed = null;
    for (const r of go) {
      setMsg('올리는 중… ' + (ok + joined + 1) + '/' + go.length, '', true);
      try {
        const at = Date.now();
        if (r.link) { // 보드에 있는 같은 업무에 더함
          const e = r.link;
          r.items.forEach(it => { it.board = { ext: e.ext, id: e.id, at, fp: '', bfp: e.bfp, label: e.label, src: e.src, title: e.title }; });
          await db.putMany(r.items);
          await sync(r.items);
          joined++;
        } else {
          const lead = r.items[0], multi = r.items.length > 1;
          const v = valsOf({ items: r.items, title: r.title });
          const note = multi ? '끄적노트 할 일 ' + r.items.length + '건\n' + r.items.map(i => '· ' + i.title + (i.date ? ' ' + dueLabel(i.date) : '')).join('\n') : (lead.detail || '');
          const res = await call('POST', '/api/ext/tasks', {
            ext_id: extId(lead), task: v.task, owner, area, category: r.cat, priority: r.items.some(i => i.priority === 'high') ? '높음' : '보통',
            due: v.due, due_label: v.due_label, status: v.status, note: note.slice(0, 300),
          });
          const f = fpv(v);
          r.items.forEach(it => { it.board = { ext: extId(lead), id: res.id || '', at, fp: f, bfp: f, label: v.status, src: 'kk' }; if (multi) it.board.title = v.task; });
          await db.putMany(r.items);
          ok++;
        }
        items += r.items.length;
        r.done = true;
      } catch (e) { failed = e; break; }
    }
    rows = rows.filter(r => !r.done);
    render();
    if (KK.work) KK.work.render();
    const what = '할 일 ' + items + '건을 ' + [ok ? '새 줄 ' + ok + '개' : '', joined ? '있던 줄 ' + joined + '개에 더해' : ''].filter(Boolean).join(', ') + (ok && !joined ? '로' : '') + ' 올렸어요';
    if (failed) setMsg((items ? what + '. ' : '') + errText(failed), 'err');
    else { setMsg(what + '.', 'ok'); pull(true); toast('업무보드에 ' + what, '보드 열기', () => window.open(cfg().url, '_blank', 'noopener'), 7000); }
  }
  async function mergeDups() {
    const go = dups.filter(d => d.on);
    if (!go.length) return;
    $('bDupGo').disabled = true;
    let n = 0, cut = 0, failed = null;
    for (const d of go) {
      const keep = keepOf(d), title = dupTitle(d), all = d.list.flatMap(x => x.all);
      setMsg('합치는 중… ' + (n + 1) + '/' + go.length, '', true);
      try {
        for (const x of d.list) {
          if (x === keep) continue;
          try { await call('PATCH', '/api/ext/tasks/' + encodeURIComponent(x.key), { status: '취소' }); cut++; }
          catch (e) { if (e.code !== 'not_found') throw e; }
          x.all.forEach(it => { it.board = Object.assign({}, keep.lead.board, { fp: '', dirty: false, gone: false }); });
        }
        all.forEach(it => { it.board.title = title; it.board.fp = ''; });
        await db.putMany(all);
        await sync(all);
        n++;
      } catch (e) { failed = e; break; }
    }
    dups = findDups(); rows = propose();
    render();
    if (KK.work) KK.work.render();
    if (failed) setMsg((n ? n + '묶음은 합쳤어요. ' : '') + errText(failed), 'err');
    else { setMsg(n + '묶음을 하나로 합쳤어요(보드에서 ' + cut + '줄은 취소로).', 'ok'); pull(true); }
  }
  $('bGo').addEventListener('click', upload);
  $('bClose').addEventListener('click', () => $('dlgBoard').close());
  $('bAll').addEventListener('click', () => { touched = true; const on = !rows.every(r => r.on); rows.forEach(r => { r.on = on; }); renderList(); });
  const dupCount = () => findDups().length;

  /* ---------- 설정: 연결 테스트 ---------- */
  async function test(msgEl) {
    msgEl.className = ''; msgEl.textContent = '확인 중…';
    try {
      const r = await call('GET', '/api/ext/ping');
      msgEl.className = 'okmsg'; msgEl.textContent = '연결됐어요' + (r.name ? ' · ' + r.name : '') + (r.board ? ' · ' + r.board : '');
      if (r.name && !A().settings.boardOwner) { A().settings.boardOwner = r.name; $('boardOwner').value = r.name; A().saveSettings(); }
    } catch (e) { msgEl.className = 'errmsg'; msgEl.textContent = errText(e); }
  }

  KK.board = { DEFAULT_URL, ready, openUpload, sync, flush, pull, status, test, candidates, statusOf, dupCount, _t: { sim, propose, findDups, bundleStatus, bundleDue } };
})();
