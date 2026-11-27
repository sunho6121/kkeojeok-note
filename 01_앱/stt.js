'use strict';
/* 끄적노트 — 녹음 → 글 (이 기기 안에서 바꾸기, kk-v32)
   - Whisper large-v3-turbo를 transformers.js + WebGPU로 Worker(stt-worker.js)에서 돌림. 녹음 소리는 기기 밖으로 안 나감
   - 모델은 허깅페이스에서 처음 한 번 받아 브라우저 저장소에 둠(약 540MB, GPU가 f16을 못 쓰면 약 725MB)
   - 끄적노트로 녹음해 저장하면 바로, 녹음 파일만 공유받으면 2분 기다렸다가(변환 글이 따라오면 그 글을 씀) 글로 바꾸고 회의록(minutes.auto)으로 넘김
   - 말이 쉬는 곳에서 15~28초 조각으로 나눠 차례로 바꾸고, 조각마다 이어 갈 곳을 저장 → 앱이 닫혀도 다음에 이어서
   - 노트북에 맡기기: sttSt='pc' → 맞추기로 녹음을 받은 노트북(안드로이드가 아닌 기기)이 바꿔 글을 돌려줌
   녹음 문서에 두는 상태(맞추기로 오감): sttSt 'wait' 차례 · 'run' 바꾸는 중 · 'pc' 노트북 차례 · 'done' · 'err' · 'stop' 멈춤 · 'skip' 다른 글이 먼저 옴
   sttBy 맡은 기기, sttAfter 이때부터, textSrc 'stt' = 이 기능으로 만든 녹취 글 */
