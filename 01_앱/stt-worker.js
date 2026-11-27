/* 끄적노트 — 녹음 글자 변환 일꾼 (모듈 Worker, kk-v32)
   화면이 멈추지 않게 여기서 Whisper(transformers.js + WebGPU)를 돌린다. stt.js가 부른다.
   - 모델은 허깅페이스에서 처음 한 번 받아 브라우저 저장소(transformers-cache)에 둔다. 받는 판(revision)은 stt.js가 고정
     (transformers.js 4.3.2는 config·tokenizer_config 같은 파일을 revision 없이 'main'에서 찾음 → 주소 틀에 판을 박아 둠)
   - 받아 둔 모델을 열 때는 진행 표시를 안 받음 → 크기 확인 요청도 없음(인터넷 없이 열림)
   - 소리(PCM)는 이 기기 안에서만 다룬다. 밖으로 보내는 것은 모델 파일 요청뿐 */
import { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, env } from './vendor/transformers-4.3.2/transformers.min.js';

const ORT = new URL('./vendor/ort-1.31.0-dev.20260914/', import.meta.url).href;
env.allowLocalModels = false;
env.useWasmCache = false; // 엔진 파일은 앱 서비스워커가 보관(kk-vendor)
env.backends.onnx.wasm.wasmPaths = { mjs: ORT + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: ORT + 'ort-wasm-simd-threaded.asyncify.wasm' };

let proc = null, tok = null, model = null, key = '';
const post = (o, tr) => self.postMessage(o, tr || []);

async function free() {
  if (model) { try { await model.dispose(); } catch (e) { /* 무시 */ } }
  proc = null; tok = null; model = null; key = '';
}

async function load(m) {
  const k = [m.host, m.model, m.rev, m.dt].join('|');
  if (model && key === k) { post({ t: 'ready', id: m.id, ms: 0 }); return; }
  await free();
  env.remoteHost = m.host;
  env.remotePathTemplate = '{model}/resolve/' + encodeURIComponent(m.rev) + '/';
  const files = {};
  let last = 0;
  const progress_callback = p => {
    if (p.status !== 'progress' || !p.total) return;
    files[p.file] = [p.loaded || 0, p.total];
    const now = performance.now();
    if (now - last < 300 && p.loaded < p.total) return;
    last = now;
    let a = 0, b = 0;
    for (const f in files) { a += files[f][0]; b += files[f][1]; }
    post({ t: 'dl', loaded: a, total: b });
  };
  const o = { revision: m.rev };
  if (m.progress) o.progress_callback = progress_callback;
  const t0 = performance.now();
  const got = await Promise.all([
    AutoProcessor.from_pretrained(m.model, o),
    AutoTokenizer.from_pretrained(m.model, o),
    WhisperForConditionalGeneration.from_pretrained(m.model, Object.assign({ device: 'webgpu', dtype: { encoder_model: m.dt, decoder_model_merged: m.dt } }, o)),
  ]);
  [proc, tok, model] = got;
  key = k;
  post({ t: 'ready', id: m.id, ms: Math.round(performance.now() - t0) });
}

async function run(m) {
  const t0 = performance.now();
  // 30초 안쪽 조각 하나씩 받음(stt.js가 말이 쉬는 곳에서 자름)
  const inputs = await proc(m.pcm);
  const out = await model.generate(Object.assign({}, inputs, { max_new_tokens: 400, language: 'korean', task: 'transcribe' }));
  const text = (tok.batch_decode(out, { skip_special_tokens: true })[0] || '').trim();
  post({ t: 'text', id: m.id, text, ms: Math.round(performance.now() - t0) });
}

self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.t === 'load') await load(m);
    else if (m.t === 'run') { if (!model) throw new Error('모델을 아직 불러오지 않았어요'); await run(m); }
    else if (m.t === 'free') { await free(); post({ t: 'freed', id: m.id }); }
  } catch (err) {
    post({ t: 'err', id: m.id, msg: String((err && err.message) || err).slice(0, 300) });
  }
};
