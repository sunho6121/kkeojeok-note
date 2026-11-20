'use strict';
/* 끄적노트 — 녹음 보내기: 녹음 파일·녹취 글·회의록을 골라 메일·카카오톡·드라이브 등 다른 앱으로 (Web Share).
   공유 창이 받지 않는 형식(기기마다 다름)은 고를 수 없게 하고, 어디서나 '파일로 받기'는 된다. */
(function () {
  const { $, h, toast } = KK.ui;
  const D = KK.date;
  const MAIL_WARN = 20 * 1048576, SHARE_MAX_FILES = 10;
  const fmtSize = b => (b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB');
  const durText = s => { s = Math.round(s || 0); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60); return hh ? hh + '시간 ' + mm + '분' : mm ? mm + '분' : s + '초'; };
  const safe = s => String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '-').trim().slice(0, 80) || '녹음';
  const startOf = r => r.startAt || r.createdAt;
  const recName = r => r.name || '녹음 ' + D.stamp(startOf(r));
  const whenText = r => { const d = new Date(startOf(r)); return (d.getMonth() + 1) + '/' + d.getDate() + '(' + D.DOW[d.getDay()] + ') ' + D.pad(d.getHours()) + ':' + D.pad(d.getMinutes()); };
  const ymd = r => D.ymd(new Date(startOf(r)));

  /* ---------- 보낼 파일 만들기 ---------- */
  function audioFile(r) {
    if (!r.blob) return null;
    const mime = String(r.mime || r.blob.type || '');
    const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /mpeg|mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : 'webm';
    const type = { m4a: 'audio/mp4', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm' }[ext];
    return new File([r.blob], safe(recName(r)) + '.' + ext, { type });
  }
  function transcriptFile(r) {
    const t = (r.text || '').trim();
    if (!t) return null;
    return new File([recName(r) + ' · ' + whenText(r) + '\n\n' + t + '\n'], safe(recName(r)) + '_녹취.txt', { type: 'text/plain' });
  }
  // 회의록 창에서 고친 회의명·일시·장소·참석자(mmeta)를 반영 (minutes.js docModel과 같은 방식)
  function minutesModel(r) {
    if (!r.minutes) return null;
    const mm = r.mmeta || {}, m = r.minutes;
    return Object.assign({}, m, { title: mm.title || m.title, when: 'when' in mm ? mm.when : m.when, place: 'place' in mm ? mm.place : m.place, attendees: 'attendees' in mm ? mm.attendees : m.attendees });
  }
  function minutesFile(r, fmt) {
    const m = minutesModel(r), G = KK.docgen;
    if (!m || !G) return null;
    const base = G.fileBase(m, ymd(r));
    if (fmt === 'hwpx') return new File([G.hwpx(m)], base + '.hwpx', { type: 'application/hwp+zip' });
    if (fmt === 'docx') return new File([G.docx(m)], base + '.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const head = [G.docTitle(m), m.when ? '일시: ' + m.when : '', m.place ? '장소: ' + m.place : '', m.attendees ? '참석자: ' + m.attendees : ''].filter(Boolean);
    return new File([head.join('\n') + '\n\n' + G.text(m) + '\n'], base + '.txt', { type: 'text/plain' });
  }

  /* 이 기기의 공유 창이 받는 형식인지 (Chrome은 형식마다 허용 목록이 있음) */
  const canShareCache = {};
  function shareable(name, type) {
    const ext = name.split('.').pop();
    if (ext in canShareCache) return canShareCache[ext];
    let ok = false;
    try { ok = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File(['x'], 'a.' + ext, { type })] })); } catch (e) { ok = false; }
    return (canShareCache[ext] = ok);
  }
  const hasShare = () => !!(navigator.share && navigator.canShare);

  /* ---------- 창 ---------- */
  const KINDS = [
    { k: 'audio', label: '녹음 파일', has: r => !!r.blob, ext: r => audioFile(r) },
    { k: 'text', label: '녹취 글 (.txt)', has: r => !!(r.text || '').trim(), ext: transcriptFile },
    { k: 'hwpx', label: '회의록 한글 (.hwpx)', has: r => !!r.minutes, ext: r => minutesFile(r, 'hwpx'), probe: ['a.hwpx', 'application/hwp+zip'] },
    { k: 'docx', label: '회의록 Word (.docx)', has: r => !!r.minutes, ext: r => minutesFile(r, 'docx'), probe: ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
    { k: 'mtxt', label: '회의록 글 (.txt)', has: r => !!r.minutes, ext: r => minutesFile(r, 'txt') },
  ];
  let recs = [], picks = new Set(), bodyDirty = false, subjDirty = false;

  function blockedKind(K) {
    if (!hasShare()) return false; // 공유 창이 없으면 어차피 '파일로 받기'
    if (K.probe) return !shareable(K.probe[0], K.probe[1]);
    if (K.k === 'audio') return recs.some(r => { const f = r.blob && audioFile(r); return f && !shareable(f.name, f.type); });
    return !shareable('a.txt', 'text/plain');
  }
  function files(forShare) {
    const out = [];
    recs.forEach(r => KINDS.forEach(K => {
      if (!picks.has(K.k) || !K.has(r)) return;
      if (forShare && blockedKind(K)) return;
      try { const f = K.ext(r); if (f) out.push(f); } catch (e) { /* 만들지 못한 파일은 건너뜀 */ }
    }));
    return out;
  }
  function sizeOf(kind) { // 녹음 파일 크기만 정확히, 나머지는 작음
    return recs.reduce((s, r) => s + (kind === 'audio' && r.blob ? (r.size || r.blob.size || 0) : 0), 0);
  }

  function defaultSubject() {
    const first = recs[0], m = minutesModel(first);
    const name = (picks.has('hwpx') || picks.has('docx') || picks.has('mtxt')) && m ? KK.docgen.docTitle(m) : (m && m.title) || recName(first);
    const d = new Date(startOf(first));
    return name + ' (' + (d.getMonth() + 1) + '/' + d.getDate() + ')' + (recs.length > 1 ? ' 외 ' + (recs.length - 1) + '건' : '');
  }
  function defaultBody() {
    const L = [];
    recs.forEach(r => {
      const m = minutesModel(r);
      const what = KINDS.filter(K => picks.has(K.k) && K.has(r)).map(K => K.k === 'audio' ? '녹음' + (r.duration ? ' ' + durText(r.duration) : '') : K.k === 'text' ? '녹취 글' : '회의록').filter((x, i, a) => a.indexOf(x) === i);
      L.push('○ ' + ((m && m.title) || recName(r)) + ' — ' + whenText(r) + (what.length ? ' · ' + what.join(', ') : ''));
    });
    const m = recs.length === 1 && minutesModel(recs[0]);
    if (m && (picks.has('hwpx') || picks.has('docx') || picks.has('mtxt')) && (m.summary || []).length) {
      L.push('', '[핵심요약]');
      m.summary.forEach(s => { if (String(s || '').trim()) L.push('- ' + String(s).trim()); });
    }
    return L.join('\n');
  }

  function render() {
    const box = $('shItems'); box.textContent = '';
    KINDS.forEach(K => {
      const n = recs.filter(K.has).length;
      if (!n) return;
      const blocked = blockedKind(K);
      if (blocked) picks.delete(K.k);
      const sz = K.k === 'audio' ? ' · ' + fmtSize(sizeOf('audio')) : '';
      const cnt = recs.length > 1 ? ' ' + n + '개' : '';
      const cb = h('input', { type: 'checkbox', checked: picks.has(K.k), disabled: blocked, onchange: e => { if (e.target.checked) picks.add(K.k); else picks.delete(K.k); update(); } });
      box.append(h('label', { class: 'chkrow' + (blocked ? ' off' : '') }, cb, h('span', null, K.label + cnt + sz,
        blocked ? h('small', null, ' — 이 기기의 공유 창으로는 못 보내요. 회의록 보기에서 내려받아 첨부해 주세요') : null)));
    });
    update();
  }
  function update() {
    if (!subjDirty) $('shSubj').value = defaultSubject();
    if (!bodyDirty) $('shBody').value = defaultBody();
    const all = files(false), sendable = hasShare() ? files(true) : [];
    const total = all.reduce((s, f) => s + f.size, 0);
    const warn = [];
    if (total > MAIL_WARN) warn.push('합계 ' + fmtSize(total) + ' — 메일 첨부 한도(보통 25MB)를 넘을 수 있어요. Gmail은 드라이브 링크로 바꿔 보내고, 다른 메일 앱은 못 보낼 수 있어요. 카카오톡·드라이브로 보내거나 나눠 보내세요.');
    if (sendable.length > SHARE_MAX_FILES) warn.push('한 번에 ' + SHARE_MAX_FILES + '개까지 보낼 수 있어요. 나눠서 보내 주세요.');
    $('shSum').textContent = all.length ? '보낼 파일 ' + all.length + '개 · ' + fmtSize(total) : '보낼 것을 골라 주세요';
    $('shWarn').textContent = warn.join(' ');
    $('shWarn').hidden = !warn.length;
    $('shGo').hidden = !hasShare();
    $('shGo').disabled = !sendable.length || sendable.length > SHARE_MAX_FILES;
    $('shDl').disabled = !all.length;
    $('shNoShare').hidden = hasShare();
  }

  function open(list, opt) {
    recs = (list || []).filter(r => r && !r.draft);
    if (!recs.length) { toast('보낼 녹음이 없어요'); return; }
    opt = opt || {};
    picks = new Set();
    if (opt.minutes && recs.some(r => r.minutes)) {
      ['hwpx', 'docx', 'mtxt'].some(k => { const K = KINDS.find(x => x.k === k); if (!blockedKind(K)) { picks.add(k); return true; } return false; });
    } else if (recs.some(r => r.blob)) picks.add('audio');
    else if (recs.some(r => (r.text || '').trim())) picks.add('text');
    bodyDirty = subjDirty = false;
    $('shHead').textContent = recs.length > 1 ? '녹음 ' + recs.length + '개 보내기' : '「' + recName(recs[0]) + '」 보내기';
    render();
    $('dlgShare').showModal();
  }

  async function go() {
    const fs = files(true);
    if (!fs.length) return;
    const title = $('shSubj').value.trim(), text = $('shBody').value.trim();
    let data = { files: fs, title, text };
    if (!navigator.canShare(data)) data = { files: fs };
    try {
      await navigator.share(data);
      $('dlgShare').close();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('공유 창을 열지 못했어요(파일이 너무 크거나 이 형식은 못 보낼 수 있어요). 파일로 받기로 저장한 뒤 메일에 첨부해 주세요.', null, null, 9000);
    }
  }
  function saveAll() {
    const fs = files(false);
    fs.forEach((f, i) => setTimeout(() => {
      const url = URL.createObjectURL(f), a = document.createElement('a');
      a.href = url; a.download = f.name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, i * 400)); // 한꺼번에 받으면 브라우저가 막을 때가 있어 조금씩
    $('dlgShare').close();
    toast(fs.length === 1 ? '「' + fs[0].name + '」을(를) 다운로드 폴더에 저장했어요' : '파일 ' + fs.length + '개를 다운로드 폴더에 저장했어요', null, null, 6000);
  }

  $('shSubj').addEventListener('input', () => { subjDirty = true; });
  $('shBody').addEventListener('input', () => { bodyDirty = true; });
  $('shGo').addEventListener('click', go);
  $('shDl').addEventListener('click', saveAll);
  $('shCancel').addEventListener('click', () => $('dlgShare').close());

  KK.recshare = { open, audioFile };
})();