(function () {
  const { $, h, toast } = KK.ui;
  const db = KK.db;
  const A = () => KK.app;
  const V = () => KK.voice;

  const MODEL = 'onnx-community/whisper-large-v3-turbo';
  const REV = '360ebcde2559d60bb474678be3c1de9ef347d01a'; // 받는 판을 고정
  const MB = { q4f16: 540, q4: 725 };
  const R = 16000;
  const SHARE_WAIT = 120e3;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* 무시 */ } },
  };
  // 시험할 때만 이 PC 주소로 바꿀 수 있음(실제로는 허깅페이스)
  function host() {
    const t = ls.get('kk-stt-host');
    return t && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/$/.test(t) ? t : 'https://huggingface.co/';
  }
  const dev = ls.get('kk-stt-dev') || (() => { const d = 'd' + KK.uid(); ls.set('kk-stt-dev', d); return d; })();
  const isPC = () => !(V() && V().isAndroid);
  const where = () => { const w = (A() && A().settings.sttWhere) || 'here'; return w === 'pc' && isPC() ? 'here' : w; };
  const syncOn = () => !!(KK.sync && KK.sync.cfg && KK.sync.cfg.on && KK.sync.cfg.files);
  const hasText = r => !!(r && (r.text || '').trim());
  const fail = (code, msg) => Object.assign(new Error(msg || code), { code });

  /* ---------- GPU·모델 ---------- */
  let gpuP = null;
  function gpu() {
    if (!gpuP) gpuP = (async () => {
      if (!navigator.gpu) return { ok: false };
      try {
        const ad = await Promise.race([navigator.gpu.requestAdapter(), sleep(8000).then(() => null)]);
        return ad ? { ok: true, dt: ad.features.has('shader-f16') ? 'q4f16' : 'q4' } : { ok: false };
      } catch (e) { return { ok: false }; }
    })();
    return gpuP;
  }
  const FILES = dt => ['config.json', 'tokenizer.json', 'onnx/encoder_model_' + dt + '.onnx', 'onnx/decoder_model_merged_' + dt + '.onnx'];
  const fileUrl = f => host() + MODEL + '/resolve/' + REV + '/' + f;
  async function hasModel(dt) {
    try {
      const c = await caches.open('transformers-cache');
      for (const f of FILES(dt)) if (!(await c.match(fileUrl(f)))) return false;
      return true;
    } catch (e) { return false; }
  }
  async function dropModel() {
    kill();
    try {
      const c = await caches.open('transformers-cache');
      for (const q of await c.keys()) if (q.url.includes('/whisper-')) await c.delete(q);
    } catch (e) { /* 무시 */ }
  }

  /* ---------- 일꾼(Worker) ---------- */
  let wk = null, seq = 0, loadedKey = '', idleTimer = null, dl = null, dlMin = 0;
  const waits = new Map();
  function worker() {
    if (wk) return wk;
    wk = new Worker('stt-worker.js', { type: 'module' });
    wk.onmessage = e => {
      const m = e.data || {};
      if (m.t === 'dl') { dl = { loaded: m.loaded, total: Math.max(m.total, dlMin) }; paint(); return; } // 큰 파일이 늦게 시작해도 %가 앞서 가지 않게
      const w = waits.get(m.id);
      if (!w) return;
      waits.delete(m.id);
      if (m.t === 'err') w.no(fail('engine', m.msg)); else w.ok(m);
    };
    wk.onerror = e => { if (e.preventDefault) e.preventDefault(); const err = fail('engine', '변환 엔진을 열지 못했어요' + (e.message ? ' (' + e.message + ')' : '')); waits.forEach(w => w.no(err)); waits.clear(); kill(); };
    return wk;
  }
  function call(msg, transfer) {
    return new Promise((ok, no) => { const id = ++seq; waits.set(id, { ok, no }); worker().postMessage(Object.assign({ id }, msg), transfer || []); });
  }
  function kill() {
    if (wk) { wk.terminate(); wk = null; }
    loadedKey = '';
    const err = fail('stopped');
    waits.forEach(w => w.no(err)); waits.clear();
  }
  async function ensureLoaded(dt) {
    clearTimeout(idleTimer);
    const k = host() + '|' + dt;
    if (loadedKey === k && wk) return;
    dl = null; dlMin = (MB[dt] || 0) * 1048576 * 0.97;
    const progress = !(await hasModel(dt)); // 받아 둔 모델이면 진행 표시(크기 확인 요청) 없이 엶
    await call({ t: 'load', host: host(), model: MODEL, rev: REV, dt, progress });
    loadedKey = k; dl = null;
  }

  /* ---------- 녹음 파일 읽기: MP4(m4a)는 WebCodecs로 조금씩, 그 밖은 한 번에 ---------- */
  async function decode(blob, sink) {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp' && typeof AudioDecoder === 'function') {
      if (await decodeMp4(blob, sink)) return;
    }
    await decodeWhole(blob, sink);
  }
  async function decodeWhole(blob, sink) {
    let buf;
    try { buf = await new OfflineAudioContext(1, 1, R).decodeAudioData(await blob.arrayBuffer()); }
    catch (e) { throw fail('decode', '녹음 파일을 읽지 못했어요(형식)'); }
    const n = buf.length, C = buf.numberOfChannels, ch = [];
    for (let c = 0; c < C; c++) ch.push(buf.getChannelData(c));
    for (let i = 0; i < n; i += 20 * R) {
      const m = new Float32Array(Math.min(20 * R, n - i));
      for (let c = 0; c < C; c++) { const d = ch[c]; for (let j = 0; j < m.length; j++) m[j] += d[i + j] / C; }
      await sink.push(m);
    }
    await sink.end();
  }
  async function decodeMp4(blob, sink) {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let info = null;
    try { info = mp4Audio(u8); } catch (e) { info = null; }
    if (!info || !info.samples.length) return false;
    const cfg = { codec: info.codec, sampleRate: info.rate, numberOfChannels: info.ch, description: info.asc };
    let sup = null;
    try { sup = await AudioDecoder.isConfigSupported(cfg); } catch (e) { sup = null; }
    if (!sup || !sup.supported) return false;
    const outQ = [];
    let got = 0, err = null, wake = null, pushed = false;
    const poke = () => { if (wake) { const w = wake; wake = null; w(); } };
    const dec = new AudioDecoder({ output: a => { outQ.push(a); got++; poke(); }, error: e => { err = e; poke(); } });
    const rs = resampler();
    const drain = async () => {
      if (!outQ.length) return;
      const list = outQ.splice(0), rate = list[0].sampleRate, mono = mix(list);
      list.forEach(a => a.close());
      const y = await rs.push(mono, rate);
      if (y.length) { pushed = true; await sink.push(y); }
    };
    try {
      dec.configure(cfg);
      const S = info.samples, us = Math.round(1e6 * 1024 / (info.rate || 48000));
      for (let i = 0; i < S.length; i++) {
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: i * us, duration: us, data: u8.subarray(S[i][0], S[i][0] + S[i][1]) }));
        if (i + 1 - got > 48) {
          await Promise.race([new Promise(r => { wake = r; }), sleep(3000)]);
          wake = null;
          if (!err && i + 1 - got > 48) await dec.flush(); // 내놓지 않으면 밀어냄
        }
        if (err) throw err;
        if (outQ.length >= 400) await drain();
      }
      await dec.flush();
      if (err) throw err;
      await drain();
      const tail = await rs.end();
      if (tail.length) { pushed = true; await sink.push(tail); }
    } catch (e) {
      outQ.forEach(a => { try { a.close(); } catch (x) { /* 무시 */ } });
      const ours = e && typeof e.code === 'string';
      if (!pushed && !ours) return false; // 처음부터 안 되면 다른 방법으로
      throw ours ? e : fail('decode', '녹음 파일을 읽지 못했어요(' + ((e && e.message) || e) + ')');
    } finally { try { dec.close(); } catch (e) { /* 무시 */ } }
    await sink.end();
    return true;
  }
  function mix(list) {
    let n = 0;
    list.forEach(a => { n += a.numberOfFrames; });
    const out = new Float32Array(n);
    let o = 0;
    for (const a of list) {
      const F = a.numberOfFrames, C = a.numberOfChannels, tmp = new Float32Array(F);
      for (let c = 0; c < C; c++) {
        a.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < F; i++) out[o + i] += tmp[i] / C;
      }
      o += F;
    }
    return out;
  }
  function cat(...xs) {
    xs = xs.filter(x => x && x.length);
    if (xs.length === 1) return xs[0];
    let n = 0; xs.forEach(x => { n += x.length; });
    const out = new Float32Array(n);
    let o = 0; xs.forEach(x => { out.set(x, o); o += x.length; });
    return out;
  }
  /* 16kHz로 바꾸기: 20초씩, 앞뒤 1초를 겹쳐 OfflineAudioContext로 바꾸고 겹친 곳은 버림(경계 잡음 없음) */
  function resampler() {
    const B = 20;
    let rate = 0, buf = new Float32Array(0), base = 0, k = 0;
    async function block(lo, hi, keepFrom, keepLen) {
      const seg = buf.subarray(lo - base, hi - base);
      const n = Math.max(1, Math.round(seg.length * R / rate));
      const ctx = new OfflineAudioContext(1, n, R);
      const ab = ctx.createBuffer(1, seg.length, rate);
      ab.copyToChannel(seg, 0);
      const s = ctx.createBufferSource();
      s.buffer = ab; s.connect(ctx.destination); s.start();
      const out = (await ctx.startRendering()).getChannelData(0);
      return out.slice(keepFrom, keepLen == null ? undefined : keepFrom + keepLen);
    }
    return {
      async push(x, r) {
        if (!rate) rate = r;
        if (rate === R) return x;
        buf = cat(buf, x);
        const outs = [], M = rate, L = B * rate;
        while (base + buf.length >= (k + 1) * L + M) {
          outs.push(await block(Math.max(0, k * L - M), (k + 1) * L + M, k ? R : 0, B * R));
          k++;
          const keep = k * L - M;
          if (keep > base) { buf = buf.slice(keep - base); base = keep; }
        }
        return outs.length ? cat(...outs) : new Float32Array(0);
      },
      async end() {
        if (!rate || rate === R) return new Float32Array(0);
        const L = B * rate, M = rate, hi = base + buf.length;
        if (hi <= k * L) return new Float32Array(0);
        return block(Math.max(0, k * L - M), hi, k ? R : 0, null);
      },
    };
  }

  /* MP4 상자에서 소리 트랙(AAC)의 설정과 조각 위치 찾기 — 보통 m4a(음성 녹음 앱)와 조각 MP4(크롬 녹음) 모두 */
  function mp4Audio(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const str = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    function boxes(from, to, fn) {
      let o = from;
      while (o + 8 <= to) {
        let size = dv.getUint32(o), hdr = 8;
        const type = str(o + 4);
        if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = to - o;
        if (size < hdr) break;
        if (o + size > to) { if (type === 'mdat' || type === 'moof') size = to - o; else break; } // 끊긴 녹음의 마지막 조각
        if (fn(type, o + hdr, o + size, o) === false) return;
        o += size;
      }
    }
    const tr = {}, trex = {}, frag = [];
    function esds(p, q) {
      let o = p + 4;
      const len = () => { let n = 0, c; do { c = u8[o++]; n = (n << 7) | (c & 0x7f); } while ((c & 0x80) && o < q); return n; };
      if (u8[o++] !== 3) return null;
      len(); o += 2;
      const fl = u8[o++];
      if (fl & 0x80) o += 2;
      if (fl & 0x40) o += 1 + u8[o];
      if (fl & 0x20) o += 2;
      if (u8[o++] !== 4) return null;
      len(); o += 13;
      if (u8[o++] !== 5) return null;
      const n = len();
      return u8.slice(o, o + n);
    }
    function stsd(x, y, t) {
      const n = dv.getUint32(x + 4);
      let o = x + 8;
      for (let i = 0; i < n && o + 8 <= y; i++) {
        const size = dv.getUint32(o), b = o + 8;
        if (str(o + 4) === 'mp4a') {
          const ver = dv.getUint16(b + 8);
          t.ch = dv.getUint16(b + 16); t.rate = dv.getUint32(b + 24) >>> 16;
          const find = (a, z) => boxes(a, z, (ty, p, q) => { if (ty === 'esds') { t.asc = esds(p, q); return false; } if (ty === 'wave') find(p, q); });
          find(b + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0), o + size);
        }
        o += size;
      }
    }
    function trak(s, e) {
      const t = { id: 0 };
      let sound = false;
      const walk = (a, b) => boxes(a, b, (ty, x, y) => {
        if (ty === 'tkhd') t.id = dv.getUint32(x + (u8[x] === 1 ? 20 : 12));
        else if (ty === 'mdia' || ty === 'minf' || ty === 'stbl') walk(x, y);
        else if (ty === 'hdlr') sound = str(x + 8) === 'soun';
        else if (ty === 'stsd') stsd(x, y, t);
        else if (ty === 'stsz') { const fixed = dv.getUint32(x + 4); t.sz = { fixed, n: dv.getUint32(x + 8), at: x + 12 }; }
        else if (ty === 'stco' || ty === 'co64') {
          const n = dv.getUint32(x + 4), w = ty === 'co64' ? 8 : 4;
          t.co = [];
          for (let i = 0; i < n; i++) t.co.push(w === 8 ? Number(dv.getBigUint64(x + 8 + 8 * i)) : dv.getUint32(x + 8 + 4 * i));
        } else if (ty === 'stsc') {
          const n = dv.getUint32(x + 4);
          t.sc = [];
          for (let i = 0; i < n; i++) t.sc.push([dv.getUint32(x + 8 + 12 * i), dv.getUint32(x + 12 + 12 * i)]);
        }
      });
      walk(s, e);
      if (sound && t.asc && !tr.asc) Object.assign(tr, t);
    }
    function moof(s, e, at) {
      boxes(s, e, (ty, a, b) => {
        if (ty !== 'traf') return;
        let tid = 0, base = at, dsz = 0, end = null;
        boxes(a, b, (t2, x) => {
          if (t2 === 'tfhd') {
            const fl = dv.getUint32(x) & 0xffffff;
            let o = x + 8;
            tid = dv.getUint32(x + 4);
            dsz = (trex[tid] || {}).size || 0;
            if (fl & 1) { base = Number(dv.getBigUint64(o)); o += 8; }
            if (fl & 2) o += 4;
            if (fl & 8) o += 4;
            if (fl & 0x10) dsz = dv.getUint32(o);
          } else if (t2 === 'trun' && tid === tr.id) {
            const fl = dv.getUint32(x) & 0xffffff, n = dv.getUint32(x + 4);
            let o = x + 8, off = end != null ? end : base;
            if (fl & 1) { off = base + dv.getInt32(o); o += 4; }
            if (fl & 4) o += 4;
            for (let i = 0; i < n; i++) {
              if (fl & 0x100) o += 4;
              let sz = dsz;
              if (fl & 0x200) { sz = dv.getUint32(o); o += 4; }
              if (fl & 0x400) o += 4;
              if (fl & 0x800) o += 4;
              frag.push([off, sz]); off += sz;
            }
            end = off;
          }
        });
      });
    }
    const top = [];
    boxes(0, u8.length, (t, s, e, o) => { top.push([t, s, e, o]); });
    top.filter(b => b[0] === 'moov').forEach(([, s, e]) => boxes(s, e, (t, a, b) => {
      if (t === 'trak') trak(a, b);
      else if (t === 'mvex') boxes(a, b, (t2, x) => { if (t2 === 'trex') trex[dv.getUint32(x + 4)] = { size: dv.getUint32(x + 16) }; });
    }));
    if (!tr.asc || tr.asc.length < 2) return null;
    // 오디오 설정(ASC): 종류·표본율·채널
    let bit = 0;
    const rd = n => { let v = 0; for (let i = 0; i < n; i++) { v = (v << 1) | ((tr.asc[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; } return v; };
    let aot = rd(5);
    if (aot === 31) aot = 32 + rd(6);
    const fi = rd(4);
    const rate = fi === 15 ? rd(24) : [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][fi];
    const ch = rd(4);
    const samples = [];
    if (tr.co && tr.sc && tr.sz) {
      const sizeOf = i => tr.sz.fixed || dv.getUint32(tr.sz.at + 4 * i);
      let si = 0, k = 0;
      for (let c = 0; c < tr.co.length && si < tr.sz.n; c++) {
        while (k + 1 < tr.sc.length && tr.sc[k + 1][0] <= c + 1) k++;
        let off = tr.co[c];
        for (let j = 0; j < tr.sc[k][1] && si < tr.sz.n; j++, si++) { const s = sizeOf(si); samples.push([off, s]); off += s; }
      }
    }
    top.filter(b => b[0] === 'moof').forEach(([, s, e, o]) => moof(s, e, o));
    frag.forEach(x => samples.push(x));
    const ok = samples.filter(([o, n]) => n > 0 && o >= 0 && o + n <= u8.length);
    return { codec: 'mp4a.40.' + aot, rate: rate || tr.rate, ch: ch || tr.ch || 1, asc: tr.asc, samples: ok };
  }

  /* ---------- 말이 쉬는 곳에서 자르기 ---------- */
  // 15~28초 사이에서 가장 조용한 0.3초의 가운데를 자름. startAt(16k 샘플) 앞은 버림(이어서 할 때)
  function seg(startAt, emit) {
    const MIN = 15 * R, MAX = 28 * R, WIN = Math.round(0.3 * R), HOP = Math.round(0.02 * R);
    let buf = new Float32Array(0), base = startAt, seen = 0;
    return {
      async push(x) {
        const n = x.length;
        if (seen + n <= startAt) { seen += n; return; }
        if (seen < startAt) x = x.subarray(startAt - seen);
        seen += n;
        buf = cat(buf, x);
        while (buf.length >= MAX + WIN) {
          const cut = quietest(buf, MIN, MAX, WIN, HOP);
          const piece = buf.slice(0, cut), at = base;
          buf = buf.slice(cut); base += cut;
          await emit(piece, at);
        }
      },
      async end() {
        if (buf.length >= 0.3 * R) await emit(buf.slice(), base);
        buf = new Float32Array(0);
      },
    };
  }
  function quietest(x, from, to, win, hop) {
    const nW = Math.floor(win / hop), f0 = Math.floor(from / hop), f1 = Math.floor(to / hop);
    const e = new Float64Array(f1 + nW - f0 + 1);
    for (let f = f0; f < f1 + nW; f++) {
      let s = 0;
      const a = f * hop;
      for (let i = a; i < a + hop && i < x.length; i++) s += x[i] * x[i];
      e[f - f0] = s;
    }
    let sum = 0;
    for (let k = 0; k < nW; k++) sum += e[k];
    let best = sum, bi = 0;
    for (let f = f0 + 1; f <= f1; f++) {
      sum += e[f - f0 + nW - 1] - e[f - f0 - 1];
      if (sum < best) { best = sum; bi = f - f0; }
    }
    return (f0 + bi) * hop + (win >> 1);
  }
  // 거의 소리 없는 조각은 건너뜀(Whisper가 없는 말을 지어내지 않게): 0.3초 넘게 -50dB보다 큰 곳이 없으면
  function quiet(x) {
    const F = 320;
    let loud = 0;
    for (let i = 0; i + F <= x.length; i += F) {
      let s = 0;
      for (let j = i; j < i + F; j++) s += x[j] * x[j];
      if (s / F > 9e-6 && ++loud >= 15) return false;
    }
    return true;
  }
  // 글 다듬기: 영상 자막식 헛말 지우기, 같은 문장·짧은 말 되풀이 줄이기
  const nz = s => s.replace(/[\s.,?!…~·'"-]/g, '');
  const HALLU = /(시청해\s*주셔서\s*감사|구독과\s*좋아요|좋아요와\s*구독|구독\s*부탁|(MBC|KBS|SBS|YTN)\s*뉴스|자막\s*(제공|편집|by)|다음\s*영상에서|영상\s*(끝까지|여기까지)|thank you for watching|please subscribe)/i;
  function tidy(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const out = [];
    for (const s of t.split(/(?<=[.?!])\s+/)) {
      if (HALLU.test(s)) continue;
      if (out.length && nz(out[out.length - 1]) === nz(s)) continue;
      out.push(s);
    }
    t = out.join(' ').replace(/(\S.{1,19}?)(?:[\s,.]*\1){3,}/g, (m, g) => (/^[\d\s,.]+$/.test(g) ? m : g)).trim();
    if (/^[\s.,?!…~-]*$/.test(t) || /^[([](음악|박수|웃음|침묵|소음)[)\]]\.?$/.test(t)) return '';
    return t;
  }
  const pad = n => String(n).padStart(2, '0');
  function clock(sec) {
    const s = Math.floor(sec), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
    return (hh ? hh + ':' + pad(mm) : pad(mm)) + ':' + pad(s % 60);
  }

  /* ---------- 이어 갈 곳(이 기기에만, 조각마다) ---------- */
  const CK = id => 'kk-stt-ck-' + id;
  function loadCk(id) {
    try { const o = JSON.parse(ls.get(CK(id)) || 'null'); if (o && o.v === 1 && Array.isArray(o.lines)) return o; } catch (e) { /* 무시 */ }
    return { v: 1, pos: 0, lines: [] };
  }
  const saveCk = (id, ck) => ls.set(CK(id), JSON.stringify(ck));
  const dropCk = id => ls.set(CK(id), null);

  /* ---------- 차례 ---------- */
  const Q = [];
  let job = null, pumping = false, pumpTimer = null, laterNow = false;
  const mine = r => !!(r && r.kind === 'rec' && !r.draft && r.blob && !hasText(r) && (r.sttSt === 'wait' || r.sttSt === 'run') && r.sttBy === dev);
  function enqueue(id) { if (!Q.includes(id)) Q.push(id); pump(); }
  async function pump() {
    if (pumping) return;
    pumping = true; clearTimeout(pumpTimer);
    try {
      for (;;) {
        if (job) { pumpTimer = setTimeout(pump, 3000); break; } // 설정 창에서 모델 받는 중
        if (V() && V().busy && V().busy()) { pumpTimer = setTimeout(pump, 5000); break; } // 녹음하는 동안은 새로 시작하지 않음(모델 받기 묻기 등이 녹음을 가리지 않게)
        let next = null, soon = Infinity;
        for (const id of Q.slice()) {
          const r = await db.get(id);
          if (!mine(r)) { Q.splice(Q.indexOf(id), 1); continue; }
          if ((r.sttAfter || 0) <= Date.now()) { next = r; break; }
          soon = Math.min(soon, r.sttAfter);
        }
        if (!next) { if (soon < Infinity) pumpTimer = setTimeout(pump, Math.max(1000, soon - Date.now() + 500)); break; }
        const res = await withLock(() => runJob(next));
        if (res === 'later') break; // 모델을 아직 안 받기로 함·인터넷 없음·다른 창에서 하는 중
        const i = Q.indexOf(next.id);
        if (i >= 0) Q.splice(i, 1);
      }
    } finally {
      pumping = false;
      if (!job) { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!job) kill(); }, 180e3); } // 3분 쉬면 GPU 메모리를 돌려줌
    }
  }
  async function withLock(fn) {
    if (!navigator.locks || !navigator.locks.request) return fn();
    let ran = false, out;
    await navigator.locks.request('kk-stt', { ifAvailable: true }, async lock => { if (!lock) return; ran = true; out = await fn(); });
    return ran ? out : 'later';
  }
  async function setState(r, patch) {
    const fresh = (await db.get(r.id)) || r;
    for (const k in patch) { if (patch[k] === undefined) delete fresh[k]; else fresh[k] = patch[k]; }
    await db.putRaw(fresh);
    if (V()) V().refresh();
    return fresh;
  }
  const errText = c => (c === 'gpu' ? '이 기기 브라우저에서 GPU(WebGPU)를 쓸 수 없음' : c || '');

  async function runJob(r) {
    const g = await gpu();
    if (!g.ok) {
      // 저절로 돌 때는 알림을 띄우지 않음(녹음 저장 알림·'이어서 녹음' 버튼을 가리지 않게). 카드 표시·설정 칸에 안내, 직접 누르면 start()가 알림
      await setState(r, { sttSt: 'err', sttErr: 'gpu' });
      return 'done';
    }
    const dt = g.dt;
    if (!(await hasModel(dt))) {
      if (!navigator.onLine) return 'later';
      if (ls.get('kk-stt-ok') !== '1') {
        if (laterNow || document.visibilityState !== 'visible') return 'later';
        const ans = await askDownload(dt);
        if (ans === 'pc') { await handoff(r.id); return 'done'; }
        if (ans !== 'get') { laterNow = true; if (V()) V().refresh(); return 'later'; }
        ls.set('kk-stt-ok', '1');
      }
    }
    const ck = loadCk(r.id);
    job = { id: r.id, name: r.name || '녹음', pos: ck.pos, p0: ck.pos, total: r.duration || 0, t1: 0, stop: false, phase: 'load' };
    r = await setState(r, { sttSt: 'run', sttBy: dev, sttAt: Date.now(), sttErr: undefined });
    wakeOn();
    if (!r.sttQuiet) toast('「' + job.name + '」 녹음을 글로 바꾸고 있어요' + (A().settings.autoMinutes !== false ? ' · 끝나면 회의록을 만들어요' : '') + ' · 화면을 켜 두세요', '녹음 탭', () => A().setView('rec'), 8000);
    try {
      await ensureLoaded(dt);
      job.phase = 'run'; job.t1 = Date.now(); paint();
      const text = await transcribe(r, ck);
      const fresh = await db.get(r.id);
      if (!fresh) { dropCk(r.id); return 'done'; }
      if (hasText(fresh) && fresh.textSrc !== 'stt') { await setState(fresh, { sttSt: 'skip' }); dropCk(r.id); return 'done'; }
      if (!text.trim()) {
        await setState(fresh, { sttSt: 'done', sttAt: Date.now(), sttEmpty: true });
        dropCk(r.id);
        toast('「' + job.name + '」 녹음에서 말소리를 찾지 못했어요', null, null, 7000);
        return 'done';
      }
      fresh.text = '[녹취록]\n' + text + (fresh.memo ? '\n\n[녹음하면서 쓴 메모]\n' + fresh.memo : '');
      fresh.textSrc = 'stt'; fresh.sttSt = 'done'; fresh.sttAt = Date.now(); fresh.sttModel = 'whisper-large-v3-turbo ' + dt;
      delete fresh.sttErr; delete fresh.sttEmpty;
      await db.putRaw(fresh);
      dropCk(r.id);
      const s = A().settings, auto = s.autoMinutes !== false && KK.minutes;
      if (auto) KK.minutes.auto(fresh);
      toast('「' + job.name + '」 녹음을 글로 바꿨어요' + (auto ? (s.apiKey ? (navigator.onLine ? ' · 회의록을 만드는 중' : ' · 인터넷이 연결되면 회의록을 만들어요') : ' · API 키를 넣으면 회의록을 만들어요') : ''), '보기', () => KK.minutes.open(fresh), 9000);
      return 'done';
    } catch (e) {
      const fresh = await db.get(r.id);
      if (!fresh || e.code === 'gone') { dropCk(r.id); return 'done'; }
      if (e.code === 'replaced' || (hasText(fresh) && fresh.textSrc !== 'stt')) { await setState(fresh, { sttSt: 'skip' }); dropCk(r.id); return 'done'; }
      if (e.code === 'stop') { await setState(fresh, { sttSt: 'stop' }); toast('글로 바꾸기를 멈췄어요 · 다시 누르면 이어서 바꿔요'); return 'done'; }
      if (job && job.phase === 'load' && !navigator.onLine) { await setState(fresh, { sttSt: 'wait' }); return 'later'; }
      const msg = e.code === 'decode' ? e.message : '변환 중 문제가 생겼어요(' + String(e.message || e).slice(0, 120) + ')';
      await setState(fresh, { sttSt: 'err', sttErr: msg });
      if (e.code === 'engine') kill();
      toast('녹음을 글로 바꾸지 못했어요: ' + msg, !isPC() && syncOn() ? '노트북에 맡기기' : null, () => handoff(r.id), 10000);
      return 'done';
    } finally {
      job = null; dl = null; wakeOff();
      if (V()) V().refresh();
      renderBox();
    }
  }

  async function transcribe(r, ck) {
    const lines = ck.lines.slice();
    let last = lines.length ? lines[lines.length - 1].replace(/^\[[\d:]+\]\s*/, '') : '';
    const check = () => { if (job.stop) throw fail('stop'); };
    const emit = async (pcm, at) => {
      const n = pcm.length;
      while (V() && V().busy && V().busy()) { job.phase = 'pause'; paint(); await sleep(3000); check(); } // 녹음하는 동안은 쉼
      job.phase = 'run';
      check();
      if (!quiet(pcm)) {
        const res = await call({ t: 'run', pcm }, [pcm.buffer]);
        const t = tidy(res.text);
        if (t && t !== last) { lines.push('[' + clock(at / R) + '] ' + t); last = t; }
      }
      const fresh = await db.get(r.id);
      if (!fresh) throw fail('gone');
      if (hasText(fresh) && fresh.textSrc !== 'stt') throw fail('replaced');
      ck.pos = (at + n) / R; ck.lines = lines; saveCk(r.id, ck);
      job.pos = ck.pos; paint();
      check();
    };
    await decode(r.blob, seg(Math.round(ck.pos * R), emit));
    return lines.join('\n');
  }

  /* ---------- 바깥에서 부르는 것 ---------- */
  // 새 녹음: 끄적노트로 녹음해 저장했을 때(바로), 녹음 파일만 공유받았을 때(wait: 2분)
  async function onNew(r, opt) {
    if (!r || r.draft || !r.blob || hasText(r)) return;
    const w = where();
    if (w === 'off') return;
    if (w === 'pc') { await setState(r, { sttSt: 'pc' }); return; }
    await setState(r, { sttSt: 'wait', sttBy: dev, sttAfter: Date.now() + ((opt && opt.wait) || 0), sttQuiet: opt && opt.quiet ? true : undefined });
    enqueue(r.id);
  }
  function plan(shared) {
    const w = where();
    if (w === 'off') return '';
    if (w === 'pc') return '노트북에서 글로 바꿔요';
    return shared ? '변환 글이 따로 오지 않으면 2분 뒤 이 기기에서 글로 바꿔요' : '이 기기에서 글로 바꿔요';
  }
  async function start(id) {
    const r = await db.get(id);
    if (!r || !r.blob) return;
    const g = await gpu();
    if (!g.ok) { toast('이 기기 브라우저에서는 GPU를 쓸 수 없어 글로 바꾸지 못해요', !isPC() && syncOn() ? '노트북에 맡기기' : null, () => handoff(id), 9000); return; }
    laterNow = false;
    await setState(r, { sttSt: 'wait', sttBy: dev, sttAfter: 0, sttErr: undefined, sttQuiet: undefined });
    if (job && job.id !== id) toast('지금 바꾸는 녹음이 끝나면 이어서 바꿔요');
    enqueue(id);
  }
  async function stop(id) {
    if (job && job.id === id) { job.stop = true; toast('지금 조각까지 바꾸고 멈춰요'); return; }
    const i = Q.indexOf(id);
    if (i >= 0) Q.splice(i, 1);
    const r = await db.get(id);
    if (r) await setState(r, { sttSt: 'stop' });
  }
  async function handoff(id) {
    const r = await db.get(id);
    if (!r || hasText(r)) return;
    if (job && job.id === id) { toast('지금 바꾸는 중이에요. 멈춘 뒤 맡겨 주세요'); return; }
    const i = Q.indexOf(id);
    if (i >= 0) Q.splice(i, 1);
    await setState(r, { sttSt: 'pc', sttBy: undefined, sttAfter: undefined, sttErr: undefined });
    toast(syncOn() ? '노트북에서 끄적노트를 열면 이 녹음을 글로 바꿔요(녹음 파일이 드라이브에 올라간 뒤)' : '노트북과 맞추기(녹음 파일 포함)를 켜야 노트북이 녹음을 받아요', null, null, 9000);
  }
  // 이 기기 몫 다시 잡기(앱을 다시 열 때, 맞추기로 녹음이 들어올 때): 내 차례·끊긴 것, 노트북이면 '노트북 차례'
  let scanT = null;
  function scanSoon() { clearTimeout(scanT); scanT = setTimeout(scan, 1500); }
  async function scan() {
    if (db.usingFallback) return;
    const all = await db.all(), ids = new Set(); // ids: 아직 글이 없는 녹음(이어 갈 곳을 둘 녹음)
    for (const r of all) {
      if (r.kind !== 'rec') continue;
      if (r.draft || !r.blob || hasText(r)) continue;
      ids.add(r.id);
      if ((r.sttSt === 'wait' || r.sttSt === 'run') && r.sttBy === dev) { if (!Q.includes(r.id)) Q.push(r.id); }
      else if (r.sttSt === 'pc' && isPC() && where() !== 'off') { await setState(r, { sttSt: 'wait', sttBy: dev, sttAfter: 0 }); if (!Q.includes(r.id)) Q.push(r.id); }
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('kk-stt-ck-') && !ids.has(k.slice(10))) localStorage.removeItem(k); // 지운 녹음, 이미 글이 생긴 녹음
      }
    } catch (e) { /* 무시 */ }
    if (Q.length) pump();
  }

  /* ---------- 녹음 탭 표시 ---------- */
  function chipText(id) {
    if (!job || job.id !== id) return '';
    if (job.phase === 'load') return dl && dl.total ? '모델 받는 중 ' + Math.floor(100 * dl.loaded / dl.total) + '%' : '글로 바꿀 준비 중…';
    if (job.phase === 'pause') return '녹음 중이라 잠시 멈춤';
    let s = '글로 바꾸는 중 ' + Math.floor(job.pos / 60) + '/' + Math.max(1, Math.round(job.total / 60)) + '분';
    const done = job.pos - job.p0, sec = (Date.now() - job.t1) / 1000;
    if (done > 50 && sec > 15 && job.total > job.pos) s += ' · 약 ' + Math.max(1, Math.round((job.total - job.pos) / (done / sec) / 60)) + '분 남음';
    return s;
  }
  let paintAt = 0, paintTimer = null;
  function paint() {
    const now = Date.now();
    if (now - paintAt < 250) { if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = null; paint(); }, 260); return; }
    paintAt = now;
    document.querySelectorAll('[data-stt-chip]').forEach(el => { const t = chipText(el.dataset.sttChip); if (t) el.textContent = t; });
    const st = $('sttState');
    if (st && job && job.phase === 'load' && dl && dl.total) st.textContent = '모델 받는 중 ' + Math.round(dl.loaded / 1048576) + '/' + Math.round(dl.total / 1048576) + 'MB';
  }
  function chip(r) {
    if (r.draft) return null;
    if (job && job.id === r.id) return h('span', { class: 'chip wait', 'data-stt-chip': r.id }, chipText(r.id) || '글로 바꾸는 중…');
    if (hasText(r)) return null;
    if (Q.includes(r.id) && r.sttBy === dev) return h('span', { class: 'chip wait' }, laterNow ? '글로 바꾸기 기다림(모델 받기 전)' : (r.sttAfter || 0) > Date.now() ? '곧 글로 바꿈' : '글로 바꿀 차례');
    if (r.sttSt === 'pc') return h('span', { class: 'chip plain', title: '노트북에서 끄적노트를 열면 글로 바꿔요(노트북과 맞추기·녹음 파일 맞추기 필요)' }, '노트북에서 바꿀 차례');
    if ((r.sttSt === 'run' || r.sttSt === 'wait') && r.sttBy !== dev) return h('span', { class: 'chip plain' }, '다른 기기에서 글로 바꾸는 중');
    if (r.sttSt === 'wait') return h('span', { class: 'chip plain' }, '글로 바꾸기 기다림');
    if (r.sttSt === 'err' && r.sttErr === 'gpu') return h('span', { class: 'chip plain', title: errText('gpu') }, '이 기기에서 글로 못 바꿈');
    if (r.sttSt === 'err') return h('span', { class: 'chip', style: 'background:var(--danger-soft);color:var(--danger)', title: errText(r.sttErr) }, '글로 바꾸기 실패');
    if (r.sttSt === 'stop') { const p = loadCk(r.id).pos; return h('span', { class: 'chip plain' }, '글로 바꾸기 멈춤' + (p >= 60 ? ' · ' + Math.floor(p / 60) + '분까지' : '')); }
    if (r.sttSt === 'done' && r.sttEmpty) return h('span', { class: 'chip plain' }, '말소리 없음');
    return null;
  }
  function buttons(r) {
    if (r.draft || !r.blob || hasText(r)) return [];
    if (job && job.id === r.id) return [h('button', { type: 'button', class: 'btn', onclick: () => stop(r.id) }, '글로 바꾸기 멈추기')];
    const out = [h('button', { type: 'button', class: 'btn', onclick: () => start(r.id) }, loadCk(r.id).pos ? '이어서 글로 바꾸기' : '글로 바꾸기')];
    if (!isPC() && syncOn() && r.sttSt !== 'pc') out.push(h('button', { type: 'button', class: 'btn', onclick: () => handoff(r.id) }, '노트북에 맡기기'));
    return out;
  }

  /* ---------- 처음 한 번 모델 받기 묻기 ---------- */
  function askDownload(dt) {
    return new Promise(res => {
      const cell = navigator.connection && navigator.connection.type === 'cellular';
      const d = h('dialog', { class: 'sttdlg', 'aria-labelledby': 'sttAskHead' });
      const done = v => { if (d.open) d.close(); d.remove(); res(v); };
      d.append(h('form', { method: 'dialog', class: 'dlg', onsubmit: e => e.preventDefault() },
        h('h2', { id: 'sttAskHead' }, '녹음을 글로 바꿀 준비'),
        h('p', null, '이 기기에서 녹음을 글로 바꾸려면 음성 인식 모델(Whisper, 약 ' + MB[dt] + 'MB)을 처음 한 번 받아야 해요. 모델은 이 기기에 보관하고, 녹음 소리는 기기 밖으로 보내지 않아요.'),
        h('p', { class: cell ? 'errmsg' : 'hint' }, cell ? '지금 모바일 데이터로 연결돼 있어요. 와이파이에서 받는 게 좋아요.' : '와이파이에서 받으세요. 받는 동안 앱을 켜 두세요.'),
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { type: 'button', class: 'btn ghost', onclick: () => done('later') }, '나중에'),
          !isPC() && syncOn() ? h('button', { type: 'button', class: 'btn', onclick: () => done('pc') }, '노트북에 맡기기') : null,
          h('button', { type: 'button', class: 'btn primary', onclick: () => done('get') }, '받기'))));
      d.addEventListener('cancel', e => { e.preventDefault(); done('later'); });
      document.body.append(d);
      d.showModal();
    });
  }

  /* ---------- 설정 창 ---------- */
  async function renderBox() {
    const box = $('sttBox');
    if (!box) return;
    const line = h('p', { class: 'hint', id: 'sttState' }, '확인 중…'), row = h('div', { class: 'row' });
    box.textContent = '';
    box.append(line, row);
    const g = await gpu();
    if (!g.ok) { line.textContent = '이 기기 브라우저에서는 GPU(WebGPU)를 쓸 수 없어 글로 바꿀 수 없어요.' + (isPC() ? '' : ' 노트북에 맡기기를 고르세요.'); return; }
    const have = await hasModel(g.dt);
    if (job && job.phase === 'load') { line.textContent = '모델 받는 중…'; paint(); return; }
    line.textContent = have ? '음성 인식 모델: 받아 둠(약 ' + MB[g.dt] + 'MB) · 이 기기 브라우저에 보관' : '음성 인식 모델: 아직 안 받음(약 ' + MB[g.dt] + 'MB). 처음 글로 바꿀 때 받을지 물어요.';
    if (!have) row.append(h('button', { type: 'button', class: 'btn', onclick: () => getModel(g.dt) }, '지금 모델 받기'));
    else row.append(h('button', { type: 'button', class: 'btn danger', onclick: async () => {
      if (job) { toast('글로 바꾸는 중에는 지울 수 없어요'); return; }
      await dropModel(); ls.set('kk-stt-ok', null); renderBox(); toast('모델을 지웠어요');
    } }, '모델 지우기'));
  }
  async function getModel(dt) {
    if (job) { toast('지금 글로 바꾸는 중이에요'); return; }
    if (!navigator.onLine) { toast('인터넷에 연결된 뒤 받아 주세요'); return; }
    if (navigator.connection && navigator.connection.type === 'cellular' && !confirm('지금 모바일 데이터예요. 약 ' + MB[dt] + 'MB를 받을까요?')) return;
    ls.set('kk-stt-ok', '1'); laterNow = false;
    job = { id: '', phase: 'load', stop: false };
    const st = $('sttState');
    if (st) st.textContent = '모델 받는 중…';
    try { await ensureLoaded(dt); toast('음성 인식 모델을 받았어요'); }
    catch (e) { toast('모델을 받지 못했어요: ' + String(e.message || e).slice(0, 100), null, null, 8000); }
    finally { job = null; dl = null; renderBox(); idleTimer = setTimeout(() => { if (!job) kill(); }, 60e3); if (Q.length) pump(); }
  }

  /* ---------- 화면 켜 두기 ---------- */
  let wl = null;
  async function wakeOn() {
    try { if (!wl && navigator.wakeLock && document.visibilityState === 'visible') { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch (e) { /* 무시 */ }
  }
  function wakeOff() { try { if (wl) wl.release(); } catch (e) { /* 무시 */ } wl = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (job) wakeOn(); else if (Q.length) pump();
  });
  window.addEventListener('online', () => { if (Q.length) pump(); });

  KK.stt = { onNew, plan, start, stop, handoff, scan, scanSoon, chip, buttons, renderBox, forget: dropCk,
    _t: { mp4Audio, decode, seg, tidy, quietest, quiet, clock, hasModel, gpu, dev, state: () => ({ job: job && Object.assign({}, job), Q: Q.slice(), dl, laterNow }) } };

  (A() && A().ready ? A().ready : Promise.resolve()).catch(() => {}).then(() => setTimeout(scan, 4000));
})();
