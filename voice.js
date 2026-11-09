'use strict';
/* 끄적노트 — 받아쓰기(기기 음성 인식, 무료)와 녹음(노트에 소리 파일 저장) */
(function () {
  const { $, h, toast } = KK.ui;
  const D = KK.date, db = KK.db;
  const A = () => KK.app;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const fmtDur = s => Math.floor(s / 60) + ':' + D.pad(s % 60);

  function showBar(kind, label) {
    $('vbar').className = 'busy vbar' + (kind === 'dict' ? ' dict' : '');
    $('voiceLabel').textContent = label;
    $('voiceLive').textContent = '';
    $('vbar').hidden = false; $('btnOrganize').hidden = true;
    $('btnDictate').setAttribute('aria-pressed', String(kind === 'dict'));
    $('btnRecord').setAttribute('aria-pressed', String(kind === 'rec'));
  }
  function hideBar() {
    $('vbar').hidden = true; $('btnOrganize').hidden = !$('busy').hidden;
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
          else if (now - lastFinal > 4000) A().appendToNote(t);   // 잠깐 쉬면 새 줄
          else A().appendToNote(t, true);                         // 이어 말하면 같은 줄
          lastFinal = now;
        } else interim += r[0].transcript;
      }
      $('voiceLive').textContent = interim || '듣고 있어요…';
    };
    sr.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        stopDictation(); toast('마이크 권한이 필요해요. 앱 정보 → 권한에서 마이크를 허용해 주세요.', null, null, 8000);
      } else if (e.error === 'network') { stopDictation(); toast('받아쓰기는 인터넷 연결이 필요해요.'); }
      else if (e.error === 'language-not-supported') { stopDictation(); toast('이 기기에서 한국어 음성 인식을 쓸 수 없어요.'); }
    };
    sr.onend = () => { if (dictating) { try { listen(); } catch (err) { stopDictation(); } } }; // 말이 멈추면 자동으로 끝나므로 다시 듣기
    try { sr.start(); } catch (e) { stopDictation(); }
  }
  function stopDictation() {
    dictating = false;
    try { sr && sr.stop(); } catch (e) { /* 무시 */ }
    sr = null; hideBar();
  }

  /* ---------- 녹음 ---------- */
  let mr = null, chunks = [], recording = false, t0 = 0, timer = null, wake = null, stream = null, recNote = null;
  async function startRecording() {
    if (db.usingFallback) { toast('이 브라우저에서는 녹음을 저장할 수 없어요.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { toast('이 브라우저는 녹음을 지원하지 않아요.'); return; }
    if (dictating) stopDictation();
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { toast('마이크 권한이 필요해요. 앱 정보 → 권한에서 마이크를 허용해 주세요.', null, null, 8000); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { stream.getTracks().forEach(t => t.stop()); toast('녹음을 시작하지 못했어요.'); return; }
    chunks = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = saveRecording;
    recNote = A().ensureNote().id;
    mr.start(1000); recording = true; t0 = Date.now();
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
    showBar('rec', '녹음 중 0:00');
    $('voiceLive').textContent = '화면을 켜 둔 채로 두세요';
    timer = setInterval(() => { $('voiceLabel').textContent = '녹음 중 ' + fmtDur(Math.round((Date.now() - t0) / 1000)); }, 500);
  }
  function stopRecording() {
    if (!recording) return;
    recording = false; clearInterval(timer);
    try { mr.stop(); } catch (e) { /* 무시 */ }
    if (stream) stream.getTracks().forEach(t => t.stop());
    try { if (wake) wake.release(); } catch (e) { /* 무시 */ }
    wake = null; hideBar();
  }
  async function saveRecording() {
    const type = (mr && mr.mimeType) || 'audio/webm';
    const blob = new Blob(chunks, { type }); chunks = [];
    const dur = Math.max(1, Math.round((Date.now() - t0) / 1000));
    if (!blob.size) { toast('녹음된 소리가 없어요.'); return; }
    const doc = { id: 'rec-' + KK.uid(), kind: 'rec', noteId: recNote, createdAt: t0, duration: dur, mime: type, blob };
    try { await db.putRaw(doc); } catch (e) { toast('녹음을 저장하지 못했어요. 저장 공간을 확인해 주세요.'); return; }
    if (A().S.cur === recNote) A().appendToNote('[녹음 · ' + D.stamp(t0) + ' · ' + fmtDur(dur) + ']');
    await refresh();
    toast('녹음을 저장했어요 (' + fmtDur(dur) + ')', '듣기', openList);
  }
  document.addEventListener('visibilitychange', () => {
    // 화면이 다시 보이면 끊긴 화면 켜짐 유지를 다시 요청
    if (document.visibilityState === 'visible' && recording && navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { wake = w; }).catch(() => {});
  });

  /* ---------- 녹음 목록 ---------- */
  async function recsOf(noteId) {
    if (!noteId || db.usingFallback) return [];
    return (await db.all()).filter(d => d.kind === 'rec' && d.noteId === noteId).sort((a, b) => b.createdAt - a.createdAt);
  }
  async function refresh() {
    const list = await recsOf(A().S.cur);
    $('btnRecList').hidden = !list.length;
    $('recCount').textContent = list.length ? String(list.length) : '';
    $('btnRecList').setAttribute('aria-label', '이 노트의 녹음 ' + list.length + '개 듣기');
  }
  let urls = [];
  async function openList() {
    urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
    const ul = $('recList'); ul.textContent = '';
    const list = await recsOf(A().S.cur);
    if (!list.length) ul.append(h('li', { class: 'empty' }, '이 노트에는 녹음이 없어요.'));
    list.forEach(r => {
      const url = URL.createObjectURL(r.blob); urls.push(url);
      const ext = /mp4/.test(r.mime) ? 'm4a' : /ogg/.test(r.mime) ? 'ogg' : 'webm';
      const name = '끄적노트-녹음-' + D.ymd(new Date(r.createdAt)) + '-' + D.pad(new Date(r.createdAt).getHours()) + D.pad(new Date(r.createdAt).getMinutes()) + '.' + ext;
      ul.append(h('li', null,
        h('div', { class: 'row' }, h('b', null, D.stamp(r.createdAt)), h('span', { class: 'when' }, fmtDur(r.duration || 0))),
        h('audio', { controls: true, preload: 'metadata', src: url }),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: url, download: name }, '파일로 받기'),
          h('button', { type: 'button', class: 'btn danger', onclick: async () => {
            await db.del(r.id); await refresh(); openList();
            toast('녹음을 지웠어요', '되돌리기', async () => { await db.putRaw(r); await refresh(); });
          } }, '삭제'))));
    });
    if (!$('dlgRec').open) $('dlgRec').showModal();
  }

  $('btnDictate').addEventListener('click', () => (dictating ? stopDictation() : startDictation()));
  $('btnRecord').addEventListener('click', () => (recording ? stopRecording() : startRecording()));
  $('btnVoiceStop').addEventListener('click', () => { if (recording) stopRecording(); if (dictating) stopDictation(); });
  $('btnRecList').addEventListener('click', openList);

  KK.voice = { refresh, stopAll() { if (recording) stopRecording(); if (dictating) stopDictation(); } };
  refresh();
})();
