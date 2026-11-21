// Guarda o app e os modelos do leitor de texto no aparelho, para abrir sem internet.
const VERSAO = 'tradutor-hq-v10';
// modelos do leitor de texto: ficam guardados entre versões do app (só mudam se o nome mudar)
const MODELOS = 'tradutor-hq-modelos-v1';
const ARQUIVOS = [
  './', 'index.html', 'style.css', 'app.js', 'paddle.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/jszip.min.js', 'vendor/ort.wasm.min.js', 'vendor/ort-wasm-simd-threaded.mjs',
  'vendor/ort-wasm-simd-threaded.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO && n !== MODELOS).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** Usa o guardado; se não tiver, baixa e guarda. */
async function guardadoPrimeiro(nomeCache, req) {
  const cache = await caches.open(nomeCache);
  const guardado = await cache.match(req, { ignoreSearch: true });
  if (guardado) return guardado;
  const r = await fetch(req);
  if (r.ok) cache.put(req, r.clone());
  return r;
}

/** Tenta a internet primeiro (pega atualizações na hora); sem internet, usa o guardado. */
async function redePrimeiro(req) {
  const cache = await caches.open(VERSAO);
  try {
    const r = await fetch(req, { cache: 'no-cache' });
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch (_) {
    return (await cache.match(req, { ignoreSearch: true })) || new Response('Sem conexão', { status: 503 });
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // traduções do Google passam direto
  if (url.pathname.includes('/modelos/')) e.respondWith(guardadoPrimeiro(MODELOS, e.request));
  // o motor do leitor (vendor/) é grande e só muda junto com a versão; o resto do app vem atualizado
  else if (url.pathname.includes('/vendor/')) e.respondWith(guardadoPrimeiro(VERSAO, e.request));
  else e.respondWith(redePrimeiro(e.request));
});
