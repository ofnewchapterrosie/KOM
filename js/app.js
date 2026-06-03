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
    activityFilter: 'Ride',      // Ride | Run | all
    activitySearch: '',          // search string
    routeSegments: [],           // scored segments for selected activity
    activeActivity: null,
    clusters: [],
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
    const tabName = (name === 'segments' || name === 'detail')                      ? 'segments'
                  : (name === 'routes' || name === 'route-detail')                     ? 'routes'
                  : (name === 'clusters' || name === 'cluster-detail')                 ? 'clusters'
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
    // Fetch last 40 activities (mixed types), filter client-side
    return stravaFetch('/strava/activities?per_page=40');
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

    // KOM probability
    const prob = WindEngine.komProbability(
      tw, seg.komGapSeconds || null,
      seg.distance / 1000, seg.avg_grade,
      state.weather ? WindEngine.windVariance(state.weather.forecast) : 0
    );
    const probColor = prob >= 70 ? '#4ade80' : prob >= 45 ? '#ffd700' : prob >= 25 ? '#fb923c' : '#f87171';

    // Direction recommendation
    const dirs = state.weather ? WindEngine.bothDirections(seg.bearing, state.weather, seg.avg_grade) : null;
    const dirBadge = dirs && dirs.gain > 2
      ? `<span class="dir-badge">${WindEngine.directionLabel(
          dirs.recommended === 'forward' ? dirs.forwardBearing : dirs.reverseBearing
        )}</span>`
      : '';

    card.innerHTML = `
      <div class="seg-score ${r.colorClass}" style="border-color:${r.color};color:${r.color}">
        <span class="seg-score-val">${sign}${Math.round(tw)}</span>
        <span class="seg-score-unit">km/h</span>
      </div>
      <div class="seg-info">
        <p class="seg-name">${seg.name}</p>
        <p class="seg-meta">${(seg.distance/1000).toFixed(1)} km · ${seg.avg_grade > 0 ? '+' : ''}${seg.avg_grade}%</p>
        <div class="seg-badges">${dirBadge}</div>
      </div>
      <div class="seg-actions">
        <div class="prob-badge" style="color:${probColor};border-color:${probColor}" title="KOM-Chance">
          ${prob}<span style="font-size:9px">%</span>
        </div>
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
    // Render filter bar once
    let filterBar = document.getElementById('activity-filter-bar');
    if (!filterBar) {
      filterBar = document.createElement('div');
      filterBar.id = 'activity-filter-bar';
      filterBar.className = 'activity-filter-bar';
      filterBar.innerHTML = `
        <div class="act-search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="act-search" class="act-search" placeholder="Strecke suchen…" />
        </div>
        <div class="act-type-toggle">
          <button class="act-type-btn ${state.activityFilter === 'Ride' ? 'active' : ''}" data-type="Ride">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5V14l-3-3 4-3 2 3h2"/></svg>
            Rad
          </button>
          <button class="act-type-btn ${state.activityFilter === 'Run' ? 'active' : ''}" data-type="Run">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/><path d="m7 21 3-3 2-5 3 3 2-4"/><path d="m5 14 2-5 4 1 2-4"/></svg>
            Laufen
          </button>
          <button class="act-type-btn ${state.activityFilter === 'all' ? 'active' : ''}" data-type="all">Alle</button>
        </div>`;
      document.getElementById('activities-list').before(filterBar);

      // Search handler
      document.getElementById('act-search').addEventListener('input', e => {
        state.activitySearch = e.target.value.toLowerCase();
        renderActivityList(state.activities);
      });
      // Type filter handler
      filterBar.querySelectorAll('.act-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          state.activityFilter = btn.dataset.type;
          filterBar.querySelectorAll('.act-type-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderActivityList(state.activities);
        });
      });
    }

    renderActivityList(activities);
  }

  function renderActivityList(activities) {
    const list = document.getElementById('activities-list');
    list.innerHTML = '';

    // Apply type filter
    const typeMap = {
      'Ride': ['Ride', 'VirtualRide', 'GravelRide', 'EBikeRide'],
      'Run':  ['Run', 'VirtualRun', 'TrailRun'],
      'all':  null,
    };
    const allowed = typeMap[state.activityFilter] || null;
    let filtered = activities.filter(a => {
      if (allowed && !allowed.includes(a.type)) return false;
      if (state.activitySearch && !a.name.toLowerCase().includes(state.activitySearch)) return false;
      return true;
    });

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">Keine Aktivitäten gefunden</div>`;
      return;
    }

    const icons = {
      Ride: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5V14l-3-3 4-3 2 3h2"/></svg>`,
      Run:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/><path d="m7 21 3-3 2-5 3 3 2-4"/><path d="m5 14 2-5 4 1 2-4"/></svg>`,
    };

    filtered.forEach((act, i) => {
      const date = new Date(act.start_date_local);
      const dateStr = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
      const distKm = (act.distance / 1000).toFixed(1);
      const isRide = ['Ride','VirtualRide','GravelRide','EBikeRide'].includes(act.type);
      const icon = isRide ? icons.Ride : (icons[act.type] || icons.Run);
      const card = document.createElement('div');
      card.className = 'activity-card';
      card.style.animationDelay = `${i * 0.04}s`;
      card.innerHTML = `
        <div class="act-icon ${isRide ? 'act-icon-ride' : 'act-icon-run'}">${icon}</div>
        <div class="act-info">
          <p class="act-name">${act.name}</p>
          <p class="act-meta">${dateStr} · ${distKm} km</p>
        </div>
        <svg class="act-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`;
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

    // Share button
    document.getElementById('share-btn').onclick = () => shareSegment(seg, weather);

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
      // Use segment detail which includes athlete_segment_stats (PR + rank)
      // and own efforts endpoint for the most recent PR date
      const [detailRes, effortRes] = await Promise.allSettled([
        stravaFetch(`/strava/segment/${seg.id}`),
        stravaFetch(`/strava/athlete/efforts?segment_id=${seg.id}`),
      ]);

      const detail = detailRes.status === 'fulfilled' ? detailRes.value : null;
      const effort = effortRes.status === 'fulfilled' ? effortRes.value?.[0] : null;

      // athlete_segment_stats contains: pr_elapsed_time, effort_count, kom_rank
      const stats   = detail?.athlete_segment_stats;
      const prTime  = stats?.pr_elapsed_time || effort?.elapsed_time || null;
      const komRank = stats?.kom_rank || null;  // null = not ranked / API restricted
      // xom_rank is for women's KOM
      const isKom   = komRank === 1;

      if (!prTime) {
        container.innerHTML = `<div class="kom-no-effort">Noch kein Effort auf diesem Segment</div>`;
        return;
      }

      const fmt = s => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return m > 0 ? `${m}:${String(sec).padStart(2,'0')}` : `${sec}s`;
      };

      // KOM time from segment detail (top effort visible to API)
      // Strava returns athlete_segment_stats.pr_elapsed_time for your PR
      // and the overall KOM is in detail.kom_rank / detail.xom_rank
      // For the KOM time itself we use effort_count as a proxy signal
      const effortCount = stats?.effort_count || 0;
      const prDate = effort?.start_date_local
        ? new Date(effort.start_date_local).toLocaleDateString('de-DE')
        : '–';

      let html = `
        <div class="kom-card highlight">
          <p class="kom-card-label">Deine Bestzeit (PR)</p>
          <p class="kom-card-value">${fmt(prTime)}</p>
          <p class="kom-card-sub">${prDate} · ${effortCount} Versuche</p>
        </div>`;

      if (isKom) {
        html += `
          <div class="kom-card" style="border-color:rgba(255,215,0,0.4);background:rgba(255,215,0,0.06)">
            <p class="kom-card-label">Status</p>
            <p class="kom-card-value" style="color:var(--yellow)">KOM 👑</p>
            <p class="kom-card-sub">Du hältst den KOM</p>
          </div>`;
      } else if (komRank) {
        html += `
          <div class="kom-card">
            <p class="kom-card-label">Dein Rang</p>
            <p class="kom-card-value">#${komRank}</p>
            <p class="kom-card-sub">in der Bestenliste</p>
          </div>`;
      } else {
        // API doesn't expose rank for unverified apps — show effort count instead
        html += `
          <div class="kom-card">
            <p class="kom-card-label">Segment-Link</p>
            <p class="kom-card-value" style="font-size:14px;color:var(--muted)">Rang auf Strava</p>
            <p class="kom-card-sub">↓ Button unten</p>
          </div>`;
      }

      // Gap bar only if we have a meaningful rank
      if (komRank && komRank > 1 && detail?.leaderboard_type !== undefined) {
        // We can't reliably get KOM time from restricted API
        // Show effort count progress instead
        const progressPct = Math.max(10, Math.min(95, 100 - (komRank / 10) * 10));
        html += `
          <div class="kom-gap-bar">
            <div class="kom-gap-label">
              <span>Rang #${komRank}</span>
              <span style="color:var(--muted)">Ziel: Top 10</span>
            </div>
            <div class="kom-gap-track">
              <div class="kom-gap-fill" style="width:${progressPct}%"></div>
            </div>
          </div>`;
      }

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<div class="kom-no-effort">Bestzeiten konnten nicht geladen werden</div>`;
      console.warn('KOM section error:', err);
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


  // ─── Clusters ─────────────────────────────────────────────────────────────
  function loadClustersTab() {
    if (!state.segments.length) {
      // Need segments first
      showScreen('loading');
      document.getElementById('loading-text').textContent = 'Lade Segmente…';
      loadSegmentsTab(!state.token).then(() => buildClusters());
      return;
    }
    buildClusters();
    showScreen('clusters');
  }

  function buildClusters() {
    const weather = state.weather;
    if (!weather) return;

    // Score segments
    const scored = state.segments.map(seg => {
      const result = WindEngine.scoreSegment(
        { bearing: isFinite(seg.bearing) ? seg.bearing : 0,
          gradient: seg.avg_grade || 0,
          typicalSpeedKmh: seg.typicalSpeed || 30 },
        weather
      );
      return { ...seg, ...result };
    });

    // Cluster by geography
    const clusters = WindEngine.clusterSegments(scored, 20);

    // Score each cluster: avg tailwind + best direction
    const scoredClusters = clusters.map(c => {
      const avgTw = c.segments.reduce((s, x) => s + (x.effectiveTailwind || 0), 0) / c.segments.length;
      const avgProb = c.segments.reduce((s, x) => {
        return s + WindEngine.komProbability(x.effectiveTailwind || 0, null, x.distance/1000, x.avg_grade || 0);
      }, 0) / c.segments.length;

      // Best direction for the cluster: majority vote from segments
      let fwdSum = 0, revSum = 0;
      c.segments.forEach(seg => {
        const dirs = WindEngine.bothDirections(seg.bearing || 0, weather, seg.avg_grade || 0);
        if (dirs.recommended === 'forward') fwdSum += dirs.forward.effectiveTailwind;
        else revSum += dirs.reverse.effectiveTailwind;
      });
      const recommendedDir = fwdSum >= revSum ? 'Uhrzeigersinn' : 'Gegenuhrzeigersinn';

      return { ...c, avgTailwind: avgTw, avgProb: Math.round(avgProb), recommendedDir };
    }).sort((a, b) => b.avgTailwind - a.avgTailwind);

    state.clusters = scoredClusters;

    // Update weather pill
    document.getElementById('clusters-weather-summary').textContent =
      `${Math.round(weather.windSpeed)} km/h ${WindEngine.compassLabel(weather.windDirection)}`;

    renderClusters(scoredClusters);
  }

  function renderClusters(clusters) {
    const list = document.getElementById('clusters-list');
    list.innerHTML = '';

    if (!clusters.length) {
      list.innerHTML = `<div class="empty-state">Keine Segmente für Clustering verfügbar</div>`;
      return;
    }

    clusters.forEach((cluster, i) => {
      const tw = cluster.avgTailwind;
      const r  = WindEngine.getRating(tw);
      const sign = tw >= 0 ? '+' : '';
      const card = document.createElement('div');
      card.className = 'cluster-card';
      card.style.animationDelay = `${i * 0.05}s`;
      card.innerHTML = `
        <div class="cluster-score" style="color:${r.color};border-color:${r.color}">
          <span class="cluster-score-val">${sign}${Math.round(tw)}</span>
          <span class="cluster-score-unit">km/h</span>
        </div>
        <div class="cluster-info">
          <p class="cluster-title">Runde ${i + 1} · ${cluster.segments.length} Segmente</p>
          <p class="cluster-subtitle" style="color:${r.color}">${r.label}</p>
          <p class="cluster-dir">⌀ ${cluster.avgProb}% KOM-Chance · ${cluster.recommendedDir}</p>
        </div>
        <svg class="act-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`;
      card.addEventListener('click', () => openClusterDetail(cluster, i));
      list.appendChild(card);
    });
  }

  function openClusterDetail(cluster, idx) {
    const tw   = cluster.avgTailwind;
    const r    = WindEngine.getRating(tw);
    const sign = tw >= 0 ? '+' : '';

    document.getElementById('cluster-name').textContent = `Runde ${idx + 1}`;
    document.getElementById('cluster-meta').textContent =
      `${cluster.segments.length} Segmente · ⌀ ${sign}${Math.round(tw)} km/h`;

    document.getElementById('cluster-direction').innerHTML = `
      <div class="cluster-dir-badge">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 7-7 7 7M12 5v14"/></svg>
        Empfehlung: <strong>${cluster.recommendedDir}</strong> fahren
      </div>`;

    const list = document.getElementById('cluster-segments-list');
    list.innerHTML = '';
    const scored = cluster.segments.sort((a, b) => (b.effectiveTailwind||0) - (a.effectiveTailwind||0));
    scored.forEach(seg => {
      list.appendChild(createSegmentCard(seg, s => openDetail(s, state.weather, 'cluster-detail')));
    });

    showScreen('cluster-detail');
  }

  // ─── Share ─────────────────────────────────────────────────────────────────
  function shareSegment(seg, weather) {
    const tw    = seg.effectiveTailwind;
    const r     = seg.rating || WindEngine.getRating(tw);
    const sign  = tw >= 0 ? '+' : '';
    const prob  = WindEngine.komProbability(tw, null, seg.distance/1000, seg.avg_grade||0);
    const dirs  = WindEngine.bothDirections(seg.bearing||0, weather, seg.avg_grade||0);
    const dirStr = WindEngine.directionLabel(
      dirs.recommended === 'forward' ? dirs.forwardBearing : dirs.reverseBearing
    );

    const text = [
      `🚴 KOM Reaper — ${seg.name}`,
      `💨 Wind: ${sign}${Math.round(tw)} km/h (${r.label})`,
      `🎯 KOM-Chance: ${prob}%`,
      `↗ Beste Richtung: ${dirStr}`,
      ``,
      `${window.location.origin}${window.location.pathname}?share=${seg.id}`,
    ].join('\n');

    if (navigator.share) {
      navigator.share({
        title: `KOM Reaper — ${seg.name}`,
        text,
        url: `${window.location.origin}${window.location.pathname}?share=${seg.id}`,
      }).catch(() => {});
    } else {
      // Fallback: copy to clipboard
      navigator.clipboard?.writeText(text).then(() => {
        const btn = document.getElementById('share-btn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Kopiert!';
        btn.style.borderColor = 'var(--green)';
        btn.style.color = 'var(--green)';
        setTimeout(() => { btn.innerHTML = orig; btn.style.borderColor = ''; btn.style.color = ''; }, 2000);
      });
    }
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
    document.getElementById('back-cluster-btn').addEventListener('click', () => showScreen('clusters'));

    // Tab bar
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const t = tab.dataset.tab;
        if (t === 'segments') {
          if (state.segments.length) showScreen('segments');
          else loadSegmentsTab(!state.token);
        } else if (t === 'routes') {
          loadRoutesTab();
        } else if (t === 'clusters') {
          loadClustersTab();
        }
      });
    });
  });

})();
