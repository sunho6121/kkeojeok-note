'use strict';
/* 끄적노트 — 받아쓰기(기기 음성 인식, 무료) · 녹음(끝나면 저장 여부 확인) · 녹음 탭 */
(function () {
  const { $, h, svg, ICON, toast } = KK.ui;
  const D = KK.date, db = KK.db;
  const A = () => KK.app;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const fmtDur = s => Math.floor(s / 60) + ':' + D.pad(s % 60);
  const fmtSize = b => (b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB');
  const defaultName = t => '녹음 ' + D.stamp(t);

  /* 진행 표시는 작성란 위쪽 한 줄에만 — 아래쪽(작성란·정리 버튼)을 가리지 않게 */
  function showBar(kind, label) {
    $('vbar').className = 'vbar' + (kind === 'dict' ? ' dict' : '');
    $('voiceLabel').textContent = label;
    $('voiceLive').textContent = '';
    $('vbar').hidden = false;
    $('btnDictate').setAttribute('aria-pressed', String(kind === 'dict'));
    $('btnRecord').setAttribute('aria-pressed', String(kind === 'rec'));
  }
  function hideBar() {
    $('vbar').hidden = true;
    $('btnDictate').setAttribute('aria-pressed', 'false');
    $('btnRecord').setAttribute('aria-pressed', 'false');
  }

  /* ---------- 받아쓰기 ---------- */
  let sr = null, dictating = false, started = false, lastFinal = 0;
  function startDictation() {
    if (!SR) { toast('이 브라우저는 받아쓰기를 지원하지 않아요. Chrome으로 설치했는지 확인하거나 키보드의 마이크 버튼을 써 주세요.', null, null, 8000); return; }
    if (recording) { toast('녹음 중에는 받아쓰기를 쓸 수 없어요. 녹음을 먼저 끝내 주세요.'); return; }
    if (!navigator.onLine) { toast('받아쓰기는 인터넷 연결이 필요해요.'); return; }
    if (A().S.mode === 'pen') document.getElementById('modeType').click();
    A().ensureNote();
    dictating = true; started = false;
    showBar('dict', '받아쓰기 중');
    $('voiceLive').textContent = '말하면 노트에 적혀요…';
    listen();
  }
  function listen() {
    sr = new SR();
    sr.lang = 'ko-KR'; sr.continuous = true; sr.interimResults = true;
    sr.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], t = r[0].transcript.trim();
        if (r.isFinal) {
          if (!t) continue;
          const now = Date.now();
          if (!started) { A().appendToNote('[받아쓰기 · ' + D.stamp(now) + ']'); started = true; A().appendToNote(t); }
          else if (now - lastFinal > 4000) A().appendToNote(t);
          else A().appendToNote(t, true);
          lastFinal = now;
        } else interim += r[0].transcript;
      }
      $('voiceLive').textContent = interim || '듣고 있어요…';
    };
    sr.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { stopDictation(); toast('마이크 권한이 필요해요. 앱 정보 → 권한에서 마이크를 허용해 주세요.', null, null, 8000); }
      else if (e.error === 'network') { stopDictation(); toast('받아쓰기는 인터넷 연결이 필요해요.'); }
      else if (e.error === 'language-not-supported') { stopDictation(); toast('이 기기에서 한국어 음성 인식을 쓸 수 없어요.'); }
    };
    sr.onend = () => { if (dictating) { try { listen(); } catch (err) { stopDictation(); } } };
    try { sr.start(); } catch (e) { stopDictation(); }
  }
  function stopDictation() {
    dictating = false;
    try { sr && sr.stop(); } catch (e) { /* 무시 */ }
    sr = null; hideBar();
  }

  /* ---------- 녹음 ---------- */
  let mr = null, chunks = [], recording = false, t0 = 0, timer = null, wake = null, stream = null, recNote = null, recFrom = 0;
  async function startRecording() {
    if (db.usingFallback) { toast('이 브라우저에서는 녹음을 저장할 수 없어요.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { toast('이 브라우저는 녹음을 지원하지 않아요.'); return; }
    if (dictating) stopDictation();
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { toast('마이크 권한이 필요해요. 앱 정보 → 권한에서 마이크를 허용해 주세요.', null, null, 8000); return; }
    // 다른 앱(삼성 음성 녹음·삼성 노트 등)과 잘 맞는 m4a(AAC)를 먼저, 안 되면 webm
    const mime = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { stream.getTracks().forEach(t => t.stop()); toast('녹음을 시작하지 못했어요.'); return; }
    chunks = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = finishRecording;
    const startNote = A().ensureNote();
    recNote = startNote.id;
    recFrom = (startNote.body || '').length; // 녹음하는 동안 쓴 메모를 회의록 만들 때 함께 쓰려고
    mr.start(1000); recording = true; t0 = Date.now();
    toast('녹음을 시작했어요. 녹음 버튼이나 위쪽 ●를 누르면 끝나요', null, null, 5000);
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
    recMark(true); tick();
    timer = setInterval(() => recMark(true), 1000);
  }
  /* 녹음 중 표시: 위쪽 알림 줄 대신 녹음 버튼에 작은 빨간 점과 시간만 */
  function recMark(on) {
    const b = $('btnRecord'), lbl = $('recLbl');
    b.classList.toggle('rec-on', on);
    b.setAttribute('aria-pressed', String(on));
    const t = on ? fmtDur(Math.round((Date.now() - t0) / 1000)) : '';
    if (lbl) lbl.textContent = on ? t : '녹음';
    b.setAttribute('aria-label', on ? '녹음 중 ' + t + ', 누르면 끝내기' : '녹음');
    b.title = on ? '녹음 중 · 누르면 끝내요' : b.dataset.title || '녹음';
  }
  function stopRecording() {
    if (!recording) return;
    recording = false; clearInterval(timer);
    try { mr.stop(); } catch (e) { /* 무시 */ }
    if (stream) stream.getTracks().forEach(t => t.stop());
    try { if (wake) wake.release(); } catch (e) { /* 무시 */ }
    wake = null; recMark(false); tick();
  }
  /* 끝나면 먼저 '임시 녹음'으로 보관하고(앱이 꺼져도 잃지 않게) 저장할지 묻는다 */
  async function finishRecording() {
    const type = (mr && mr.mimeType) || 'audio/webm';
    const blob = new Blob(chunks, { type }); chunks = [];
    const dur = Math.max(1, Math.round((Date.now() - t0) / 1000));
    if (!blob.size) { toast('녹음된 소리가 없어요.'); return; }
    const doc = { id: 'rec-' + KK.uid(), kind: 'rec', noteId: recNote, createdAt: t0, duration: dur, mime: type, size: blob.size, name: defaultName(t0), draft: true, blob };
    const n = A().S.notes.get(recNote), body = (n && n.body) || '';
    if (body.length > recFrom) {
      const memo = body.slice(recFrom).split('\n').filter(l => !/^\s*(\/\/|@정리|정리!!)\s*$/.test(l)).join('\n').trim();
      if (memo) doc.memo = memo;
    }
    try { await db.putRaw(doc); } catch (e) { toast('녹음을 보관하지 못했어요. 저장 공간을 확인해 주세요.'); return; }
    askSave(doc);
  }

  /* ---------- 저장 여부 확인 ---------- */
  let asking = null, askUrl = null, discardArmed = false;
  function askSave(doc) {
    asking = doc; discardArmed = false;
    if (askUrl) URL.revokeObjectURL(askUrl);
    askUrl = URL.createObjectURL(doc.blob);
    const n = A().S.notes.get(doc.noteId);
    $('rsMeta').textContent = '길이 ' + fmtDur(doc.duration) + ' · ' + fmtSize(doc.size) + (n ? ' · 「' + KK.views.noteLabel(n) + '」 노트에 붙어요' : '');
    $('rsAudio').src = askUrl;
    $('rsName').value = doc.name;
    $('rsDiscard').textContent = '저장 안 함';
    if (!$('dlgRecSave').open) $('dlgRecSave').showModal();
  }
  async function confirmSave() {
    const doc = asking; if (!doc) return;
    doc.name = $('rsName').value.trim() || defaultName(doc.createdAt);
    doc.draft = false;
    try { await db.putRaw(doc); } catch (e) { toast('녹음을 저장하지 못했어요.'); return; }
    closeAsk();
    const line = '[녹음 · ' + doc.name + ' · ' + fmtDur(doc.duration) + ']';
    const S = A().S, n = S.notes.get(doc.noteId);
    if (n) {
      if (S.cur === n.id) A().appendToNote(line);
      else { n.body = (n.body || '').replace(/\s+$/, '') + '\n' + line; n.updatedAt = Date.now(); db.put(n); }
    }
    await refresh();
    toast('녹음을 저장했어요 · 녹음 탭에서 들을 수 있어요', '녹음 탭', () => A().setView('rec'));
  }
  async function confirmDiscard() {
    const doc = asking; if (!doc) return;
    if (!discardArmed) { discardArmed = true; $('rsDiscard').textContent = '정말 버릴까요? 한 번 더 누르세요'; return; }
    await db.del(doc.id);
    closeAsk(); await refresh();
    toast('녹음을 저장하지 않았어요');
  }
  function closeAsk() {
    asking = null;
    $('rsAudio').pause(); $('rsAudio').removeAttribute('src');
    if (askUrl) { URL.revokeObjectURL(askUrl); askUrl = null; }
    $('dlgRecSave').close();
  }
  // 뒤로 가기로 닫으면 녹음이 어중간하게 남지 않도록, 저장/저장 안 함 중 고르게 한다
  $('dlgRecSave').addEventListener('cancel', e => { e.preventDefault(); toast('녹음을 저장할지 골라 주세요'); });

  /* ---------- 녹음 탭 ---------- */
  async function allRecs() {
    if (db.usingFallback) return [];
    return (await db.all()).filter(d => d.kind === 'rec').sort((a, b) => b.createdAt - a.createdAt);
  }
  async function refresh() {
    const list = await allRecs();
    const mine = list.filter(r => r.noteId === A().S.cur && !r.draft);
    $('btnRecList').hidden = !mine.length;
    $('recCount').textContent = mine.length ? String(mine.length) : '';
    $('btnRecList').setAttribute('aria-label', '이 노트의 녹음 ' + mine.length + '개 보기');
    const drafts = list.filter(r => r.draft).length;
    $('recTabCnt').textContent = drafts ? String(drafts) : '';
    if (document.body.dataset.view === 'rec') renderList(list);
  }

  let urls = [], recQ = '';
  async function renderList(given) {
    urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
    const S = A().S, V = KK.views;
    const list = given || await allRecs();
    const box = $('recView'); box.textContent = '';
    const total = list.reduce((s, r) => s + (r.size || (r.blob && r.blob.size) || 0), 0);
    const filterNote = S.recNote && S.notes.get(S.recNote);
    const head = h('div', { class: 'rhead' },
      h('input', { class: 'search', id: 'recSearch', type: 'search', placeholder: '녹음 이름·노트·회의록 제목으로 찾기', value: recQ, oninput: e => { recQ = e.target.value; renderList(list); setTimeout(() => { const s = $('recSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 0); } }),
      h('span', { class: 'when' }, '녹음 ' + list.filter(r => !r.draft).length + '개 · ' + fmtSize(total)));
    box.append(head);
    if (filterNote) box.append(h('div', { class: 'rfilter' }, '「' + V.noteLabel(filterNote) + '」 노트의 녹음만 보는 중',
      h('button', { class: 'linkbtn', onclick: () => { S.recNote = null; renderList(list); } }, '전체 보기')));
    const q = recQ.trim().toLowerCase();
    const shown = list.filter(r => (!filterNote || r.noteId === S.recNote) &&
      (!q || [r.name, V.noteLabel(S.notes.get(r.noteId)), r.minutes && r.minutes.title].join(' ').toLowerCase().includes(q)));
    if (!shown.length) {
      box.append(h('div', { class: 'empty' },
        h('p', null, list.length ? '조건에 맞는 녹음이 없어요.' : '아직 녹음이 없어요.'),
        list.length ? null : h('p', null, '쓰기 화면 위쪽의 녹음 버튼을 누르면 녹음이 시작되고, 끝낼 때 저장할지 물어봐요.')));
      return;
    }
    let lastDay = '';
    let ul = null;
    shown.forEach(r => {
      const day = D.ymd(new Date(r.createdAt));
      if (day !== lastDay) {
        lastDay = day;
        box.append(h('h3', { class: 'rday' }, D.dayLabel(day)));
        ul = h('ul', { class: 'reclist' }); box.append(ul);
      }
      ul.append(card(r, list));
    });
  }

  function card(r, list) {
    const S = A().S, V = KK.views;
    const n = S.notes.get(r.noteId);
    const t = new Date(r.createdAt);
    const ext = /mp4/.test(r.mime) ? 'm4a' : /ogg/.test(r.mime) ? 'ogg' : 'webm';
    const fileName = (r.name || defaultName(r.createdAt)).replace(/[\\/:*?"<>|]/g, '-') + '.' + ext;
    const li = h('li', { class: 'rcard' + (r.draft ? ' draft' : '') });
    const title = h('div', { class: 'rtitle' }, h('b', null, r.name || defaultName(r.createdAt)),
      r.draft ? h('span', { class: 'chip new' }, '저장 확인 안 됨') : null,
      !r.draft && r.minutes ? h('span', { class: 'chip' }, '회의록') : null,
      !r.draft && !r.minutes && KK.minutes && KK.minutes.isRunning(r.id) ? h('span', { class: 'chip wait' }, '회의록 만드는 중…') : null,
      !r.draft && !r.minutes && r.autoMinutes === 'error' ? h('span', { class: 'chip', style: 'background:var(--danger-soft);color:var(--danger)' }, '자동 회의록 실패') : null,
      !r.draft && !r.minutes && r.text && r.text.trim() && !(KK.minutes && KK.minutes.isRunning(r.id)) && r.autoMinutes !== 'error' ? h('span', { class: 'chip plain' }, '녹취 글') : null,
      !r.blob ? h('span', { class: 'chip plain' }, '녹음 파일 없음') : null);
    const meta = h('div', { class: 'it-m' },
      h('span', { class: 'when' }, D.pad(t.getHours()) + ':' + D.pad(t.getMinutes()) + (r.blob ? ' · ' + fmtDur(r.duration || 0) + ' · ' + fmtSize(r.size || r.blob.size || 0) : ' · 녹취 글')),
      n ? h('button', { class: 'linkbtn', style: 'margin-left:0;min-height:28px', onclick: () => { A().openNote(n.id); A().setView('write'); } }, '노트: ' + V.noteLabel(n)) : h('span', null, '노트 없음'));
    const player = h('div', { class: 'rplayer' });
    const playBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => {
      const url = URL.createObjectURL(r.blob); urls.push(url);
      player.textContent = '';
      const au = h('audio', { controls: true, src: url, preload: 'auto' });
      player.append(au); au.play().catch(() => {});
      playBtn.hidden = true;
    } }, svg('<path d="M8 5v14l11-7z"/>'), '듣기');
    const acts = h('div', { class: 'row' }, r.blob ? playBtn : null);
    if (r.draft) {
      acts.append(
        h('button', { type: 'button', class: 'btn', onclick: () => askSave(r) }, '저장할지 정하기'));
    } else {
      acts.append(...[
        h('button', { type: 'button', class: 'btn', onclick: () => KK.minutes.open(r) }, svg(ICON.note), r.minutes ? '회의록 보기' : '회의록 만들기'),
        h('button', { type: 'button', class: 'btn', onclick: () => rename(li, r, list) }, '이름 바꾸기'),
        r.blob ? h('button', { type: 'button', class: 'btn', onclick: () => shareRec(r, fileName) }, '공유') : null,
        r.blob ? h('button', { type: 'button', class: 'btn', onclick: () => download(r, fileName) }, '파일로 받기') : null,
        h('button', { type: 'button', class: 'btn danger', onclick: async () => {
          await db.del(r.id); await refresh(); renderList();
          toast('「' + (r.name || '녹음') + '」을(를) 지웠어요', '되돌리기', async () => { await db.putRaw(r); await refresh(); renderList(); });
        } }, '삭제')].filter(Boolean));
    }
    li.append(title, meta, player, acts);
    return li;
  }

  function rename(li, r, list) {
    const input = h('input', { type: 'text', class: 'search', value: r.name || '', 'aria-label': '녹음 이름' });
    const row = h('div', { class: 'row' }, input,
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        r.name = input.value.trim() || defaultName(r.createdAt);
        await db.putRaw(r); renderList();
      } }, '저장'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => renderList(list) }, '취소'));
    li.querySelector('.rtitle').replaceWith(row);
    input.focus(); input.select();
  }

  /* 다른 앱으로 보내기 (카톡·드라이브·삼성 노트 등). 공유가 안 되는 기기면 파일로 받는다 */
  async function shareRec(r, fileName) {
    const type = /mp4/.test(r.mime || '') ? 'audio/mp4' : String(r.blob.type || r.mime || 'audio/webm').split(';')[0];
    const file = new File([r.blob], fileName, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: r.name || '녹음' }); }
      catch (e) { if (e.name !== 'AbortError') download(r, fileName); }
    } else {
      download(r, fileName);
      toast('이 기기에서는 바로 공유가 안 돼서 다운로드 폴더에 저장했어요. 다른 앱에서 그 파일을 열어 주세요.', null, null, 7000);
    }
  }
  function download(r, fileName) {
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('「' + fileName + '」을(를) 다운로드 폴더에 저장했어요');
  }

  /* ---------- 버튼 연결 ---------- */
  $('btnDictate').addEventListener('click', () => (dictating ? stopDictation() : startDictation()));
  /* ---------- 녹음 버튼 → 두 가지 중 고름 (kk-v23) ----------
     ① 끄적노트로 녹음: 앱 안 MediaRecorder, 파일은 녹음 탭에.
     ② 음성 녹음 앱으로 녹음: 파일은 그 앱에. 웹앱(Chrome)은 BROWSABLE로 열린 앱만 열 수 있어
        삼성 음성 녹음 앱을 열거나 녹음을 시작하게 할 수 없다 → 사용자가 직접 열고(작업 표시줄·앱 페어),
        끄적노트는 시작 표시·경과 시간을 보여 주고, 공유받은 녹음·변환 글을 그 노트에 붙인다(app.js importFiles → recTarget). */
  const UA = navigator.userAgent || '';
  const isAndroid = /Android/i.test(UA) || (navigator.userAgentData && navigator.userAgentData.platform === 'Android') ||
    (/Linux/i.test(UA) && !/CrOS/i.test(UA) && (navigator.maxTouchPoints || 0) > 1); // 태블릿 Chrome은 '데스크톱 버전'으로 열려 Linux로 보일 때가 많다
  const MARK_KEY = 'kk-recmark', MARK_MAX = 8 * 3600e3;
  const hhmm = t => { const d = new Date(t); return D.pad(d.getHours()) + ':' + D.pad(d.getMinutes()); };
  function getMark() {
    try { const m = JSON.parse(localStorage.getItem(MARK_KEY) || 'null'); if (m && m.at && Date.now() - m.at < MARK_MAX) return m; } catch (e) { /* 무시 */ }
    return null;
  }
  function setMark(m) {
    try { if (m) localStorage.setItem(MARK_KEY, JSON.stringify(m)); else localStorage.removeItem(MARK_KEY); } catch (e) { /* 무시 */ }
    tick();
  }
  function noteLine(n, line) {
    if (!n) return;
    if (A().S.cur === n.id) A().appendToNote(line);
    else { n.body = (n.body || '').replace(/\s+$/, '') + '\n' + line; n.updatedAt = Date.now(); db.put(n); }
  }
  function startMark() {
    if (dictating) stopDictation();
    const n = A().ensureNote(), now = Date.now();
    setMark({ noteId: n.id, at: now });
    noteLine(n, '[녹음 시작 · ' + hhmm(now) + ' · 음성 녹음 앱]');
    toast('노트에 시작 표시를 했어요. 이제 음성 녹음 앱을 열어 녹음하세요 — 작업 표시줄에서 화면 옆으로 끌어 놓으면 나란히 열려요', null, null, 9000);
  }
  // viaShare: 녹음을 공유받아서 끝난 경우(노트에 따로 끝 줄을 적지 않음)
  function endMark(viaShare) {
    const m = getMark();
    if (!m) return;
    const n = A().S.notes.get(m.noteId);
    if (!viaShare && n) noteLine(n, '[녹음 끝 · ' + hhmm(Date.now()) + ' · ' + fmtDur(Math.round((Date.now() - m.at) / 1000)) + ']');
    setMark(null);
  }
  // 공유받은 녹음·변환 글을 붙일 노트: 녹음 시작을 표시한 노트(8시간 안)
  function recTarget() {
    const m = getMark(), n = m && A().S.notes.get(m.noteId);
    return n ? { note: n, at: m.at } : null;
  }

  // 위쪽 작은 표시 + 녹음 버튼 표시 (끄적노트 녹음 또는 음성 녹음 앱 녹음 중)
  let tickTimer = null;
  function tick() {
    const m = getMark(), pill = $('recPill');
    const on = recording || !!m;
    if (pill) {
      pill.hidden = !on;
      if (on) {
        const from = recording ? t0 : m.at, t = fmtDur(Math.round((Date.now() - from) / 1000));
        $('recPillT').textContent = (recording ? '녹음 ' : '음성 녹음 ') + t;
        pill.setAttribute('aria-label', (recording ? '끄적노트 녹음 중 ' : '음성 녹음 앱 녹음 중 ') + t + (recording ? ', 누르면 끝내기' : ', 누르면 끝내는 방법 보기'));
      }
    }
    if (!recording) {
      const b = $('btnRecord'), lbl = $('recLbl');
      b.classList.toggle('rec-on', !!m);
      b.setAttribute('aria-pressed', String(!!m));
      if (lbl) lbl.textContent = m ? fmtDur(Math.round((Date.now() - m.at) / 1000)) : '녹음';
      b.title = m ? '음성 녹음 앱에서 녹음 중 · 누르면 끝내는 방법' : b.dataset.title || '녹음';
    }
    if (on && !tickTimer) tickTimer = setInterval(tick, 1000);
    if (!on && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function showMarkDlg() {
    const m = getMark();
    if (!m) return;
    const n = A().S.notes.get(m.noteId);
    $('rmText').textContent = '시작 ' + hhmm(m.at) + ' · ' + Math.max(1, Math.round((Date.now() - m.at) / 60000)) + '분째' + (n ? ' · 「' + KK.views.noteLabel(n) + '」 노트' : '');
    $('dlgRecMark').showModal();
  }
  $('rmEnd').addEventListener('click', () => { $('dlgRecMark').close(); endMark(false); toast('녹음 끝을 노트에 적었어요. 음성 녹음 앱에서 공유 → 끄적노트로 보내면 이 노트에 붙어요', null, null, 8000); });
  $('rmClose').addEventListener('click', () => $('dlgRecMark').close());
  $('recPill').addEventListener('click', () => { if (recording) stopRecording(); else showMarkDlg(); });

  function startDlg() {
    $('rqHead').textContent = isAndroid ? '어떻게 녹음할까요?' : '녹음을 시작할까요?';
    $('rqApp').hidden = !isAndroid; $('rqHelp').hidden = !isAndroid; $('rqHelp').open = false;
    $('dlgRecStart').showModal();
  }
  $('btnRecord').addEventListener('click', () => {
    if (recording) { stopRecording(); return; }
    if (getMark()) { showMarkDlg(); return; }
    startDlg(); // 바로 시작하지 않고 고르게 한다
  });
  $('rqCancel').addEventListener('click', () => $('dlgRecStart').close());
  $('rqWeb').addEventListener('click', () => { $('dlgRecStart').close(); startRecording(); });
  $('rqApp').addEventListener('click', () => { $('dlgRecStart').close(); startMark(); });
  $('btnVoiceStop').addEventListener('click', () => { if (recording) stopRecording(); if (dictating) stopDictation(); });
  $('btnRecList').addEventListener('click', () => { A().S.recNote = A().S.cur; A().setView('rec'); });
  $('rsSave').addEventListener('click', confirmSave);
  $('rsDiscard').addEventListener('click', confirmDiscard);

  $('btnRecord').dataset.title = isAndroid ? '녹음 (끄적노트로 녹음 또는 음성 녹음 앱으로 녹음)' : '소리를 녹음해 이 노트에 저장';
  $('btnRecord').title = $('btnRecord').dataset.title;
  tick(); // 앱을 다시 열었을 때 음성 녹음 앱 녹음 중 표시를 이어서
  KK.voice = { refresh, renderList, isAndroid, recTarget, endMark, getMark, stopAll() { if (recording) stopRecording(); if (dictating) stopDictation(); } };

  // 시작할 때: 저장 여부를 정하지 않은 녹음이 있으면 알려 준다
  refresh().then(async () => {
    const drafts = (await allRecs()).filter(r => r.draft);
    if (drafts.length) toast('저장할지 정하지 않은 녹음이 ' + drafts.length + '개 있어요', '녹음 탭', () => A().setView('rec'), 8000);
  });
})();
