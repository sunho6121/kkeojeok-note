'use strict';
/* 끄적노트 — 검색: 모든 노트 내용에서 찾고 누르면 그 줄로, 녹음(이름·날짜·회의록·녹취 글)도 찾아 누르면 녹음 탭의 그 녹음으로 */
(function () {
  const { $, h } = KK.ui;
  const A = () => KK.app;
  let last = '', timer = null, runNo = 0;

  function snippet(line, i, len) {
    const start = Math.max(0, i - 30);
    const end = Math.min(line.length, i + len + 60);
    return [
      (start > 0 ? '…' : '') + line.slice(start, i),
      h('mark', null, line.slice(i, i + len)),
      line.slice(i + len, end) + (end < line.length ? '…' : ''),
    ];
  }

  async function run() {
    const my = ++runNo;
    const q = $('searchQ').value.trim();
    last = q;
    const box = $('searchResults'); box.textContent = '';
    if (!q) { box.append(h('p', { class: 'empty' }, '찾을 말을 입력하세요. 모든 노트와 녹음에서 찾아요.')); return; }
    const ql = q.toLowerCase();
    const S = A().S, liveBody = document.getElementById('body').value;
    let total = 0;
    KK.views.notesSorted().forEach(n => {
      const body = (n.id === S.cur ? liveBody : n.body) || '';
      const hits = [];
      let pos = 0;
      body.split('\n').forEach(line => {
        const low = line.toLowerCase();
        let i = low.indexOf(ql);
        while (i >= 0) { hits.push({ line, i, at: pos + i }); i = low.indexOf(ql, i + ql.length); }
        pos += line.length + 1;
      });
      const inTitle = (n.title || '').toLowerCase().includes(ql);
      if (!hits.length && !inTitle) return;
      total += hits.length || 1;
      const sec = h('section', null, h('h3', null, KK.views.noteLabel(n), h('span', { class: 'when' }, hits.length ? hits.length + '곳' : '제목')));
      hits.slice(0, 10).forEach(hit => sec.append(h('button', {
        type: 'button', class: 'srline',
        onclick: () => { $('dlgSearch').close(); A().selectInNote(n.id, hit.at, q.length); },
      }, snippet(hit.line, hit.i, q.length))));
      if (hits.length > 10) sec.append(h('p', { class: 'when' }, '그 밖에 ' + (hits.length - 10) + '곳 더 있어요'));
      if (!hits.length) sec.append(h('button', { type: 'button', class: 'srline', onclick: () => { $('dlgSearch').close(); A().openNote(n.id); A().setView('write'); } }, '노트 열기'));
      box.append(sec);
    });
    const recs = KK.voice && KK.voice.search ? await KK.voice.search(q) : [];
    if (my !== runNo) return; // 그새 다시 찾음
    if (recs.length) {
      total += recs.length;
      const sec = h('section', null, h('h3', null, '녹음', h('span', { class: 'when' }, recs.length + '개')));
      recs.slice(0, 15).forEach(({ r, mt }) => {
        const d = new Date(r.startAt || r.createdAt);
        sec.append(h('button', { type: 'button', class: 'srline', onclick: () => { $('dlgSearch').close(); KK.voice.show(r.id, q); } },
          h('b', null, r.name || '녹음'), ' · ' + (d.getMonth() + 1) + '/' + d.getDate() + (r.minutes ? ' · 회의록' : ''),
          mt.where ? h('span', { class: 'when', style: 'display:block' }, mt.where + ': ' + mt.pre, h('mark', null, mt.hit), mt.post) : null));
      });
      if (recs.length > 15) sec.append(h('p', { class: 'when' }, '그 밖에 ' + (recs.length - 15) + '개 더 있어요 (녹음 탭에서 찾기)'));
      box.append(sec);
    }
    if (!total) box.append(h('p', { class: 'empty' }, '"' + q + '"이(가) 들어간 노트·녹음이 없어요.'));
  }

  function open() {
    $('searchQ').value = last;
    run();
    $('dlgSearch').showModal();
    setTimeout(() => { $('searchQ').focus(); $('searchQ').select(); }, 60);
  }

  $('btnSearch').addEventListener('click', open);
  $('btnSearchClose').addEventListener('click', () => $('dlgSearch').close());
  $('searchQ').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  $('searchQ').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); open(); } });

  KK.search = { open };
})();
