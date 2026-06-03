# KOMwind — PWA Grundgerüst

Wann ist der Wind gut genug für deinen Strava-KOM?

## Dateistruktur

```
komwind/
├── index.html          ← App Shell
├── manifest.json       ← PWA Manifest (Icons, Name, Display-Mode)
├── sw.js               ← Service Worker (Offline, Caching)
├── css/
│   └── app.css         ← Styling
├── js/
│   ├── wind.js         ← Wind-Logik (reine Berechnungen, kein DOM)
│   └── app.js          ← App Controller (State, Render, API-Stubs)
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

## Deployment auf GitHub Pages

```bash
# 1. Neues Repo erstellen: pumpingflo/komwind
git init
git add .
git commit -m "initial: PWA Grundgerüst"
git remote add origin https://github.com/pumpingflo/komwind.git
git push -u origin main

# 2. GitHub Pages aktivieren:
# Settings → Pages → Branch: main / root → Save
# App läuft dann auf: https://pumpingflo.github.io/komwind/
```

## Android Installation

1. URL in Chrome öffnen
2. Drei-Punkte-Menü → "Zum Startbildschirm hinzufügen"
3. Alternativ: Banner "App installieren" erscheint automatisch

## Nächste Schritte

### 1. Strava OAuth (Cloudflare Worker)

In `js/app.js` die TODOs ausfüllen:
- `STRAVA_CLIENT_ID` → aus Strava Developer Console
- Worker-URL → eigener Cloudflare Worker für Token-Exchange

### 2. Open-Meteo läuft bereits

Kein API-Key nötig. Die `fetchWeather(lat, lon)` Funktion ist fertig.

### 3. Demo-Modus

Ohne Strava-Login zeigt die App Demo-Segmente aus Osnabrück
mit echten Wetterdaten von Open-Meteo.

## Wind-Logik

Alle Berechnungen in `js/wind.js` — vollständig dokumentiert.
Kann unabhängig getestet werden:

```javascript
const result = WindEngine.scoreSegment(
  { bearing: 90, gradient: 2, typicalSpeedKmh: 35 },
  { windDirection: 270, windSpeed: 20 }
);
// → { effectiveTailwind: +20, rating: { label: 'Monster-Rückenwind', ... } }
```
