// Guarda o app e os idiomas do leitor de texto no aparelho, para abrir sem internet.
const VERSAO = 'tradutor-hq-v9';
const IDIOMAS = 'tradutor-hq-idiomas';   // não muda com a versão: o idioma baixado continua guardado
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
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO && n !== IDIOMAS).map((n) => caches.delete(n))))
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
  if (url.origin === location.origin) {
    // o leitor de texto (vendor/) é grande e só muda junto com a versão; o resto do app vem atualizado
    e.respondWith(url.pathname.includes('/vendor/') ? guardadoPrimeiro(VERSAO, e.request) : redePrimeiro(e.request));
  } else if (url.href.startsWith('https://cdn.jsdelivr.net/npm/@tesseract.js-data/')) {
    // dados de idioma do leitor de texto: baixa uma vez e guarda
    e.respondWith(guardadoPrimeiro(IDIOMAS, e.request));
  }
  // traduções do Google passam direto
});
