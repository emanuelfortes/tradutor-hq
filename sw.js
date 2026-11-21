// Guarda o app no aparelho para abrir sem internet.
const VERSAO = 'tradutor-hq-v7';
const ARQUIVOS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/tesseract.min.js', 'vendor/worker.min.js', 'vendor/jszip.min.js',
  'vendor/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract-core-lstm.wasm.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Arquivos do próprio app: usa o que está guardado, e atualiza em segundo plano.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.open(VERSAO).then(async (cache) => {
        const guardado = await cache.match(e.request, { ignoreSearch: true });
        const rede = fetch(e.request).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => null);
        return guardado || (await rede) || new Response('Sem conexão', { status: 503 });
      }),
    );
  }
  // Traduções do Google e dados de idioma passam direto (o Tesseract guarda os idiomas sozinho).
});
