/**
 * KOMwind Service Worker
 *
 * Strategie:
 * - App-Shell (HTML/CSS/JS/Fonts): Cache-First → funktioniert offline
 * - Open-Meteo API: Network-First mit Cache-Fallback (max 1h alt)
 * - Strava API: Network-Only (kein sensitives Caching)
 */

const CACHE_NAME = 'komwind-v1';
const WEATHER_CACHE = 'komwind-weather-v1';

const APP_SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/wind.js',
  './js/app.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;600;700&family=Barlow:wght@400;500&display=swap',
];

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== WEATHER_CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { url } = event.request;

  // Strava API → immer Network, nie cachen
  if (url.includes('strava.com') || url.includes('workers.dev')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Open-Meteo → Network-First, Cache-Fallback (max 1h)
  if (url.includes('open-meteo.com')) {
    event.respondWith(networkFirstWeather(event.request));
    return;
  }

  // Google Fonts → Cache-First
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // App Shell → Cache-First
  event.respondWith(cacheFirst(event.request, CACHE_NAME));
});

// ─── Strategien ──────────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — kein Cache verfügbar', { status: 503 });
  }
}

async function networkFirstWeather(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(WEATHER_CACHE);
      // Timestamp für Max-Age-Check einbauen
      const cloned = response.clone();
      const data = await cloned.json();
      const withTimestamp = new Response(
        JSON.stringify({ ...data, _cachedAt: Date.now() }),
        { headers: { 'Content-Type': 'application/json' } }
      );
      cache.put(request, withTimestamp);
      return response;
    }
  } catch {
    // Netzwerk nicht verfügbar → Cache prüfen
  }

  const cached = await caches.match(request);
  if (cached) {
    const data = await cached.json();
    const age = Date.now() - (data._cachedAt || 0);
    const ONE_HOUR = 60 * 60 * 1000;
    if (age < ONE_HOUR) return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(
    JSON.stringify({ error: 'Wetterdaten nicht verfügbar (offline)' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

// ─── Background Sync (optional, für später) ──────────────────────────────────
// Wenn der Browser Background Sync unterstützt, könnten wir hier
// Wetterdaten automatisch im Hintergrund aktualisieren.
self.addEventListener('sync', event => {
  if (event.tag === 'refresh-weather') {
    // TODO: Wetterdaten im Hintergrund aktualisieren
    console.log('[SW] Background sync: weather refresh');
  }
});
