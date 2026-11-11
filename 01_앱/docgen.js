'use strict';
/* 끄적노트 — 회의록 파일 만들기: 한글(HWPX) · Word(DOCX) · 인쇄/PDF용 화면. 외부 라이브러리 없이 만든다.
   양식: 「회의록(원외 & 원내 협의체)」 결재란 없는 판 — 회의명 / 일시·장소 / 참석자 / (핵심요약) / 내용 / (결정사항) / (향후조치) / 첨부자료 */
window.KK = window.KK || {};

(function () {
  const enc = new TextEncoder();

  /* ---------- ZIP (압축 없이 묶기) ---------- */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    const d = new Date();
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
    let p = 0;
    for (const b of all) { out.set(b, p); p += b.length; }
    return out;
  }

  /* ---------- 공통 ---------- */
  const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/\s+/g, ' ').trim();
  const esc = s => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const list = a => (Array.isArray(a) ? a : []).map(clean).filter(Boolean);

  function docTitle(m) {
    const t = clean(m.title);
    return !t ? '회의록' : /회의록$/.test(t) ? t : t + ' 회의록';
  }
  function fileBase(m, ymd) {
    const t = clean(m.title).replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(ymd || '') ? ymd.slice(2).replace(/-/g, '') + '_' : '';
    return d + (t ? t + (/회의록$/.test(t) ? '' : '_회의록') : '회의록');
  }

  /* 회의록 → 표의 줄. 문단 종류: t 보통 · h 안건 제목 · b1 ○ 항목 · b2 - 세부 */
  function rows(m) {
    const P = (k, text) => ({ k, text: clean(text) });
    const R = [];
    R.push({ label: '회의명', paras: [P('t', m.title)] });
    R.push({ label: '일  시', paras: [P('t', m.when)], label2: '장  소', paras2: [P('t', m.place)] });
    R.push({ label: '참석자', paras: [P('t', m.attendees)] });
    const sum = list(m.summary);
    if (sum.length) R.push({ label: '핵심요약', paras: sum.map(s => P('b1', s)) });
    const body = [];
    let no = 0;
    (m.agenda || []).forEach(a => {
      if (clean(a.title)) body.push(P('h', (++no) + '. ' + clean(a.title)));
      (a.points || []).forEach(p => {
        if (clean(p.text)) body.push(P('b1', p.text));
        list(p.subs).forEach(s => body.push(P('b2', s)));
      });
    });
    R.push({ label: '내  용', paras: body.length ? body : [P('t', '')] });
    const dec = list(m.decisions);
    if (dec.length) R.push({ label: '결정사항', paras: dec.map(s => P('b1', s)) });
    const act = list(m.actions);
    if (act.length) R.push({ label: '향후조치', paras: act.map(s => P('b1', s)) });
    const att = list(m.attachments);
    R.push({ label: '첨부자료', paras: att.length ? att.map(s => P('t', s)) : [P('t', '-')] });
    return R;
  }
  const mark = p => (p.k === 'b1' ? '○ ' : p.k === 'b2' ? '- ' : '') + p.text;

  /* ---------- 한글(HWPX) ---------- */
  // 양식의 글자 모양: 8 맑은 고딕 11pt · 11 같은 글꼴 굵게 · 10 제목 / 문단 모양: 19 가운데 · 20 보통 · 21 ○ 내어쓰기 · 22 - 내어쓰기 · 23 위 간격
  const HW = { label: 4982, val: 44646, val1: 19832, label2: 5049, val2: 19765, total: 49628, rowH: 282 };
  function hp(para, char, text) {
    return '<hp:p id="0" paraPrIDRef="' + para + '" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' +
      (text ? '<hp:run charPrIDRef="' + char + '"><hp:t>' + esc(text) + '</hp:t></hp:run>' : '<hp:run charPrIDRef="' + char + '"/>') + '</hp:p>';
  }
  function hParas(paras) {
    return paras.map((p, i) => {
      if (p.k === 'h') return hp(i ? 23 : 20, 11, p.text);
      if (p.k === 'b1') return hp(21, 8, mark(p));
      if (p.k === 'b2') return hp(22, 8, mark(p));
      return hp(20, 8, p.text);
    }).join('');
  }
  function hCell(col, row, span, width, bf, inner, content) {
    // 이름 칸은 양식대로 표 안 여백(좌우 1mm), 내용 칸은 좌우 2mm
    return '<hp:tc name="" header="0" hasMargin="' + (content ? 1 : 0) + '" protect="0" editable="0" dirty="0" borderFillIDRef="' + bf + '">' +
      '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
      inner + '</hp:subList><hp:cellAddr colAddr="' + col + '" rowAddr="' + row + '"/><hp:cellSpan colSpan="' + span + '" rowSpan="1"/>' +
      '<hp:cellSz width="' + width + '" height="' + HW.rowH + '"/><hp:cellMargin left="' + (content ? 567 : 510) + '" right="' + (content ? 567 : 510) + '" top="' + (content ? 425 : 141) + '" bottom="' + (content ? 425 : 141) + '"/></hp:tc>';
  }
  function hwpxSection(m) {
    const T = KK.hwpxTpl, R = rows(m), n = R.length;
    let trs = '';
    R.forEach((r, i) => {
      const first = i === 0, last = i === n - 1;
      // 테두리: 바깥 0.4mm · 안쪽 0.12mm (양식의 칸 모양 번호)
      const lb = first ? 6 : last ? 11 : 9, vb = first ? 8 : last ? 12 : 10;
      let tr = hCell(0, i, 1, HW.label, lb, hp(19, 8, r.label));
      if (r.label2) {
        tr += hCell(1, i, 1, HW.val1, first ? 7 : last ? 14 : 3, hParas(r.paras), true) +
          hCell(2, i, 1, HW.label2, 5, hp(19, 8, r.label2)) +
          hCell(3, i, 1, HW.val2, vb, hParas(r.paras2), true);
      } else tr += hCell(1, i, 3, HW.val, vb, hParas(r.paras), true);
      trs += '<hp:tr>' + tr + '</hp:tr>';
    });
    const open = T.mainTblOpen.replace(/rowCnt="\d+"/, 'rowCnt="' + n + '"').replace(/ id="\d+"/, ' id="1231654590"').replace(/zOrder="\d+"/, 'zOrder="1"');
    const sz = '<hp:sz width="' + HW.total + '" widthRelTo="ABSOLUTE" height="' + (HW.rowH * n) + '" heightRelTo="ABSOLUTE" protect="0"/>';
    const title = T.titleTbl.replace('{{TITLE}}', esc(docTitle(m)));
    const P0 = '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">';
    return T.secOpen +
      P0 + T.secPrRun + '<hp:run charPrIDRef="6">' + title + '<hp:t/></hp:run></hp:p>' +
      P0 + '<hp:run charPrIDRef="6">' + open + sz + T.mainTblPos + T.mainTblOut + T.mainTblIn + trs + '</hp:tbl><hp:t/></hp:run></hp:p>' +
      '</hs:sec>';
  }
  function hwpx(m) {
    const T = KK.hwpxTpl;
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const hpf = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' + T.hpfOpen.replace(/^<\?xml[^>]*>/, '') +
      '<opf:metadata><opf:title>' + esc(docTitle(m)) + '</opf:title><opf:language>ko</opf:language>' +
      '<opf:meta name="creator" content="text">끄적노트</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/>' +
      '<opf:meta name="lastsaveby" content="text">끄적노트</opf:meta><opf:meta name="CreatedDate" content="text">' + now + '</opf:meta>' +
      '<opf:meta name="ModifiedDate" content="text">' + now + '</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata>' +
      '<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
      '<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>' +
      '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>';
    return zip([
      { name: 'mimetype', data: 'application/hwp+zip' },
      { name: 'version.xml', data: T.version },
      { name: 'Contents/header.xml', data: T.header },
      { name: 'Contents/section0.xml', data: hwpxSection(m) },
      { name: 'Preview/PrvText.txt', data: text(m).slice(0, 1000) },
      { name: 'settings.xml', data: T.settings },
      { name: 'META-INF/container.rdf', data: T.rdf },
      { name: 'Contents/content.hpf', data: hpf },
      { name: 'META-INF/container.xml', data: T.container },
      { name: 'META-INF/manifest.xml', data: T.manifest },
    ]);
  }

  /* ---------- Word(DOCX) ---------- */
  // 한글 양식과 같은 크기: A4, 여백 15mm, 표 폭 175mm (1 twip = 한글 단위 5)
  const DW = { label: 996, val1: 3966, label2: 1010, val2: 3954 };
  DW.val = DW.val1 + DW.label2 + DW.val2;
  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  function wp(p, first) {
    let ppr = '', rpr = '';
    if (p.k === 'h') { ppr = first ? '' : '<w:spacing w:before="120"/>'; rpr = '<w:b/><w:bCs/>'; }
    else if (p.k === 'b1') ppr = '<w:ind w:left="300" w:hanging="300"/>';
    else if (p.k === 'b2') ppr = '<w:ind w:left="470" w:hanging="170"/>';
    else if (p.k === 'label') ppr = '<w:jc w:val="center"/>';
    return '<w:p><w:pPr><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/>' + ppr + '</w:pPr>' +
      (p.text ? '<w:r>' + (rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + esc(p.k === 'label' ? p.text : mark(p)) + '</w:t></w:r>' : '') + '</w:p>';
  }
  function wCell(width, span, paras, label, edges) {
    const bd = edges ? '<w:tcBorders>' + edges + '</w:tcBorders>' : '';
    return '<w:tc><w:tcPr><w:tcW w:w="' + width + '" w:type="dxa"/>' + (span > 1 ? '<w:gridSpan w:val="' + span + '"/>' : '') + bd +
      (label ? '<w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/><w:tcMar><w:left w:w="28" w:type="dxa"/><w:right w:w="28" w:type="dxa"/></w:tcMar>'
        : '<w:tcMar><w:top w:w="85" w:type="dxa"/><w:left w:w="113" w:type="dxa"/><w:bottom w:w="85" w:type="dxa"/><w:right w:w="113" w:type="dxa"/></w:tcMar>') +
      '<w:vAlign w:val="center"/></w:tcPr>' + paras + '</w:tc>';
  }
  function docxBody(m) {
    const R = rows(m);
    const B = (side, sz) => '<w:' + side + ' w:val="single" w:sz="' + sz + '" w:space="0" w:color="000000"/>';
    let trs = '';
    R.forEach(r => {
      const label = t => wp({ k: 'label', text: t });
      const paras = ps => ps.map((p, i) => wp(p, i === 0)).join('');
      let tr = '<w:tr><w:trPr><w:trHeight w:val="454"/></w:trPr>' + wCell(DW.label, 1, label(r.label), true);
      if (r.label2) tr += wCell(DW.val1, 1, paras(r.paras)) + wCell(DW.label2, 1, label(r.label2), true) + wCell(DW.val2, 1, paras(r.paras2));
      else tr += wCell(DW.val, 3, paras(r.paras));
      trs += tr + '</w:tr>';
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + W_NS + '><w:body>' +
      '<w:p><w:pPr><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/><w:spacing w:after="300"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr><w:t xml:space="preserve">' + esc(docTitle(m)) + '</w:t></w:r></w:p>' +
      '<w:tbl><w:tblPr><w:tblW w:w="' + (DW.label + DW.val) + '" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders>' +
      B('top', 9) + B('left', 9) + B('bottom', 9) + B('right', 9) + B('insideH', 4) + B('insideV', 4) +
      '</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="' + DW.label + '"/><w:gridCol w:w="' + DW.val1 + '"/><w:gridCol w:w="' + DW.label2 + '"/><w:gridCol w:w="' + DW.val2 + '"/></w:tblGrid>' +
      trs + '</w:tbl><w:p/>' +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="850" w:header="425" w:footer="425" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>';
  }
  function docx(m) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const F = '맑은 고딕';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + W_NS + '>' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="' + F + '" w:eastAsia="' + F + '" w:hAnsi="' + F + '" w:cs="' + F + '"/>' +
      '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/><w:spacing w:after="0" w:line="252" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/></w:pPr></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="a1"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>' +
      '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      '</w:styles>';
    return zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' },
      { name: 'word/document.xml', data: docxBody(m) },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>' + esc(docTitle(m)) + '</dc:title><dc:creator>끄적노트</dc:creator>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>' },
      { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>끄적노트</Application></Properties>' },
    ]);
  }

  /* ---------- 미리보기·인쇄(PDF)용 화면 ---------- */
  function html(m) {
    const para = p => '<p class="' + p.k + '">' + esc(mark(p)) + '</p>';
    const R = rows(m);
    const trs = R.map(r => '<tr><th>' + esc(r.label) + '</th>' + (r.label2
      ? '<td>' + r.paras.map(para).join('') + '</td><th>' + esc(r.label2) + '</th><td>' + r.paras2.map(para).join('') + '</td>'
      : '<td colspan="3">' + r.paras.map(para).join('') + '</td>') + '</tr>').join('');
    return '<div class="mdoc"><h1>' + esc(docTitle(m)) + '</h1><table><colgroup><col style="width:10%"><col style="width:40%"><col style="width:10.2%"><col style="width:39.8%"></colgroup>' +
      trs + '</table></div>';
  }

  /* ---------- 고쳐 쓰기용 글 ↔ 회의록 ---------- */
  function text(m) {
    const L = ['# 핵심요약'];
    list(m.summary).forEach(s => L.push('○ ' + s));
    L.push('', '# 내용');
    let no = 0;
    (m.agenda || []).forEach(a => {
      if (clean(a.title)) L.push((++no) + '. ' + clean(a.title));
      (a.points || []).forEach(p => { if (clean(p.text)) L.push('○ ' + clean(p.text)); list(p.subs).forEach(s => L.push('- ' + s)); });
    });
    L.push('', '# 결정사항');
    list(m.decisions).forEach(s => L.push('○ ' + s));
    L.push('', '# 향후조치');
    list(m.actions).forEach(s => L.push('○ ' + s));
    L.push('', '# 첨부자료');
    list(m.attachments).forEach(s => L.push(s));
    return L.join('\n');
  }
  const SECTION = { 핵심요약: 'summary', 요약: 'summary', 내용: 'agenda', 결정사항: 'decisions', 향후조치: 'actions', 첨부자료: 'attachments' };
  function fromText(src, m) {
    const out = Object.assign({}, m, { summary: [], agenda: [], decisions: [], actions: [], attachments: [] });
    const strip = s => s.replace(/^([○●◦•·▪*]|-|–|—)\s*/, '').trim();
    let cur = null, ag = null, pt = null;
    String(src || '').split('\n').forEach(raw => {
      const line = raw.trim();
      if (!line) return;
      const h = line.match(/^#\s*(.+)$/);
      if (h) { cur = SECTION[h[1].replace(/\s+/g, '')] || null; ag = pt = null; return; }
      if (!cur) return;
      if (cur === 'agenda') {
        const num = line.match(/^\d+[.)]\s*(.*)$/);
        if (num) { ag = { title: num[1].trim(), points: [] }; out.agenda.push(ag); pt = null; return; }
        if (!ag) { ag = { title: '', points: [] }; out.agenda.push(ag); }
        if (/^(-|–|—)/.test(line) && pt) { pt.subs.push(strip(line)); return; }
        pt = { text: strip(line), subs: [] };
        ag.points.push(pt);
      } else if (cur === 'attachments') out.attachments.push(line === '-' ? '' : strip(line));
      else out[cur].push(strip(line));
    });
    out.attachments = out.attachments.filter(Boolean);
    return out;
  }

  KK.docgen = { zip, crc32, rows, docTitle, fileBase, hwpx, docx, html, text, fromText };
})();
