/* 끄적노트 — 오프라인 캐시 + 공유받기. 앱 파일을 고치면 VERSION 숫자를 올리세요. */
const VERSION = 'kk-v6';
const SHELL = [
  './', 'index.html', 'store.js', 'ink.js', 'claude.js', 'ui.js', 'views.js', 'gcal.js', 'app.js', 'voice.js', 'search.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const KEEP = [VERSION, 'kk-fonts', 'kk-share'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 삼성 노트 등에서 '공유 → 끄적노트'로 보낸 파일을 받아 두고 앱으로 넘긴다 */
async function receiveShare(req) {
  const fd = await req.formData();
  const c = await caches.open('kk-share');
  const meta = { title: String(fd.get('title') || ''), text: [fd.get('text'), fd.get('url')].filter(Boolean).join('\n'), files: [] };
  const files = fd.getAll('files').filter(f => f && typeof f === 'object' && f.size);
  for (let i = 0; i < files.length; i++) {
    const f = files[i], key = 'share-file-' + Date.now() + '-' + i;
    await c.put(key, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'shared-' + i) } }));
    meta.files.push(key);
  }
  await c.put('share-meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(req).catch(() => Response.redirect(new URL('./', self.registration.scope).href, 303)));
    return;
  }
  if (req.method !== 'GET') return;

  // 글꼴: 한 번 받으면 오프라인에서도 사용
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('kk-fonts').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return; // Claude API 등은 그대로 통과

  // 앱 파일: 캐시 먼저 보여주고 뒤에서 새 버전 받아두기
  e.respondWith(caches.open(VERSION).then(async c => {
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await c.match(key);
    const net = fetch(req).then(res => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    return res || new Response('오프라인입니다', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }));
});
