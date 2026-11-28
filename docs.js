'use strict';
/* 끄적노트 — 안내 문서 보기
   - 02_문서 폴더의 md 파일(사용 안내·작업 내역 등)을 배포할 때 docs/로 함께 올리고, 앱 안에서 읽는다 (04_도구/build_site.py).
   - 앱이 새 버전으로 바뀌면 한 번 알려 주고 '바뀐 점'을 바로 열 수 있게 한다. */
window.KK = window.KK || {};

(function () {
  const { $, h, toast } = KK.ui;
  let index = null, cur = 0;

  /* ---------- md → 화면 (이 앱 문서에 쓰는 문법만) ---------- */
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }
  const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
  function list(L, i) {
    const out = [], stack = [];
    while (i < L.length) {
      const l = L[i];
      if (!l.trim()) { // 빈 줄 뒤에도 목록이 이어지면 계속
        let j = i + 1; while (j < L.length && !L[j].trim()) j++;
        if (j < L.length && (LIST.test(L[j]) && /^\s+/.test(L[j]) || /^\s{2,}\S/.test(L[j]))) { i = j; continue; }
        break;
      }
      const m = l.match(LIST);
      if (m) {
        const ind = m[1].length, tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && ind < stack[stack.length - 1].ind) out.push('</li></' + stack.pop().tag + '>');
        if (!stack.length || ind > stack[stack.length - 1].ind) { out.push('<' + tag + '>'); stack.push({ ind, tag }); }
        else out.push('</li>');
        const cb = m[3].match(/^\[( |x)\]\s+(.*)$/i);
        if (cb) out.push('<li class="todo' + (cb[1] === ' ' ? '' : ' ok') + '"><span class="box">' + (cb[1] === ' ' ? '' : '✓') + '</span>' + inline(cb[2]));
        else out.push('<li>' + inline(m[3]));
        i++; continue;
      }
      if (/^\s*```/.test(l)) { // 목록 안의 코드 묶음
        const pad = l.match(/^\s*/)[0].length, buf = [];
        i++;
        while (i < L.length && !/^\s*```/.test(L[i])) buf.push(L[i++].slice(pad));
        i++; out.push('<pre>' + esc(buf.join('\n')) + '</pre>'); continue;
      }
      if (/^\s+\S/.test(l) && stack.length) { out.push(' ' + inline(l.trim())); i++; continue; }
      break;
    }
    while (stack.length) out.push('</li></' + stack.pop().tag + '>');
    return [out.join(''), i];
  }
  function render(md) {
    const L = String(md).replace(/\r\n?/g, '\n').split('\n'), out = [];
    let i = 0;
    while (i < L.length) {
      const l = L[i];
      let m;
      if (!l.trim()) { i++; continue; }
      if (/^```/.test(l)) {
        const buf = []; i++;
        while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]);
        i++; out.push('<pre>' + esc(buf.join('\n')) + '</pre>'); continue;
      }
      if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { const n = m[1].length + 1; out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>'); i++; continue; }
      if (/^-{3,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(l)) {
        const buf = []; while (i < L.length && /^>\s?/.test(L[i])) buf.push(L[i++].replace(/^>\s?/, ''));
        out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>'); continue;
      }
      if (/^\s*\|/.test(l)) {
        const rows = []; while (i < L.length && /^\s*\|/.test(L[i])) rows.push(L[i++]);
        const cells = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const body = rows.slice(/^[\s|:-]+$/.test(rows[1] || '') ? 2 : 1);
        out.push('<div class="ktable"><table><thead><tr>' + cells(rows[0]).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
          body.map(r => '<tr>' + cells(r).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (LIST.test(l)) { const [html, j] = list(L, i); out.push(html); i = j; continue; }
      const buf = [];
      while (i < L.length && L[i].trim() && !/^(#{1,4}\s|```|\s*\||-{3,}\s*$|>)/.test(L[i]) && !LIST.test(L[i])) buf.push(L[i++].trim());
      if (buf.length) out.push('<p>' + inline(buf.join(' ')) + '</p>');
      else i++;
    }
    return out.join('\n');
  }

  /* ---------- 문서 창 ---------- */
  async function load() {
    try {
      const r = await fetch('docs/index.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      index = await r.json();
    } catch (e) { /* 오프라인이면 받아 둔 것 */ }
    return index;
  }
  // which: 문서 이름 일부(예: '작업내역'), at: 그 문서에서 찾아갈 제목(예: '버전 이력')
  async function open(which, at) {
    const dlg = $('dlgDocs');
    $('dTabs').textContent = '';
    $('dBody').textContent = '불러오는 중…';
    if (!dlg.open) { dlg.showModal(); $('dHead').focus(); }
    const ix = await load();
    if (!ix || !ix.docs || !ix.docs.length) { $('dBody').textContent = '문서를 불러오지 못했어요. 인터넷에 연결된 뒤 다시 열어 주세요.'; return; }
    if (which) { const k = ix.docs.findIndex(d => d.title.includes(which)); if (k >= 0) cur = k; }
    if (cur >= ix.docs.length) cur = 0;
    show(cur, at);
  }
  function tabs() {
    const box = $('dTabs'); box.textContent = '';
    index.docs.forEach((d, k) => box.append(h('button', { type: 'button', 'aria-pressed': String(k === cur), onclick: () => show(k) }, d.title)));
  }
  async function show(k, at) {
    cur = k; tabs();
    const d = index.docs[k], box = $('dBody');
    box.textContent = '불러오는 중…';
    try {
      const r = await fetch(d.file, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      box.innerHTML = render(await r.text());
    } catch (e) { box.textContent = '이 문서를 불러오지 못했어요. 인터넷에 연결된 뒤 다시 열어 주세요.'; return; }
    const form = $('dlgDocs').querySelector('.dlg');
    form.scrollTop = 0;
    if (at) {
      const hd = [...box.querySelectorAll('h2,h3,h4,h5')].find(x => x.textContent.includes(at));
      if (hd) requestAnimationFrame(() => hd.scrollIntoView({ block: 'start' }));
    }
  }
  $('dClose').addEventListener('click', () => $('dlgDocs').close());

  /* ---------- 설정 창: 버전 · 문서 열기 ---------- */
  const ver = document.documentElement.dataset.ver || '';
  if ($('appVer')) $('appVer').textContent = ver ? '끄적노트 ' + ver : '끄적노트';
  $('btnGuide').addEventListener('click', () => { $('dlgSettings').close(); open('사용안내'); });
  $('btnWorklog').addEventListener('click', () => { $('dlgSettings').close(); open('작업내역'); });

  /* ---------- 새 버전 알림 (한 번) ---------- */
  if (ver) {
    let seen = null;
    try { seen = localStorage.getItem('kk-ver'); localStorage.setItem('kk-ver', ver); } catch (e) { /* 무시 */ }
    if (seen && seen !== ver) setTimeout(() => toast('끄적노트가 새 버전(' + ver + ')으로 바뀌었어요', '바뀐 점 보기', () => open('작업내역', '버전 이력'), 9000), 3000);
  }

  KK.docs = { open, render };
})();
