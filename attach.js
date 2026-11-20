'use strict';
/* 끄적노트 — 관련 자료 붙이기
   - 노트에 파일(PDF·사진·한글 hwpx·워드 docx·파워포인트 pptx·엑셀 xlsx·글)을 붙여 둔다. 노트 본문에는 보이지 않는다.
   - 붙일 때 글자를 뽑아 두고(text), 질문할 때 Claude가 함께 읽는다(ask.js). PDF·사진은 파일째 보낸다.
   - 문서 종류 'att' (Blob 그대로 putRaw). 백업에는 넣지 않는다(용량). */
window.KK = window.KK || {};

(function () {
  const { $, h, svg, toast } = KK.ui;
  const D = KK.date, db = KK.db;
  const A = () => KK.app;
  const CLIP = '<path d="M20 11.5l-8.3 8.3a5 5 0 01-7.1-7.1l8.6-8.6a3.4 3.4 0 014.8 4.8l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9"/>';
  const MAX_FILE = 30 * 1024 * 1024, MAX_TEXT = 200000;
  const fmtSize = b => (b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB');
  const ext = name => ((name || '').split('.').pop() || '').toLowerCase();

  /* ---------- 종류 ---------- */
  const IMG = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  function kindOf(name, type) {
    const e = ext(name);
    if (type === 'application/pdf' || e === 'pdf') return 'pdf';
    if (IMG.includes(type) || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(e)) return 'image';
    if (['docx', 'hwpx', 'pptx', 'xlsx'].includes(e)) return e;
    if (e === 'hwp') return 'hwp';
    if ((type || '').startsWith('text/') || ['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm'].includes(e)) return 'text';
    return 'other';
  }
  const KIND_KO = { pdf: 'PDF', image: '사진', docx: '워드', hwpx: '한글', pptx: '파워포인트', xlsx: '엑셀', hwp: '한글(hwp)', text: '글', other: '파일' };
  // 질문할 때 Claude가 읽을 수 있는지
  const readable = a => a.kind === 'pdf' || a.kind === 'image' || !!(a.text && a.text.trim());

  /* ---------- 압축 파일(docx·hwpx·pptx·xlsx)에서 글자 뽑기 ---------- */
  async function inflate(u8) {
    const ds = new DecompressionStream('deflate-raw');
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
  }
  async function unzip(buf, want) {
    const v = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out = new Map();
    for (let k = 0; k < count && v.getUint32(p, true) === 0x02014b50; k++) {
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (!want(name)) continue;
      const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      const data = u8.subarray(start, start + csize);
      try { out.set(name, dec.decode(method === 0 ? data : method === 8 ? await inflate(data) : new Uint8Array())); } catch (e) { /* 그 조각만 건너뜀 */ }
    }
    return out;
  }
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unxml = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] || m));
  const num = n => +((n.match(/(\d+)\.xml$/) || [0, 0])[1]);
  function xmlText(xml, para, tab) {
    return unxml(xml.replace(tab, '\t').replace(para, '\n').replace(/<[^>]+>/g, ''))
      .split('\n').map(l => l.replace(/[ \t]+$/, '')).filter((l, i, a) => l || (a[i - 1] || '')).join('\n').trim();
  }
  async function extract(file, kind) {
    if (kind === 'text') return (await file.text()).slice(0, MAX_TEXT);
    if (!['docx', 'hwpx', 'pptx', 'xlsx'].includes(kind) || !('DecompressionStream' in window)) return '';
    const buf = await file.arrayBuffer();
    if (kind === 'docx') {
      const m = await unzip(buf, n => n === 'word/document.xml');
      return xmlText(m.get('word/document.xml') || '', /<\/w:p>/g, /<w:tab\/>/g).slice(0, MAX_TEXT);
    }
    if (kind === 'hwpx') {
      const m = await unzip(buf, n => /^Contents\/section\d+\.xml$/.test(n));
      return [...m.keys()].sort((a, b) => num(a) - num(b)).map(k => xmlText(m.get(k), /<\/hp:p>/g, /<hp:tab[^>]*\/>/g)).join('\n\n').slice(0, MAX_TEXT);
    }
    if (kind === 'pptx') {
      const m = await unzip(buf, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      return [...m.keys()].sort((a, b) => num(a) - num(b)).map((k, i) => '[' + (i + 1) + '쪽]\n' + xmlText(m.get(k), /<\/a:p>/g, /<a:tab\/>/g)).join('\n\n').slice(0, MAX_TEXT);
    }
    // xlsx: 칸 안 글자만 (숫자 칸은 빠질 수 있음)
    const m = await unzip(buf, n => n === 'xl/sharedStrings.xml');
    return xmlText((m.get('xl/sharedStrings.xml') || '').replace(/<\/si>/g, '</si>\n'), /<\/si>/g, /<tab\/>/g).slice(0, MAX_TEXT);
  }

  /* ---------- 저장 ---------- */
  async function all() { return db.usingFallback ? [] : (await db.all()).filter(d => d.kind === 'att'); }
  async function listFor(noteIds) {
    const ids = new Set(noteIds);
    return (await all()).filter(a => ids.has(a.noteId)).sort((a, b) => a.createdAt - b.createdAt);
  }
  async function addFiles(files) {
    if (db.usingFallback) { toast('이 브라우저에서는 자료를 저장할 수 없어요.'); return; }
    const n = A().ensureNote();
    let ok = 0;
    const skipped = [];
    for (const f of files) {
      if (!f || !f.size) continue;
      if (f.size > MAX_FILE) { skipped.push(f.name + '(30MB 초과)'); continue; }
      const kind = kindOf(f.name, f.type);
      let text = '';
      try { text = await extract(f, kind); } catch (e) { text = ''; }
      const doc = { id: 'att-' + KK.uid(), kind: 'att', noteId: n.id, name: f.name || '자료', type: f.type || '', size: f.size, ftype: kind, createdAt: Date.now(), text, blob: f };
      try { await db.putRaw(doc); ok++; } catch (e) { skipped.push(f.name); }
    }
    await refresh();
    if (ok) toast('자료 ' + ok + '개를 이 노트에 붙였어요 · 질문할 때 Claude가 함께 읽어요' + (skipped.length ? ' (못 붙인 파일 ' + skipped.length + '개)' : ''), null, null, 6000);
    else if (skipped.length) toast('붙이지 못했어요: ' + skipped.join(', '), null, null, 6000);
    if ($('dlgAtt').open) renderList();
  }

  /* ---------- 쓰기 화면 버튼의 개수 ---------- */
  async function refresh() {
    const cur = A().S.cur;
    const n = cur ? (await listFor([cur])).length : 0;
    $('attCnt').textContent = n ? String(n) : '';
    $('btnAtt').setAttribute('aria-label', n ? '이 노트에 붙인 자료 ' + n + '개' : '관련 자료 붙이기');
  }

  /* ---------- 자료 창 ---------- */
  let urls = [];
  async function open() {
    const S = A().S, n = S.cur ? S.notes.get(S.cur) : null;
    $('aHead').textContent = '관련 자료' + (n ? ' · ' + KK.views.noteLabel(n) : '');
    await renderList();
    if (!$('dlgAtt').open) { $('dlgAtt').showModal(); $('aHead').focus(); }
  }
  async function renderList() {
    urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
    const S = A().S, box = $('aList');
    const list = S.cur ? await listFor([S.cur]) : [];
    box.textContent = '';
    if (!list.length) { box.append(h('li', { class: 'wempty' }, '아직 붙인 자료가 없어요. 회의자료·공문·사진 등을 붙여 두면, 질문할 때 Claude가 함께 읽어요.')); return; }
    list.forEach(a => {
      const k = a.ftype || kindOf(a.name, a.type);
      const note = k === 'hwp' ? '읽을 수 없음 — 한글에서 .hwpx나 PDF로 저장해 붙여 주세요'
        : k === 'other' ? '읽을 수 없는 형식(보관만)'
          : (k === 'pdf' || k === 'image') ? '질문할 때 파일째 읽음'
            : (a.text && a.text.trim()) ? '글자 ' + a.text.length.toLocaleString() + '자 읽음' : '글자를 찾지 못함';
      box.append(h('li', { class: 'arow' },
        h('span', { class: 'akind' }, KIND_KO[k] || '파일'),
        h('div', { class: 'amain' }, h('span', { class: 'at' }, a.name), h('span', { class: 'am' }, fmtSize(a.size) + ' · ' + D.stamp(a.createdAt) + ' · ' + note)),
        h('button', { type: 'button', class: 'btn', onclick: () => openFile(a) }, '열기'),
        h('button', { type: 'button', class: 'btn ghost', 'aria-label': a.name + ' 지우기', onclick: () => remove(a) }, '지우기')));
    });
  }
  async function openFile(a) {
    const file = new File([a.blob], a.name, { type: a.type || a.blob.type || 'application/octet-stream' });
    // 태블릿: 공유 창으로 알맞은 앱(PDF 보기·한컴오피스 등)에서 열기
    if (KK.voice && KK.voice.isAndroid && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: a.name }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file); urls.push(url);
    const w = window.open(url, '_blank', 'noopener');
    if (!w) { const link = h('a', { href: url, download: a.name }); document.body.append(link); link.click(); link.remove(); }
  }
  async function remove(a) {
    await db.del(a.id);
    await refresh(); renderList();
    toast('「' + a.name + '」을(를) 뺐어요', '되돌리기', async () => { await db.putRaw(a); await refresh(); if ($('dlgAtt').open) renderList(); });
  }

  $('btnAtt').addEventListener('click', open);
  $('aClose').addEventListener('click', () => $('dlgAtt').close());
  $('aAdd').addEventListener('click', () => { $('aFile').value = ''; $('aFile').click(); });
  $('aFile').addEventListener('change', e => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) addFiles(fs); });
  $('btnAtt').querySelector('svg') || $('btnAtt').prepend(svg(CLIP));

  KK.attach = { listFor, refresh, open, addFiles, readable, kindOf, KIND_KO, extract };
})();
