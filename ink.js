'use strict';
/* 끄적노트 — S Pen 필기 캔버스 (필압, 손바닥 무시, 지우개, 되돌리기) */
window.KK = window.KK || {};

(function () {
  const PAPER = { ink: '#111111', blue: '#1D3FB8', red: '#C0392B' };
  const BASE_W = 2.4;

  function screenPalette() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    return { ink: v('--ink') || '#1B2230', blue: v('--accent') || '#2346C4', red: v('--danger') || '#B93838' };
  }
  const widthAt = (p, w) => w * (0.35 + (p == null ? 0.5 : p) * 1.1);

  function drawStroke(ctx, s, pal, k) {
    k = k || 1;
    const col = pal[s.c] || pal.ink;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const pts = s.p;
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], widthAt(pts[0][2], s.w) * k / 2, 0, Math.PI * 2); ctx.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.lineWidth = widthAt(b[2], s.w) * k;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  }

  /* 필기를 흰 종이 PNG(base64)로 — Claude가 읽을 이미지 */
  KK.strokesToPNGBase64 = function (strokes) {
    if (!strokes || !strokes.length) return Promise.resolve(null);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    strokes.forEach(s => s.p.forEach(([x, y]) => {
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }));
    const pad = 28;
    const w = Math.max(1, maxX - minX) + pad * 2, h = Math.max(1, maxY - minY) + pad * 2;
    const k = Math.min(2, 1568 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, (pad - minX) * k, (pad - minY) * k);
    strokes.forEach(s => drawStroke(ctx, s, PAPER, 1));
    return new Promise(resolve => {
      const url = c.toDataURL('image/png');
      resolve(url.slice(url.indexOf(',') + 1));
    });
  };

  KK.createInk = function (canvas, opts) {
    const ctx = canvas.getContext('2d');
    const onChange = (opts && opts.onChange) || (() => {});
    let strokes = [], hist = [], color = 'ink', eraser = false, penSeen = false;
    let cur = null, activeId = null, erasing = false, erased = false, pal = screenPalette();

    function resize() {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pal = screenPalette();
      redraw();
    }
    function redraw() {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
      strokes.forEach(s => drawStroke(ctx, s, pal));
    }
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round((e.clientX - r.left) * 10) / 10, Math.round((e.clientY - r.top) * 10) / 10, Math.round(p * 100) / 100];
    }
    function snapshot() { hist.push(strokes.slice()); if (hist.length > 60) hist.shift(); }
    function eraseAt(pt) {
      const before = strokes.length;
      strokes = strokes.filter(s => !s.p.some(q => Math.hypot(q[0] - pt[0], q[1] - pt[1]) < 14));
      if (strokes.length !== before) { erased = true; redraw(); }
    }

    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'pen') penSeen = true;
      if (e.pointerType === 'touch' && penSeen) return; // S Pen을 쓰는 중이면 손바닥·손가락 무시
      if (activeId !== null) return;
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      activeId = e.pointerId;
      const pt = pos(e);
      if (eraser) { snapshot(); erasing = true; erased = false; eraseAt(pt); return; }
      cur = { c: color, w: BASE_W, p: [pt] };
      drawStroke(ctx, cur, pal);
    });
    canvas.addEventListener('pointermove', e => {
      if (e.pointerId !== activeId) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) {
        const pt = pos(ev);
        if (erasing) { eraseAt(pt); continue; }
        if (!cur) continue;
        const last = cur.p[cur.p.length - 1];
        if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.8) continue;
        cur.p.push(pt);
        drawStroke(ctx, { c: cur.c, w: cur.w, p: [last, pt] }, pal);
      }
    });
    function end(e) {
      if (e.pointerId !== activeId) return;
      activeId = null;
      if (erasing) {
        erasing = false;
        if (erased) onChange(); else hist.pop();
        return;
      }
      if (cur) { snapshot(); strokes.push(cur); cur = null; onChange(); }
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { pal = screenPalette(); redraw(); });

    return {
      resize,
      setColor(c) { color = c; eraser = false; },
      setEraser(on) { eraser = on; },
      undo() { if (!hist.length) return; strokes = hist.pop(); redraw(); onChange(); },
      clear() { if (!strokes.length) return; snapshot(); strokes = []; redraw(); onChange(); },
      reset(list) { strokes = Array.isArray(list) ? list.slice() : []; hist = []; redraw(); },
      isEmpty() { return strokes.length === 0; },
      strokes() { return strokes; },
      toPNGBase64() { return KK.strokesToPNGBase64(strokes); },
    };
  };
})();
