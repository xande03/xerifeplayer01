/**
 * Service Worker — Xerife Player (PWA)
 *
 * Estratégias:
 *  • Navegação (HTML) → network-first com fallback ao shell em cache
 *  • Assets estáticos (mesma origem) → cache-first
 *  • Catálogos do Saimo (.txt) → network-first com fallback ao cache (offline)
 *  • Imagens (TMDB / weserv) → stale-while-revalidate
 *  • API TMDB → cache-first (12h)
 *  • Streams de vídeo (m3u8/ts/mp4, workers.dev, api/stream) → rede direta
 *    (nunca cacheados — são grandes e dinâmicos)
 */

const VERSION = 'xerife-v1.0.6-diario';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const DATA_CACHE = `${VERSION}-data`;
const IMG_CACHE = `${VERSION}-img`;
const API_CACHE = `${VERSION}-api`;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
];

const CATALOG_HOSTS = ['canais-saimo.pages.dev', 'filmes-saimo.pages.dev'];
const IMAGE_HOSTS = ['image.tmdb.org', 'images.weserv.nl'];
const API_HOSTS = ['api.themoviedb.org'];
const VIDEO_EXT = /\.(m3u8|ts|mp4|mkv|m4s|mpd|aac|webm)(\?|$)/i;
const STREAM_HOSTS = [
  'saimo-tv.pages.dev/api/stream',
  'workers.dev',
  'cdn13embed.xyz',
  'embedplayer2.xyz',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(SHELL_FILES.map((f) => cache.add(new Request(f, { cache: 'reload' }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isVideoRequest(url, request) {
  if (request.destination === 'video' || request.destination === 'audio') return true;
  if (VIDEO_EXT.test(url.pathname) || VIDEO_EXT.test(url.href)) return true;
  return STREAM_HOSTS.some((h) => url.href.includes(h));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Range requests (vídeo) — deixa o navegador cuidar direto da rede
  if (request.headers.get('range')) return;

  // Streams de vídeo: sempre rede, sem cache
  if (isVideoRequest(url, request)) return;

  // Endpoints /api da mesma origem (proxy de stream, status) — SEMPRE rede, nunca cache
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Navegação (HTML)
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/', fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cached =
            (await caches.match(request)) ||
            (await caches.match('/')) ||
            (await caches.match('/index.html'));
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Catálogos Saimo (.txt) — network-first com fallback
  if (CATALOG_HOSTS.includes(url.hostname) && url.pathname.endsWith('.txt')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(DATA_CACHE);
        try {
          const fresh = await fetch(request);
          if (fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cached = await cache.match(request);
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // API TMDB — cache-first 12h
  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(API_CACHE);
        const cached = await cache.match(request);
        if (cached) {
          const ts = Number(cached.headers.get('sw-date') || 0);
          if (ts && Date.now() - ts < 12 * 3600_000) return cached;
        }
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const headers = new Headers(fresh.headers);
            headers.set('sw-date', String(Date.now()));
            const copy = new Response(fresh.clone().body, { status: fresh.status, statusText: fresh.statusText, headers });
            cache.put(request, copy).catch(() => {});
          }
          return fresh;
        } catch {
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Imagens — stale-while-revalidate
  if (IMAGE_HOSTS.includes(url.hostname) || /\.(png|jpe?g|webp|svg|gif)$/i.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(IMG_CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })(),
    );
    return;
  }

  // Assets da mesma origem — cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const fresh = await fetch(request);
          if (fresh.ok && (url.pathname.startsWith('/assets/') || ASSET_CACHE.length)) {
            cache.put(request, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          return cached || Response.error();
        }
      })(),
    );
  }
});
