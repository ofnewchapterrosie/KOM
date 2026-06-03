/**
 * KOMwind — Cloudflare Worker
 *
 * Endpoints:
 *   GET  /strava/auth         → Redirect zu Strava OAuth
 *   GET  /strava/callback     → Code → Token Exchange, Redirect zurück zur App
 *   GET  /strava/segments     → Proxy: gesternde Segmente
 *   GET  /strava/segment/:id  → Proxy: Segment-Detail mit Polyline
 *
 * Environment Variables (Cloudflare Dashboard → Settings → Variables):
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 *   APP_ORIGIN   → z.B. https://pumpingflo.github.io
 */

const STRAVA_BASE = 'https://www.strava.com/api/v3';

// CORS-Header für die PWA
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function errorResponse(message, status = 400, origin) {
  return jsonResponse({ error: message }, status, origin);
}

// ─── Token-Cache (in-memory, pro Worker-Instance) ────────────────────────────
// Für Production: KV Storage nutzen (Kommentar unten)
const tokenCache = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || env.APP_ORIGIN;

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const path = url.pathname;

    // ── GET /strava/auth ─────────────────────────────────────────────────────
    // Leitet den Browser zu Strava weiter (wird direkt im Browser aufgerufen)
    if (path === '/strava/auth') {
      const redirectUri = encodeURIComponent(`${url.origin}/strava/callback`);
      const stravaUrl =
        `https://www.strava.com/oauth/authorize` +
        `?client_id=${env.STRAVA_CLIENT_ID}` +
        `&redirect_uri=${redirectUri}` +
        `&response_type=code` +
        `&scope=read,activity:read_all` +
        `&approval_prompt=auto`;

      return Response.redirect(stravaUrl, 302);
    }

    // ── GET /strava/callback ─────────────────────────────────────────────────
    // Strava redirectet hierher mit ?code=...
    // Wir tauschen den Code gegen ein Token und leiten zurück zur App.
    if (path === '/strava/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error || !code) {
        const appUrl = `${env.APP_ORIGIN}/komwind/?error=auth_denied`;
        return Response.redirect(appUrl, 302);
      }

      try {
        const tokenRes = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
          }),
        });

        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
          const appUrl = `${env.APP_ORIGIN}/komwind/?error=token_failed`;
          return Response.redirect(appUrl, 302);
        }

        // Token sicher übergeben: als URL-Fragment (#token=...) — Fragment
        // wird nicht an den Server gesendet, bleibt im Browser.
        // ALTERNATIV: Token in ein signiertes Cookie schreiben (sicherer für Production).
        const appUrl =
          `${env.APP_ORIGIN}/komwind/#token=${tokenData.access_token}` +
          `&expires_at=${tokenData.expires_at}` +
          `&refresh_token=${tokenData.refresh_token}`;

        return Response.redirect(appUrl, 302);

      } catch (err) {
        const appUrl = `${env.APP_ORIGIN}/komwind/?error=server_error`;
        return Response.redirect(appUrl, 302);
      }
    }

    // ── POST /strava/refresh ─────────────────────────────────────────────────
    // Refresh Token → neues Access Token
    if (path === '/strava/refresh' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { refresh_token } = body;

      if (!refresh_token) return errorResponse('refresh_token fehlt', 400, origin);

      try {
        const res = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            refresh_token,
            grant_type: 'refresh_token',
          }),
        });
        const data = await res.json();
        return jsonResponse({
          access_token: data.access_token,
          expires_at: data.expires_at,
          refresh_token: data.refresh_token,
        }, 200, origin);
      } catch {
        return errorResponse('Token-Refresh fehlgeschlagen', 500, origin);
      }
    }

    // ── Strava API Proxy ─────────────────────────────────────────────────────
    // Alle /strava/* Requests werden an die Strava API weitergeleitet.
    // Token kommt aus dem Authorization-Header der PWA.

    if (path.startsWith('/strava/')) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return errorResponse('Authorization-Header fehlt', 401, origin);
      }

      // /strava/segments → /api/v3/segments/starred
      // /strava/segment/12345 → /api/v3/segments/12345
      let stravaPath;
      if (path === '/strava/segments') {
        stravaPath = '/segments/starred?per_page=50';
      } else {
        const segMatch  = path.match(/^\/strava\/segment\/(\d+)$/);
        const lbMatch   = path.match(/^\/strava\/segment\/(\d+)\/leaderboard$/);
        const actMatch  = path.match(/^\/strava\/activity\/(\d+)$/);
        const efMatch   = path === '/strava/athlete/efforts';
        const actsMatch = path === '/strava/activities';

        if (segMatch) {
          stravaPath = `/segments/${segMatch[1]}`;
        } else if (lbMatch) {
          stravaPath = `/segments/${lbMatch[1]}/leaderboard?per_page=10`;
        } else if (actMatch) {
          stravaPath = `/activities/${actMatch[1]}?include_all_efforts=true`;
        } else if (actsMatch) {
          const qp = new URL(request.url).searchParams;
          const perPage = qp.get('per_page') || '40';
          // No type filter — client handles filtering
          stravaPath = `/athlete/activities?per_page=${perPage}`;
        } else if (efMatch) {
          const segId = new URL(request.url).searchParams.get('segment_id');
          stravaPath = `/segment_efforts?segment_id=${segId}&per_page=1`;
        } else {
          return errorResponse('Unbekannter Endpunkt', 404, origin);
        }
      }

      try {
        const stravaRes = await fetch(`${STRAVA_BASE}${stravaPath}`, {
          headers: { Authorization: authHeader },
        });

        if (!stravaRes.ok) {
          const errData = await stravaRes.json().catch(() => ({}));
          return errorResponse(
            errData.message || 'Strava-API-Fehler',
            stravaRes.status,
            origin
          );
        }

        const data = await stravaRes.json();
        return jsonResponse(data, 200, origin);

      } catch (err) {
        return errorResponse('Strava-API nicht erreichbar', 502, origin);
      }
    }

    // ── Health Check ─────────────────────────────────────────────────────────
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', service: 'komwind-worker' }, 200, origin);
    }

    return errorResponse('Not found', 404, origin);
  },
};

/**
 * ─── KV Storage (Production-Upgrade) ────────────────────────────────────────
 *
 * Für persistente Token-Speicherung (mehrere Worker-Instanzen, Restarts):
 *
 * 1. KV Namespace anlegen: wrangler kv:namespace create TOKENS
 * 2. In wrangler.toml hinzufügen:
 *    [[kv_namespaces]]
 *    binding = "TOKENS"
 *    id = "DEINE_KV_ID"
 *
 * 3. Token speichern:
 *    await env.TOKENS.put(`token:${userId}`, JSON.stringify(tokenData), {
 *      expirationTtl: tokenData.expires_in
 *    });
 *
 * 4. Token laden:
 *    const raw = await env.TOKENS.get(`token:${userId}`);
 *    const tokenData = raw ? JSON.parse(raw) : null;
 */

// ── NOTE: Add these two new routes inside the fetch handler,
// before the final "Not found" return, replacing the existing
// /strava/segment/:id block with the extended version below.
// See worker-patch.js for the complete updated routing section.
