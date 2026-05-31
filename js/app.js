/**
 * KOMwind — App Controller
 *
 * Auth-Flow:
 *   PWA → Worker /strava/auth → Strava OAuth → Worker /strava/callback
 *   → Redirect zurück zur PWA mit #token=... im Fragment
 *
 * Token-Lebensdauer: Strava-Tokens laufen nach 6h ab.
 * Refresh läuft automatisch über Worker /strava/refresh.
 */

const App = (() => {

  // ─── Config ────────────────────────────────────────────────────────────────
  // Einzige Stelle, die du anpassen musst:
  const WORKER_URL = 'https://komwind-worker.ofnewchapterrosie.workers.dev';

  // ─── State ─────────────────────────────────────────────────────────────────
  const state = {
    screen: 'auth',
    token: null,
    refreshToken: null,
    expiresAt: null,
    segments: [],
    weather: null,
    activeSegment: null,
  };

  // ─── Token Storage ─────────────────────────────────────────────────────────
  // sessionStorage: Token überlebt Page-Reload, nicht Browser-Neustart.
  // Für "angemeldet bleiben": auf localStorage wechseln.
  const TS = {
    save(token, refreshToken, expiresAt) {
      sessionStorage.setItem('kw_token', token);
      sessionStorage.setItem('kw_refresh', refreshToken);
      sessionStorage.setItem('kw_expires', String(expiresAt));
    },
    load() {
      return {
        token:        sessionStorage.getItem('kw_token'),
        refreshToken: sessionStorage.getItem('kw_refresh'),
        expiresAt:    Number(sessionStorage.getItem('kw_expires') || 0),
      };
    },
    clear() {
      ['kw_token','kw_refresh','kw_expires'].forEach(k => sessionStorage.removeItem(k));
    },
  };

  // ─── Screen Router ─────────────────────────────────────────────────────────
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(`screen-${name}`);
    if (el) el.classList.add('active');
    state.screen = name;
  }

  // ─── Strava Auth ───────────────────────────────────────────────────────────
  function startStravaAuth() {
    // Worker übernimmt den Redirect zu Strava — kein Client Secret im Frontend.
    window.location.href = `${WORKER_URL}/strava/auth`;
  }

  // Token aus URL-Fragment lesen (nach OAuth-Callback)
  function readTokenFromFragment() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const token       = params.get('token');
    const expiresAt   = Number(params.get('expires_at') || 0);
    const refreshToken = params.get('refresh_token') || '';
    if (!token) return null;
    // Fragment aus URL entfernen (kein erneutes Lesen nach Reload)
    window.history.replaceState({}, '', window.location.pathname);
    return { token, expiresAt, refreshToken };
  }

  // Fehler-Parameter aus URL lesen (bei Auth-Fehlern)
  function readErrorFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) window.history.replaceState({}, '', window.location.pathname);
    return error;
  }

  // Token abgelaufen? (mit 5-Minuten-Puffer)
  function isTokenExpired() {
    if (!state.expiresAt) return true;
    return Date.now() / 1000 > state.expiresAt - 300;
  }

  // Token automatisch refreshen
  async function ensureFreshToken() {
    if (!isTokenExpired()) return;
    if (!state.refreshToken) throw new Error('Kein Refresh-Token — bitte neu einloggen');

    const res = await fetch(`${WORKER_URL}/strava/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.refreshToken }),
    });

    if (!res.ok) {
      TS.clear();
      throw new Error('Token-Refresh fehlgeschlagen — bitte neu einloggen');
    }

    const data = await res.json();
    state.token       = data.access_token;
    state.expiresAt   = data.expires_at;
    state.refreshToken = data.refresh_token;
    TS.save(state.token, state.refreshToken, state.expiresAt);
  }

  // ─── Strava API (via Worker-Proxy) ─────────────────────────────────────────
  async function stravaFetch(endpoint) {
    await ensureFreshToken();
    const res = await fetch(`${WORKER_URL}${endpoint}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Strava-Fehler ${res.status}`);
    }
    return res.json();
  }

  async function fetchStarredSegments() {
    const segments = await stravaFetch('/strava/segments');
    return segments.map(seg => ({
      id:           seg.id,
      name:         seg.name,
      distance:     seg.distance,
      avg_grade:    seg.average_grade,
      bearing:      WindEngine.bearingFromCoords(
                      seg.start_latlng[0], seg.start_latlng[1],
                      seg.end_latlng[0],   seg.end_latlng[1]
                    ),
      lat:          seg.start_latlng[0],
      lon:          seg.start_latlng[1],
      typicalSpeed: gradeToTypicalSpeed(seg.average_grade),
    }));
  }

  // Optional: Segment-Detail mit Polyline für genaueren Bearing
  async function enrichSegmentBearing(seg) {
    try {
      const detail = await stravaFetch(`/strava/segment/${seg.id}`);
      if (detail.map?.polyline) {
        const points = decodePolyline(detail.map.polyline);
        if (points.length >= 2) {
          seg.bearing = WindEngine.weightedBearingFromPolyline(points);
        }
      }
    } catch {
      // Fallback auf Start→End-Bearing bleibt
    }
    return seg;
  }

  // Google Encoded Polyline → Array von [lat, lon]
  function decodePolyline(encoded) {
    const points = [];
    let index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : result >> 1;
      shift = result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : result >> 1;
      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  }

  function gradeToTypicalSpeed(grade) {
    if (grade < 1)  return 38;
    if (grade < 3)  return 32;
    if (grade < 6)  return 22;
    if (grade < 10) return 15;
    return 11;
  }

  // ─── Open-Meteo ────────────────────────────────────────────────────────────
  async function fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=windspeed_10m,winddirection_10m`
      + `&windspeed_unit=kmh`
      + `&forecast_days=2`
      + `&timezone=auto`;

    const res = await fetch(url);
    if (!res.ok) throw new Error('Wetter-API nicht erreichbar');
    const data = await res.json();

    const now = new Date();
    const currentHour = now.getHours();

    const windSpeed    = data.hourly.windspeed_10m[currentHour];
    const windDirection = data.hourly.winddirection_10m[currentHour];

    // 12 Stunden ab jetzt, auch über Mitternacht hinaus
    const forecast = [];
    for (let i = 0; i < 12; i++) {
      const idx = currentHour + i;
      if (idx >= data.hourly.time.length) break;
      forecast.push({
        time:          data.hourly.time[idx].split('T')[1].slice(0, 5),
        windDirection: data.hourly.winddirection_10m[idx],
        windSpeed:     data.hourly.windspeed_10m[idx],
      });
    }

    return { windDirection, windSpeed, forecast };
  }

  // ─── Demo-Modus ────────────────────────────────────────────────────────────
  const DEMO_SEGMENTS = [
    { id: 1, name: 'Piesberg Nordrampe',       distance: 1840, avg_grade: 6.2,  bearing: 178, lat: 52.31, lon: 8.03, typicalSpeed: 19 },
    { id: 2, name: 'Teutoburger Wald Flachstück', distance: 4200, avg_grade: 0.8, bearing: 82, lat: 52.28, lon: 8.12, typicalSpeed: 38 },
    { id: 3, name: 'Dörenberg Auffahrt',       distance: 2100, avg_grade: 8.4,  bearing: 215, lat: 52.15, lon: 8.06, typicalSpeed: 14 },
    { id: 4, name: 'Hasbergen Sprint',         distance: 680,  avg_grade: 1.1,  bearing: 310, lat: 52.21, lon: 7.98, typicalSpeed: 42 },
    { id: 5, name: 'Natruper Feld',            distance: 3100, avg_grade: 0.3,  bearing: 55,  lat: 52.33, lon: 8.09, typicalSpeed: 40 },
  ];

  // ─── Render: Segments ──────────────────────────────────────────────────────
  function renderSegments(segments, weather) {
    const list = document.getElementById('segments-list');
    list.innerHTML = '';

    document.getElementById('weather-summary').textContent =
      `${Math.round(weather.windSpeed)} km/h ${WindEngine.compassLabel(weather.windDirection)}`;

    const scored = segments.map(seg => {
      const result = WindEngine.scoreSegment(
        { bearing: seg.bearing, gradient: seg.avg_grade, typicalSpeedKmh: seg.typicalSpeed },
        weather
      );
      return { ...seg, ...result };
    }).sort((a, b) => b.effectiveTailwind - a.effectiveTailwind);

    state.segments = scored;

    scored.forEach(seg => {
      const card = document.createElement('div');
      card.className = 'segment-card';
      card.setAttribute('role', 'listitem');

      const tw   = seg.effectiveTailwind;
      const r    = seg.rating;
      const sign = tw >= 0 ? '+' : '';

      card.innerHTML = `
        <div class="seg-score ${r.colorClass}" style="border-color:${r.color};color:${r.color}">
          <span class="seg-score-val">${sign}${Math.round(tw)}</span>
          <span class="seg-score-unit">km/h</span>
        </div>
        <div class="seg-info">
          <p class="seg-name">${seg.name}</p>
          <p class="seg-meta">${(seg.distance / 1000).toFixed(1)} km · ${seg.avg_grade > 0 ? '+' : ''}${seg.avg_grade}%</p>
        </div>
        <div class="seg-rating" style="color:${r.color}">${r.label}</div>
      `;
      card.addEventListener('click', () => showDetail(seg, weather));
      list.appendChild(card);
    });
  }

  // ─── Render: Detail ────────────────────────────────────────────────────────
  function showDetail(seg, weather) {
    state.activeSegment = seg;
    const tw   = seg.effectiveTailwind;
    const r    = seg.rating;
    const sign = tw >= 0 ? '+' : '';

    document.getElementById('detail-ring').style.borderColor = r.color;
    const twEl = document.getElementById('detail-tailwind');
    twEl.textContent = sign + Math.round(tw);
    twEl.style.color = r.color;

    document.getElementById('detail-name').textContent = seg.name;
    document.getElementById('detail-meta').textContent =
      `${(seg.distance / 1000).toFixed(1)} km · Steigung ${seg.avg_grade}%`;

    document.getElementById('detail-icon').textContent  = r.icon;
    document.getElementById('detail-label').textContent = r.label;
    document.getElementById('detail-sub').textContent   = r.sub;

    document.getElementById('detail-wspeed').textContent   = `${Math.round(weather.windSpeed)} km/h`;
    document.getElementById('detail-wdir').textContent     = WindEngine.formatWindDir(weather.windDirection);
    document.getElementById('detail-gradient').textContent = `${seg.avg_grade}%`;
    const pct = Math.round(WindEngine.windRelevanceFactor(seg.avg_grade) * 100);
    document.getElementById('detail-relevance').textContent = `${pct}%`;

    renderForecast(seg, weather.forecast);
    showScreen('detail');
  }

  function renderForecast(seg, forecast) {
    const list = document.getElementById('forecast-list');
    list.innerHTML = '';
    const scored = forecast.map(f => {
      const result = WindEngine.scoreSegment(
        { bearing: seg.bearing, gradient: seg.avg_grade, typicalSpeedKmh: seg.typicalSpeed },
        { windDirection: f.windDirection, windSpeed: f.windSpeed }
      );
      return { ...f, ...result };
    });
    const maxAbs = Math.max(...scored.map(s => Math.abs(s.effectiveTailwind)), 1);
    scored.forEach(s => {
      const tw       = s.effectiveTailwind;
      const r        = s.rating;
      const sign     = tw >= 0 ? '+' : '';
      const barWidth = Math.round((Math.abs(tw) / maxAbs) * 100);
      const item = document.createElement('div');
      item.className = 'forecast-item';
      item.innerHTML = `
        <span class="fc-time">${s.time}</span>
        <div class="fc-bar-wrap"><div class="fc-bar" style="width:${barWidth}%;background:${r.color}"></div></div>
        <span class="fc-val" style="color:${r.color}">${sign}${Math.round(tw)} km/h</span>
      `;
      list.appendChild(item);
    });
  }

  // ─── Load Data ─────────────────────────────────────────────────────────────
  async function loadData(isDemo = false) {
    showScreen('loading');
    const loadingText = document.getElementById('loading-text');

    try {
      let segments, weather;

      if (isDemo) {
        loadingText.textContent = 'Lade Wetterdaten…';
        try {
          weather = await fetchWeather(52.28, 8.05);
        } catch {
          weather = { windDirection: 240, windSpeed: 15, forecast: [] };
        }
        segments = DEMO_SEGMENTS;
      } else {
        loadingText.textContent = 'Lade Strava-Segmente…';
        segments = await fetchStarredSegments();

        // Ersten 5 Segmente mit Polyline anreichern (API-Limit schonen)
        const toEnrich = segments.slice(0, 5);
        await Promise.allSettled(toEnrich.map(s => enrichSegmentBearing(s)));

        loadingText.textContent = 'Lade Wetterdaten…';
        const anchor = segments[0] || { lat: 52.28, lon: 8.05 };
        weather = await fetchWeather(anchor.lat, anchor.lon);
      }

      state.weather = weather;
      showScreen('segments');
      renderSegments(segments, weather);

    } catch (err) {
      loadingText.textContent = `Fehler: ${err.message}`;
      console.error(err);
      // Nach 3s zurück zum Auth-Screen
      setTimeout(() => showScreen('auth'), 3000);
    }
  }

  // ─── Refresh ───────────────────────────────────────────────────────────────
  async function refresh() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    const isDemo = !state.token;
    try { await loadData(isDemo); }
    finally { btn.classList.remove('spinning'); }
  }

  // ─── Offline Banner ────────────────────────────────────────────────────────
  function setupOfflineDetection() {
    const banner = document.createElement('div');
    banner.className = 'offline-banner';
    banner.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
      </svg>
      Offline — letzte Daten werden angezeigt
    `;
    document.querySelector('.app-header').after(banner);
    window.addEventListener('offline', () => banner.classList.add('visible'));
    window.addEventListener('online',  () => banner.classList.remove('visible'));
    if (!navigator.onLine) banner.classList.add('visible');
  }

  // ─── Install Prompt ────────────────────────────────────────────────────────
  let deferredInstall = null;

  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredInstall = e;
      setTimeout(() => {
        if (state.screen === 'segments' || state.screen === 'detail') showInstallBanner();
      }, 30000);
    });
  }

  function showInstallBanner() {
    if (document.getElementById('install-prompt')) return;
    const prompt = document.createElement('div');
    prompt.id = 'install-prompt';
    prompt.className = 'install-prompt visible';
    prompt.innerHTML = `
      <div class="install-text">
        <strong>App installieren</strong>
        <span>Direkt vom Homescreen starten</span>
      </div>
      <button class="install-btn" id="install-btn">Installieren</button>
      <button class="install-close" id="install-close" aria-label="Schließen">×</button>
    `;
    document.body.appendChild(prompt);
    document.getElementById('install-btn').addEventListener('click', async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      prompt.remove();
    });
    document.getElementById('install-close').addEventListener('click', () => prompt.remove());
  }

  // ─── Compass Animation ─────────────────────────────────────────────────────
  function animateCompass() {
    const needle = document.getElementById('demo-needle');
    if (!needle) return;
    let angle = 0;
    setInterval(() => {
      angle = (angle + 2.5) % 360;
      needle.style.transform = `translate(-50%, -100%) rotate(${angle}deg)`;
    }, 50);
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  function init() {
    setupOfflineDetection();
    setupInstallPrompt();
    animateCompass();

    // 1. Auth-Fehler aus URL?
    const authError = readErrorFromQuery();
    if (authError) {
      showScreen('auth');
      const note = document.querySelector('.auth-note');
      if (note) note.textContent = `Anmeldung fehlgeschlagen (${authError}). Bitte erneut versuchen.`;
      addDemoButton();
      return;
    }

    // 2. Token aus URL-Fragment (nach OAuth-Callback)
    const fromFragment = readTokenFromFragment();
    if (fromFragment) {
      state.token        = fromFragment.token;
      state.refreshToken = fromFragment.refreshToken;
      state.expiresAt    = fromFragment.expiresAt;
      TS.save(state.token, state.refreshToken, state.expiresAt);
      loadData(false);
      return;
    }

    // 3. Gespeicherter Token
    const saved = TS.load();
    if (saved.token) {
      state.token        = saved.token;
      state.refreshToken = saved.refreshToken;
      state.expiresAt    = saved.expiresAt;
      loadData(false);
      return;
    }

    // 4. Kein Token → Auth-Screen
    showScreen('auth');
    addDemoButton();
  }

  function addDemoButton() {
    if (document.getElementById('demo-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'demo-btn';
    btn.textContent = 'Demo ohne Strava';
    btn.style.cssText = [
      'display:block', 'width:calc(100% - 3rem)', 'margin:0 1.5rem',
      'padding:0.75rem', 'background:transparent',
      'border:0.5px solid rgba(255,255,255,0.15)', 'border-radius:12px',
      'color:#888', "font-family:'Barlow',sans-serif", 'font-size:15px',
      'cursor:pointer',
    ].join(';');
    btn.addEventListener('click', () => loadData(true));
    document.querySelector('.auth-note').before(btn);
  }

  // ─── Events ────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    init();
    document.getElementById('connect-strava-btn').addEventListener('click', startStravaAuth);
    document.getElementById('back-btn').addEventListener('click', () => showScreen('segments'));
    document.getElementById('refresh-btn').addEventListener('click', refresh);
  });

})();
