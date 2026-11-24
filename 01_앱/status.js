'use strict';
/* 끄적노트 — 업무 현황 내보내기 (kk-v31)
   - 누를 때만: 할 일·일정·전달·회의 결정사항의 현황을 글 파일 하나(내용은 JSON)로 내보냄. 끄적노트 → 밖으로 한쪽만
   - 넣지 않는 것: 노트 본문, 자세한 내용(detail), 원문 구절(src), 장소, 대상(to), 필기, 가져온 파일, 녹음, 붙인 자료, 개인 중요 메모, 설정·키, 보드 id·구글 일정 id
   - 칸을 하나씩 골라 새로 만들어 담음(항목을 통째로 옮기지 않음) */
window.KK = window.KK || {};

(function () {
  const { $, h, toast } = KK.ui;
  const D = KK.date;
  const A = () => KK.app;
  const FILE = '끄적노트 업무 현황.txt';
  const KEEP_DAYS = 60; // 완결·취소는 최근 60일 것만
  const TYPES = ['task', 'event', 'notice', 'memo'];
  const TYPE_KO = { task: '할 일', event: '일정', notice: '전달', memo: '회의 결정사항' };

  // 2026-11-25T14:03:00+09:00
  function iso(ms) {
    const d = new Date(ms), off = -d.getTimezoneOffset(), a = Math.abs(off);
    return D.ymd(d) + 'T' + D.pad(d.getHours()) + ':' + D.pad(d.getMinutes()) + ':' + D.pad(d.getSeconds()) + (off < 0 ? '-' : '+') + D.pad(Math.floor(a / 60)) + ':' + D.pad(a % 60);
  }
  const isTablet = () => !!(KK.voice && KK.voice.isAndroid);
  const closed = it => ['done', 'cancel'].includes(it.status || 'todo');
  const closedAt = it => it.doneAt || it.statusAt || it.updatedAt || it.createdAt || 0; // 취소는 doneAt이 없음
  function pick(it, now) {
    if (!it || it.deleted || !TYPES.includes(it.type)) return false;
    if (it.type === 'memo' && it.source !== 'minutes') return false; // 개인 중요 메모는 뺌
    return !closed(it) || closedAt(it) >= now - KEEP_DAYS * 86400000;
  }
  const source = it => (['minutes', 'board'].includes(it.source) ? it.source : !it.noteId && it.gLinked ? 'calendar' : 'note');
  const row = it => ({
    id: it.id, type: it.type, title: String(it.title || '').replace(/\s+/g, ' ').trim(), date: it.date || '', time: it.time || '',
    status: it.status || 'todo', group: it.group || '', priority: it.priority || 'normal', source: source(it), board: !!(it.board && !it.board.gone),
    doneAt: it.doneAt || 0, statusAt: it.statusAt || 0, createdAt: it.createdAt || 0, updatedAt: it.updatedAt || 0,
  });
  function build(now) {
    now = now || Date.now();
    const items = [...A().S.items.values()].filter(i => pick(i, now)).map(row)
      .sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const counts = { total: items.length };
    TYPES.forEach(t => { counts[t] = items.filter(i => i.type === t).length; });
    const c = (KK.sync && KK.sync.cfg) || {};
    return {
      format: 'kkeojeok-status', version: 1, exportedAt: iso(now), appVersion: document.documentElement.dataset.ver || '', device: isTablet() ? '태블릿' : 'PC',
      sync: { on: !!c.on, lastSync: c.on && c.seeded && c.last ? iso(c.last) : '', pending: c.on && KK.sync ? KK.sync.pendingCount() : 0 },
      keepClosedDays: KEEP_DAYS, counts, items,
    };
  }

  /* ---------- 내보내기 창 ---------- */
  let cur = null;
  const file = () => new File([JSON.stringify(cur, null, 1)], FILE, { type: 'text/plain' });
  function canShare() {
    try { return isTablet() && !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file()] })); } catch (e) { return false; }
  }
  function open() {
    cur = build();
    const n = cur.counts;
    $('stCounts').textContent = n.total ? TYPES.filter(t => n[t]).map(t => TYPE_KO[t] + ' ' + n[t]).join(' · ') : '내보낼 항목이 없어요.';
    const s = cur.sync, warn = $('stSync');
    // 다른 기기에서 쓴 것이 아직 안 들어왔을 수 있음
    warn.textContent = !s.on ? '이 기기에 있는 것만 들어가요(노트북과 맞추기가 꺼져 있음).'
      : !s.lastSync ? '아직 다른 기기와 다 맞추지 못해 빠진 것이 있을 수 있어요.'
        : (s.pending || !KK.sync.hasToken()) ? '마지막으로 맞춘 때 ' + D.stamp(KK.sync.cfg.last) + ' · 그 뒤 다른 기기에서 쓴 것은 빠질 수 있어요.'
          : '마지막으로 맞춘 때 ' + D.stamp(KK.sync.cfg.last);
    $('stShare').hidden = !canShare();
    $('stShare').disabled = $('stSave').disabled = !n.total;
    $('stSave').className = 'btn' + ($('stShare').hidden ? ' primary' : '');
    if ($('dlgSettings').open) $('dlgSettings').close();
    if (!$('dlgStatus').open) $('dlgStatus').showModal();
  }
  function save() {
    const a = h('a', { href: URL.createObjectURL(file()), download: FILE });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    $('dlgStatus').close();
    toast('「' + FILE + '」 파일을 받았어요(받은 파일 폴더)', null, null, 6000);
  }
  async function share() {
    try {
      await navigator.share({ files: [file()] });
      $('dlgStatus').close();
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 공유 창을 닫음
      save(); // 공유가 안 되면 파일로
    }
  }
  $('btnStatus').addEventListener('click', open);
  $('stShare').addEventListener('click', share);
  $('stSave').addEventListener('click', save);
  $('stClose').addEventListener('click', () => $('dlgStatus').close());

  KK.status = { open, build, FILE };
})();
