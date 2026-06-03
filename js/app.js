/**
 * KOM Reaper — App Controller v3
 * Features: Favoriten, Sortierung, Strecken-Analyse, Karte, KOM-Bestzeiten
 */

const App = (() => {

  const WORKER_URL = KR_CONFIG.WORKER_URL;

  // ─── State ────────────────────────────────────────────────────────────────
  const state = {
    screen: 'auth',
    activeTab: 'segments',
    prevScreen: 'segments',      // for back-button context
    token: null,
    refreshToken: null,
    expiresAt: null,
    segments: [],                // scored segments (starred)
    weather: null,
    activeSegment: null,
    sortMode: 'wind',            // wind | favorites | alpha
    favorites: new Set(),        // segment IDs
    segmentCache: {},            // id → detail data (polyline, etc.)
    activities: [],              // recent rides
    routeSegments: [],           // scored segments for selected activity
    activeActivity: null,
  };

  // ─── Persistence ──────────────────────────────────────────────────────────
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
    clear() { ['kw_token','kw_refresh','kw_expires'].forEach(k => sessionStorage.removeItem(k)); },
  };

  // Favorites persist in localStorage
  function loadFavorites() {
    try {
      const raw = localStorage.getItem('kw_favorites');
      if (raw) JSON.parse(raw).forEach(id => state.favorites.add(id));
    } catch {}
  }
  function saveFavorites() {
    localStorage.setItem('kw_favorites', JSON.stringify([...state.favorites]));
  }
  function toggleFavorite(segId) {
    const id = String(segId);
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    saveFavorites();
  }

  // ─── Screen Router ────────────────────────────────────────────────────────
  function showScreen(name, opts = {}) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(`screen-${name}`);
    if (el) el.classList.add('active');
    state.prevScreen = state.screen;
    state.screen = name;

    // Show tab bar for main screens and child screens of tabs
    const tabBar = document.getElementById('tab-bar');
    const hideTabs = ['auth', 'loading'].includes(name);
    tabBar.style.display = hideTabs ? 'none' : 'flex';

    // Update active tab highlight based on context
    const tabName = (name === 'segments' || name === 'detail')     ? 'segments'
                  : (name === 'routes' || name === 'route-detail') ? 'routes'
                  : null;
    if (tabName) {
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabName);
      });
      if (['segments','routes'].includes(name)) state.activeTab = name;
    }
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────
  function startStravaAuth() {
    window.location.href = `${WORKER_URL}/strava/auth`;
  }

  function readTokenFromFragment() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;
    const p = new URLSearchParams(hash);
    const token = p.get('token');
    if (!token) return null;
    window.history.replaceState({}, '', window.location.pathname);
    return { token, expiresAt: Number(p.get('expires_at') || 0), refreshToken: p.get('refresh_token') || '' };
  }

  function readErrorFromQuery() {
    const p = new URLSearchParams(window.location.search);
    const e = p.get('error');
    if (e) window.history.replaceState({}, '', window.location.pathname);
    return e;
  }

  function isTokenExpired() {
    return !state.expiresAt || Date.now() / 1000 > state.expiresAt - 300;
  }

  async function ensureFreshToken() {
    if (!isTokenExpired()) return;
    if (!state.refreshToken) throw new Error('Kein Refresh-Token — bitte neu einloggen');
    const res = await fetch(`${WORKER_URL}/strava/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.refreshToken }),
    });
    if (!res.ok) { TS.clear(); throw new Error('Token-Refresh fehlgeschlagen'); }
    const data = await res.json();
    state.token = data.access_token;
    state.expiresAt = data.expires_at;
    state.refreshToken = data.refresh_token;
    TS.save(state.token, state.refreshToken, state.expiresAt);
  }

  // ─── Strava API ───────────────────────────────────────────────────────────
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
    const segs = await stravaFetch('/strava/segments');
    return segs
      .filter(s => s.start_latlng?.length >= 2 && s.end_latlng?.length >= 2)
      .map(s => ({
        id: s.id,
        name: s.name,
        distance: s.distance || 0,
        avg_grade: s.average_grade || 0,
        bearing: WindEngine.bearingFromCoords(
          s.start_latlng[0], s.start_latlng[1],
          s.end_latlng[0],   s.end_latlng[1]
        ),
        lat: s.start_latlng[0], lon: s.start_latlng[1],
        endLat: s.end_latlng[0], endLon: s.end_latlng[1],
        typicalSpeed: gradeToTypicalSpeed(s.average_grade || 0),
      }));
  }

  async function fetchActivities() {
    // Fetch last 20 rides
    return stravaFetch('/strava/activities?per_page=20&type=Ride');
  }

  async function fetchActivitySegments(activityId) {
    const activity = await stravaFetch(`/strava/activity/${activityId}`);
    const efforts = activity.segment_efforts || [];
    return efforts.map(e => ({
      id:           e.segment.id,
      name:         e.segment.name,
      distance:     e.segment.distance,
      avg_grade:    e.segment.average_grade,
      bearing:      WindEngine.bearingFromCoords(
                      e.segment.start_latlng[0], e.segment.start_latlng[1],
                      e.segment.end_latlng[0],   e.segment.end_latlng[1]),
      lat:          e.segment.start_latlng[0],
      lon:          e.segment.start_latlng[1],
      endLat:       e.segment.end_latlng[0],
      endLon:       e.segment.end_latlng[1],
      typicalSpeed: gradeToTypicalSpeed(e.segment.average_grade),
      myBestTime:   e.elapsed_time,  // effort on this ride
    }));
  }

  async function enrichSegmentDetail(seg) {
    if (state.segmentCache[seg.id]) {
      Object.assign(seg, state.segmentCache[seg.id]);
      return seg;
    }
    try {
      const detail = await stravaFetch(`/strava/segment/${seg.id}`);
      if (detail.map?.polyline) {
        const points = decodePolyline(detail.map.polyline);
        if (points.length >= 2) {
          seg.bearing = WindEngine.weightedBearingFromPolyline(points);
          seg.polylinePoints = points;
          seg.endLat = points[points.length-1][0];
          seg.endLon = points[points.length-1][1];
        }
      }
      state.segmentCache[seg.id] = {
        bearing: seg.bearing,
        polylinePoints: seg.polylinePoints,
        endLat: seg.endLat,
        endLon: seg.endLon,
      };
    } catch {}
    return seg;
  }

  // ─── Open-Meteo ───────────────────────────────────────────────────────────
  async function fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=windspeed_10m,winddirection_10m&windspeed_unit=kmh&forecast_days=2&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Wetter-API nicht erreichbar');
    const data = await res.json();
    const h = new Date().getHours();
    const forecast = [];
    for (let i = 0; i < 12; i++) {
      const idx = h + i;
      if (idx >= data.hourly.time.length) break;
      forecast.push({
        time: data.hourly.time[idx].split('T')[1].slice(0,5),
        windDirection: data.hourly.winddirection_10m[idx],
        windSpeed: data.hourly.windspeed_10m[idx],
      });
    }
    return { windDirection: data.hourly.winddirection_10m[h], windSpeed: data.hourly.windspeed_10m[h], forecast };
  }

  // ─── Demo Data ────────────────────────────────────────────────────────────
  const DEMO_SEGMENTS = [
    { id: 1, name: 'Piesberg Nordrampe',          distance: 1840, avg_grade: 6.2,  bearing: 178, lat: 52.31, lon: 8.03, endLat: 52.29, endLon: 8.04, typicalSpeed: 19 },
    { id: 2, name: 'Teutoburger Wald Flachstück', distance: 4200, avg_grade: 0.8,  bearing: 82,  lat: 52.28, lon: 8.12, endLat: 52.29, endLon: 8.18, typicalSpeed: 38 },
    { id: 3, name: 'Dörenberg Auffahrt',          distance: 2100, avg_grade: 8.4,  bearing: 215, lat: 52.15, lon: 8.06, endLat: 52.13, endLon: 8.04, typicalSpeed: 14 },
    { id: 4, name: 'Hasbergen Sprint',            distance: 680,  avg_grade: 1.1,  bearing: 310, lat: 52.21, lon: 7.98, endLat: 52.22, endLon: 7.96, typicalSpeed: 42 },
    { id: 5, name: 'Natruper Feld',               distance: 3100, avg_grade: 0.3,  bearing: 55,  lat: 52.33, lon: 8.09, endLat: 52.35, endLon: 8.13, typicalSpeed: 40 },
  ];

  function gradeToTypicalSpeed(g) {
    if (g < 1) return 38; if (g < 3) return 32; if (g < 6) return 22; if (g < 10) return 15; return 11;
  }

  // ─── Score + Sort Segments ────────────────────────────────────────────────
  function scoreAndSort(segments, weather) {
    const scored = segments.map(seg => {
      const result = WindEngine.scoreSegment(
        {
          bearing: isFinite(seg.bearing) ? seg.bearing : 0,
          gradient: isFinite(seg.avg_grade) ? seg.avg_grade : 0,
          typicalSpeedKmh: isFinite(seg.typicalSpeed) ? seg.typicalSpeed : 30,
        },
        {
          windDirection: isFinite(weather.windDirection) ? weather.windDirection : 0,
          windSpeed: isFinite(weather.windSpeed) ? weather.windSpeed : 0,
        }
      );
      // Ensure rating always exists
      if (!result.rating) result.rating = WindEngine.getRating(0);
      return { ...seg, ...result };
    });

    if (state.sortMode === 'wind') {
      return scored.sort((a, b) => b.effectiveTailwind - a.effectiveTailwind);
    }
    if (state.sortMode === 'favorites') {
      return scored.sort((a, b) => {
        const fa = state.favorites.has(String(a.id));
        const fb = state.favorites.has(String(b.id));
        if (fa !== fb) return fb - fa;
        return b.effectiveTailwind - a.effectiveTailwind;
      });
    }
    if (state.sortMode === 'alpha') {
      return scored.sort((a, b) => a.name.localeCompare(b.name));
    }
    return scored;
  }

  // ─── Render: Segment Card ─────────────────────────────────────────────────
  function createSegmentCard(seg, onClickDetail) {
    const card = document.createElement('div');
    card.className = 'segment-card';
    card.setAttribute('role', 'listitem');

    const tw   = isFinite(seg.effectiveTailwind) ? seg.effectiveTailwind : 0;
    const r    = seg.rating || WindEngine.getRating(0);
    const sign = tw >= 0 ? '+' : '';
    const isFav = state.favorites.has(String(seg.id));

    card.innerHTML = `
      <div class="seg-score ${r.colorClass}" style="border-color:${r.color};color:${r.color}">
        <span class="seg-score-val">${sign}${Math.round(tw)}</span>
        <span class="seg-score-unit">km/h</span>
      </div>
      <div class="seg-info">
        <p class="seg-name">${seg.name}</p>
        <p class="seg-meta">${(seg.distance/1000).toFixed(1)} km · ${seg.avg_grade > 0 ? '+' : ''}${seg.avg_grade}%</p>
      </div>
      <div class="seg-actions">
        <button class="fav-btn ${isFav ? 'active' : ''}" data-id="${seg.id}" aria-label="Favorit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"><path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/></svg>
        </button>
        <div class="seg-rating" style="color:${r.color}">${r.label}</div>
      </div>
    `;

    // Favorite button
    card.querySelector('.fav-btn').addEventListener('click', e => {
      e.stopPropagation();
      toggleFavorite(seg.id);
      // Re-render
      if (state.screen === 'segments') renderSegments(state.segments.map(s => s.id === seg.id ? { ...s } : s), state.weather);
      else renderRouteSegments(state.routeSegments, state.weather);
    });

    card.addEventListener('click', () => onClickDetail(seg));
    return card;
  }

  // ─── Render: Segments Tab ─────────────────────────────────────────────────
  function renderSegments(segments, weather) {
    state.segments = segments;
    const list = document.getElementById('segments-list');
    list.innerHTML = '';

    document.getElementById('weather-summary').textContent =
      `${Math.round(weather.windSpeed)} km/h ${WindEngine.compassLabel(weather.windDirection)}`;

    const scored = scoreAndSort(segments, weather);
    scored.forEach(seg => {
      list.appendChild(createSegmentCard(seg, s => openDetail(s, weather, 'segments')));
    });
  }

  // ─── Render: Activities List ──────────────────────────────────────────────
  function renderActivities(activities) {
    const list = document.getElementById('activities-list');
    list.innerHTML = '';

    if (!activities.length) {
      list.innerHTML = `<div class="empty-state">Keine Aktivitäten gefunden</div>`;
      return;
    }

    activities.forEach((act, i) => {
      const date = new Date(act.start_date_local);
      const dateStr = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
      const distKm = (act.distance / 1000).toFixed(1);
      const card = document.createElement('div');
      card.className = 'activity-card';
      card.style.animationDelay = `${i * 0.05}s`;
      card.innerHTML = `
        <div class="act-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/></svg>
        </div>
        <div class="act-info">
          <p class="act-name">${act.name}</p>
          <p class="act-meta">${dateStr} · ${distKm} km · ${act.segment_efforts?.length || '?'} Segmente</p>
        </div>
        <svg class="act-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>
      `;
      card.addEventListener('click', () => loadRouteDetail(act));
      list.appendChild(card);
    });
  }

  // ─── Load Route Detail ────────────────────────────────────────────────────
  async function loadRouteDetail(activity) {
    state.activeActivity = activity;
    showScreen('loading');
    document.getElementById('loading-text').textContent = 'Analysiere Segmente';

    try {
      let segments;

      if (!state.token) {
        // Demo: use starred segments as fake route segments
        segments = DEMO_SEGMENTS;
      } else {
        segments = await fetchActivitySegments(activity.id);
        // Enrich first 8 with polylines (parallel, throttled)
        const toEnrich = segments.slice(0, 8);
        await Promise.allSettled(toEnrich.map(s => enrichSegmentDetail(s)));
      }

      const anchor = segments[0] || { lat: 52.28, lon: 8.05 };
      const weather = await fetchWeather(anchor.lat, anchor.lon);
      state.weather = weather;
      state.routeSegments = segments;

      document.getElementById('route-detail-name').textContent = activity.name;
      document.getElementById('route-detail-meta').textContent =
        `${(activity.distance/1000).toFixed(1)} km · ${segments.length} Segmente`;

      document.getElementById('routes-weather-summary').textContent =
        `${Math.round(weather.windSpeed)} km/h ${WindEngine.compassLabel(weather.windDirection)}`;

      renderRouteSegments(segments, weather);
      showScreen('route-detail');

    } catch (err) {
      document.getElementById('loading-text').textContent = `Fehler: ${err.message}`;
      setTimeout(() => showScreen('routes'), 2500);
    }
  }

  function renderRouteSegments(segments, weather) {
    const list = document.getElementById('route-segments-list');
    list.innerHTML = '';
    const scored = scoreAndSort(segments, weather);
    scored.forEach(seg => {
      list.appendChild(createSegmentCard(seg, s => openDetail(s, weather, 'route-detail')));
    });
  }

  // ─── Detail Screen ────────────────────────────────────────────────────────
  function openDetail(seg, weather, fromScreen) {
    state.activeSegment = seg;
    state.prevScreen = fromScreen;

    const tw   = isFinite(seg.effectiveTailwind) ? seg.effectiveTailwind : 0;
    const r    = seg.rating || WindEngine.getRating(0);
    const sign = tw >= 0 ? '+' : '';

    document.getElementById('back-label').textContent =
      fromScreen === 'route-detail' ? 'Strecke' : 'Alle Segmente';

    document.getElementById('detail-ring').style.borderColor = r.color;
    const twEl = document.getElementById('detail-tailwind');
    twEl.textContent = sign + Math.round(tw);
    twEl.style.color = r.color;

    document.getElementById('detail-name').textContent = seg.name;
    document.getElementById('detail-meta').textContent =
      `${(seg.distance/1000).toFixed(1)} km · Steigung ${seg.avg_grade}%`;

    document.getElementById('detail-icon').textContent  = r.icon;
    document.getElementById('detail-label').textContent = r.label;
    document.getElementById('detail-sub').textContent   = r.sub;

    document.getElementById('detail-wspeed').textContent   = `${Math.round(weather.windSpeed)} km/h`;
    document.getElementById('detail-wdir').textContent     = WindEngine.formatWindDir(weather.windDirection);
    document.getElementById('detail-gradient').textContent = `${seg.avg_grade}%`;
    document.getElementById('detail-relevance').textContent =
      `${Math.round(WindEngine.windRelevanceFactor(seg.avg_grade) * 100)}%`;

    document.getElementById('strava-link').href = `https://www.strava.com/segments/${seg.id}`;

    renderForecast(seg, weather.forecast);
    showScreen('detail');

    setTimeout(() => {
      renderMap(seg);
      renderKomSection(seg);
    }, 60);
  }

  // ─── Leaflet Map ──────────────────────────────────────────────────────────
  let _map = null;

  function renderMap(seg) {
    const container = document.getElementById('segment-map');
    if (!container) return;
    if (_map) { _map.remove(); _map = null; }

    const points = seg.polylinePoints ||
      [[seg.lat, seg.lon], [seg.endLat || seg.lat + 0.002, seg.endLon || seg.lon + 0.002]];

    _map = L.map(container, { zoomControl: false, attributionControl: false, scrollWheelZoom: false });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(_map);

    L.polyline(points, { color: '#ff6b1a', weight: 4, opacity: 0.9 }).addTo(_map);

    const mkStart = L.divIcon({ className: '', html: '<div class="reaper-marker reaper-marker-start"></div>', iconSize: [10,10], iconAnchor: [5,5] });
    const mkEnd   = L.divIcon({ className: '', html: '<div class="reaper-marker reaper-marker-end"></div>',   iconSize: [10,10], iconAnchor: [5,5] });
    L.marker(points[0], { icon: mkStart }).addTo(_map);
    L.marker(points[points.length-1], { icon: mkEnd }).addTo(_map);

    _map.fitBounds(L.polyline(points).getBounds(), { padding: [24, 24] });
  }

  // ─── KOM Section ──────────────────────────────────────────────────────────
  async function renderKomSection(seg) {
    const container = document.getElementById('kom-cards');
    if (!container) return;
    container.innerHTML = `<div class="kom-loading"><div class="spinner-sm"></div><span>Lade Bestzeiten…</span></div>`;

    if (!state.token) {
      container.innerHTML = `<div class="kom-no-effort">Im Demo-Modus nicht verfügbar</div>`;
      return;
    }

    try {
      const [effortRes, lbRes] = await Promise.allSettled([
        stravaFetch(`/strava/athlete/efforts?segment_id=${seg.id}`),
        stravaFetch(`/strava/segment/${seg.id}/leaderboard`),
      ]);

      const effort   = effortRes.status === 'fulfilled' ? effortRes.value?.[0] : null;
      const lb       = lbRes.status === 'fulfilled' ? lbRes.value : null;
      const komEntry = lb?.entries?.[0];

      if (!effort) {
        container.innerHTML = `<div class="kom-no-effort">Noch kein Effort auf diesem Segment</div>`;
        return;
      }

      const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
      const myTime  = effort.elapsed_time;
      const komTime = komEntry?.elapsed_time || null;

      let html = `
        <div class="kom-card highlight">
          <p class="kom-card-label">Deine Bestzeit</p>
          <p class="kom-card-value">${fmt(myTime)}</p>
          <p class="kom-card-sub">${new Date(effort.start_date_local).toLocaleDateString('de-DE')}</p>
        </div>`;

      if (komTime && komTime !== myTime) {
        const gap = myTime - komTime;
        const gapPct = Math.max(0, Math.min(100, 100 - (gap / myTime) * 100));
        html += `
          <div class="kom-card">
            <p class="kom-card-label">KOM-Zeit</p>
            <p class="kom-card-value">${fmt(komTime)}</p>
            <p class="kom-card-sub">${komEntry?.athlete_name || 'KOM'}</p>
          </div>
          <div class="kom-gap-bar">
            <div class="kom-gap-label">
              <span>Rückstand auf KOM</span>
              <span style="color:var(--muted)">${gapPct.toFixed(0)}% dort</span>
            </div>
            <div class="kom-gap-track"><div class="kom-gap-fill" style="width:${gapPct}%"></div></div>
            <p class="kom-gap-value">${gap > 0 ? '-' : ''}${fmt(Math.abs(gap))}</p>
          </div>`;
      } else {
        html += `
          <div class="kom-card" style="border-color:rgba(255,215,0,0.4);background:rgba(255,215,0,0.05)">
            <p class="kom-card-label">Status</p>
            <p class="kom-card-value" style="color:var(--yellow)">KOM 👑</p>
            <p class="kom-card-sub">Du führst die Bestenliste an</p>
          </div>`;
      }

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<div class="kom-no-effort">Bestzeiten konnten nicht geladen werden</div>`;
    }
  }

  // ─── Forecast ─────────────────────────────────────────────────────────────
  function renderForecast(seg, forecast) {
    const list = document.getElementById('forecast-list');
    list.innerHTML = '';
    const scored = forecast.map(f => ({
      ...f,
      ...WindEngine.scoreSegment(
        { bearing: seg.bearing, gradient: seg.avg_grade, typicalSpeedKmh: seg.typicalSpeed },
        { windDirection: f.windDirection, windSpeed: f.windSpeed }
      ),
    }));
    const maxAbs = Math.max(...scored.map(s => Math.abs(s.effectiveTailwind)), 1);
    scored.forEach(s => {
      const tw = s.effectiveTailwind;
      const r  = s.rating;
      const item = document.createElement('div');
      item.className = 'forecast-item';
      item.innerHTML = `
        <span class="fc-time">${s.time}</span>
        <div class="fc-bar-wrap"><div class="fc-bar" style="width:${Math.round(Math.abs(tw)/maxAbs*100)}%;background:${r.color}"></div></div>
        <span class="fc-val" style="color:${r.color}">${tw>=0?'+':''}${Math.round(tw)} km/h</span>`;
      list.appendChild(item);
    });
  }

  // ─── Polyline Decoder ─────────────────────────────────────────────────────
  function decodePolyline(encoded) {
    const pts = []; let i = 0, lat = 0, lng = 0;
    while (i < encoded.length) {
      let b, shift = 0, result = 0;
      do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : result >> 1;
      shift = result = 0;
      do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : result >> 1;
      pts.push([lat/1e5, lng/1e5]);
    }
    return pts;
  }

  // ─── Load: Segments Tab ───────────────────────────────────────────────────
  async function loadSegmentsTab(isDemo = false) {
    showScreen('loading');
    document.getElementById('loading-text').textContent = 'Lade Segmente';

    try {
      let segments, weather;
      if (isDemo) {
        weather = await fetchWeather(52.28, 8.05).catch(() => ({ windDirection: 240, windSpeed: 15, forecast: [] }));
        segments = DEMO_SEGMENTS;
      } else {
        segments = await fetchStarredSegments();
        // Enrich polylines in background — failures don't block rendering
        Promise.allSettled(segments.slice(0, 5).map(s => enrichSegmentDetail(s)))
          .then(() => {
            // Re-render with enriched data once polylines are loaded
            if (state.screen === 'segments' && state.weather) {
              renderSegments(state.segments, state.weather);
            }
          });
        document.getElementById('loading-text').textContent = 'Lade Wetter';
        weather = await fetchWeather(segments[0]?.lat || 52.28, segments[0]?.lon || 8.05);
      }
      console.log('[KR] Segments loaded:', segments.length, 'Weather:', weather.windSpeed, 'km/h');
      state.weather = weather;
      showScreen('segments');
      renderSegments(segments, weather);
    } catch (err) {
      console.error('loadSegmentsTab error:', err);
      document.getElementById('loading-text').textContent = `Fehler: ${err.message}`;
      // Don't redirect to auth on weather failure — show what we have
      if (err.message?.includes('Strava') || err.message?.includes('Token')) {
        setTimeout(() => showScreen('auth'), 3000);
      } else {
        // Weather failed but segments loaded — show them anyway with fallback weather
        if (typeof segments !== 'undefined' && segments.length > 0) {
          const fallbackWeather = { windDirection: 0, windSpeed: 0, forecast: [] };
          state.weather = fallbackWeather;
          showScreen('segments');
          renderSegments(segments, fallbackWeather);
        } else {
          setTimeout(() => showScreen('auth'), 3000);
        }
      }
    }
  }

  // ─── Load: Routes Tab ─────────────────────────────────────────────────────
  async function loadRoutesTab() {
    if (state.activities.length) {
      showScreen('routes');
      renderActivities(state.activities);
      return;
    }

    showScreen('loading');
    document.getElementById('loading-text').textContent = 'Lade Aktivitäten';

    try {
      if (!state.token) {
        // Demo: fake activities
        state.activities = [
          { id: 1, name: 'Morgenrunde Teuto', distance: 42300, start_date_local: '2024-05-01T08:00:00Z', segment_efforts: [{}, {}, {}, {}] },
          { id: 2, name: 'Mittwochsrunde',    distance: 61200, start_date_local: '2024-04-28T07:30:00Z', segment_efforts: [{}, {}, {}, {}, {}] },
          { id: 3, name: 'Sonntags-Ausfahrt', distance: 88400, start_date_local: '2024-04-21T09:15:00Z', segment_efforts: [{}, {}, {}] },
        ];
      } else {
        state.activities = await fetchActivities();
      }
      showScreen('routes');
      renderActivities(state.activities);
    } catch (err) {
      document.getElementById('loading-text').textContent = `Fehler: ${err.message}`;
      setTimeout(() => showScreen('segments'), 2500);
    }
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────
  async function refresh() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    state.activities = []; // force reload
    try {
      if (state.activeTab === 'routes') await loadRoutesTab();
      else await loadSegmentsTab(!state.token);
    } finally { btn.classList.remove('spinning'); }
  }

  // ─── Sort UI ──────────────────────────────────────────────────────────────
  function setupSortMenu() {
    const btn = document.getElementById('sort-btn');
    const dd  = document.getElementById('sort-dropdown');

    btn.addEventListener('click', e => {
      e.stopPropagation();
      dd.classList.toggle('open');
    });
    document.addEventListener('click', () => dd.classList.remove('open'));

    document.querySelectorAll('.sort-option').forEach(opt => {
      opt.addEventListener('click', () => {
        state.sortMode = opt.dataset.sort;
        document.querySelectorAll('.sort-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        dd.classList.remove('open');
        if (state.weather) renderSegments(state.segments, state.weather);
      });
    });
  }

  // ─── Offline Banner ───────────────────────────────────────────────────────
  function setupOfflineDetection() {
    const banner = document.createElement('div');
    banner.className = 'offline-banner';
    banner.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg> Offline — letzte Daten werden angezeigt`;
    document.querySelector('.app-header').after(banner);
    window.addEventListener('offline', () => banner.classList.add('visible'));
    window.addEventListener('online',  () => banner.classList.remove('visible'));
    if (!navigator.onLine) banner.classList.add('visible');
  }

  // ─── Install Prompt ───────────────────────────────────────────────────────
  let deferredInstall = null;
  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault(); deferredInstall = e;
      setTimeout(() => {
        if (['segments','routes'].includes(state.screen)) showInstallBanner();
      }, 30000);
    });
  }
  function showInstallBanner() {
    if (document.getElementById('install-prompt')) return;
    const p = document.createElement('div');
    p.id = 'install-prompt'; p.className = 'install-prompt visible';
    p.innerHTML = `<div class="install-text"><strong>App installieren</strong><span>Direkt vom Homescreen starten</span></div><button class="install-btn" id="install-btn">Installieren</button><button class="install-close" id="install-close">×</button>`;
    document.body.appendChild(p);
    document.getElementById('install-btn').addEventListener('click', async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt(); await deferredInstall.userChoice;
      deferredInstall = null; p.remove();
    });
    document.getElementById('install-close').addEventListener('click', () => p.remove());
  }

  function addDemoButton() {
    if (document.getElementById('demo-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'demo-btn'; btn.textContent = 'Demo ohne Strava'; btn.className = 'btn-demo';
    btn.addEventListener('click', () => loadSegmentsTab(true));
    document.querySelector('.auth-note').before(btn);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    loadFavorites();
    setupOfflineDetection();
    setupInstallPrompt();
    setupSortMenu();

    const authError = readErrorFromQuery();
    if (authError) { showScreen('auth'); addDemoButton(); return; }

    const frag = readTokenFromFragment();
    if (frag) {
      state.token = frag.token; state.refreshToken = frag.refreshToken; state.expiresAt = frag.expiresAt;
      TS.save(state.token, state.refreshToken, state.expiresAt);
      loadSegmentsTab(false); return;
    }

    const saved = TS.load();
    if (saved.token) {
      state.token = saved.token; state.refreshToken = saved.refreshToken; state.expiresAt = saved.expiresAt;
      loadSegmentsTab(false); return;
    }

    showScreen('auth'); addDemoButton();
  }

  // ─── Events ───────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    init();

    document.getElementById('connect-strava-btn').addEventListener('click', startStravaAuth);
    document.getElementById('refresh-btn').addEventListener('click', refresh);

    // Back buttons
    document.getElementById('back-btn').addEventListener('click', () => {
      showScreen(state.prevScreen || 'segments');
    });
    document.getElementById('back-route-btn').addEventListener('click', () => showScreen('routes'));

    // Tab bar
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const t = tab.dataset.tab;
        if (t === 'segments') {
          if (state.segments.length) showScreen('segments');
          else loadSegmentsTab(!state.token);
        } else if (t === 'routes') {
          loadRoutesTab();
        }
      });
    });
  });

})();
