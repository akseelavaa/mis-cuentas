// Service worker: la app funciona sin conexión.
// Estrategia: precarga de todos los ficheros al instalar y "caché primero".
// Para publicar una versión nueva, sube VERSION: los teléfonos descargarán todo de nuevo
// la próxima vez que abran la app con conexión.
// (tests/pwa.test.js comprueba que ARCHIVOS incluye todos los ficheros necesarios.)

const VERSION = 'v4-2';
const CACHE = `mis-cuentas-${VERSION}`;

const ARCHIVOS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'vendor/sql-wasm.js',
  'vendor/sql-wasm.wasm',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'src/errors.js',
  'src/domain/money.js',
  'src/domain/dates.js',
  'src/domain/csv.js',
  'src/db/migrations.js',
  'src/db/connection.js',
  'src/db/storage-idb.js',
  'src/services/util.js',
  'src/services/index.js',
  'src/services/catalogo.js',
  'src/services/ajustes.js',
  'src/services/saldos.js',
  'src/services/metas.js',
  'src/services/presupuestos.js',
  'src/services/previsiones.js',
  'src/services/movimientos.js',
  'src/services/analitica.js',
  'src/services/plan.js',
  'src/services/respaldo.js',
  'src/ui/main.js',
  'src/ui/estado.js',
  'src/ui/dom.js',
  'src/ui/piezas.js',
  'src/ui/form-movimiento.js',
  'src/ui/form-meta.js',
  'src/ui/form-ajustes.js',
  'src/ui/archivos.js',
  'src/ui/copias.js',
  'src/ui/vistas/inicio.js',
  'src/ui/vistas/movimientos.js',
  'src/ui/vistas/analisis.js',
  'src/ui/vistas/metas.js',
  'src/ui/vistas/plan.js',
  'src/ui/vistas/ajustes.js',
  'src/ui/vistas/bienvenida.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' evita que la caché HTTP del navegador sirva ficheros viejos
      .then((c) => c.addAll(ARCHIVOS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k.startsWith('mis-cuentas-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Navegación (abrir la app, recargar): siempre index.html de la caché
    if (req.mode === 'navigate') {
      return (await cache.match('index.html')) ?? fetch(req);
    }
    const enCache = await cache.match(req, { ignoreSearch: true });
    if (enCache) return enCache;
    try {
      return await fetch(req);
    } catch {
      return new Response('Sin conexión', { status: 503, statusText: 'Sin conexión' });
    }
  })());
});
