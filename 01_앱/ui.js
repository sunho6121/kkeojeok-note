'use strict';
/* 끄적노트 — 화면 도우미 (요소 만들기, 아이콘, 알림, 상태 이름) */
window.KK = window.KK || {};

(function () {
  const $ = id => document.getElementById(id);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
    return el;
  }

  function svg(path) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = path; return s;
  }

  const ICON = {
    check: '<path d="M5 12l5 5 9-10" stroke-width="3"/>',
    plus: '<path d="M12 5v14M5 12h14" stroke-width="2"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4M12 13v4M10 15h4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    note: '<path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3"/>',
  };

  let toastTimer;
  function toast(text, btnLabel, fn, ms) {
    const t = $('toast'), b = $('toastBtn');
    $('toastText').textContent = text;
    b.hidden = !btnLabel; b.textContent = btnLabel || '';
    b.onclick = () => { t.hidden = true; fn && fn(); };
    t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || (btnLabel ? 6000 : 3500));
  }

  /* 상태: 저장되는 값 5개 + 기한이 지난 '미완결'은 화면에서 계산 */
  const STATUS = {
    todo: '예정', doing: '진행중', hold: '보류', done: '완결', cancel: '취소',
  };
  const OPEN = ['todo', 'doing'];

  function viewStatus(it, today) {
    const s = it.status || 'todo';
    if (OPEN.includes(s) && it.date && it.date < today) {
      return it.type === 'event' && s === 'todo' ? 'past' : 'late';
    }
    return s;
  }
  const VIEW_LABEL = Object.assign({ late: '미완결', past: '지난 약속' }, STATUS);

  KK.ui = { $, h, svg, ICON, toast, STATUS, OPEN, viewStatus, VIEW_LABEL };
})();
