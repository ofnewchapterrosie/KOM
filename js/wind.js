/**
 * KOMwind — Wind Logic Module
 *
 * Alle Berechnungen sind unabhängig von der UI.
 * Kann separat getestet werden.
 */

const WindEngine = (() => {

  /**
   * Windrichtungs-Korrektur:
   * Meteorologisch = woher der Wind kommt.
   * Wir brauchen: wohin er weht.
   */
  function windTowards(meteorologicalDeg) {
    return (meteorologicalDeg + 180) % 360;
  }

  /**
   * Tailwind-Komponente (km/h)
   * Positiv = Rückenwind, Negativ = Gegenwind
   *
   * @param {number} segmentBearing  - Richtung des Segments (0–360°)
   * @param {number} windDirection   - Meteorologische Windrichtung (0–360°)
   * @param {number} windSpeed       - Windstärke (km/h)
   */
  function rawTailwind(segmentBearing, windDirection, windSpeed) {
    const towards = windTowards(windDirection);
    const angleDiff = segmentBearing - towards;
    return Math.cos((angleDiff * Math.PI) / 180) * windSpeed;
  }

  /**
   * Gradient-Faktor: Bei steilen Anstiegen verliert Wind seinen Einfluss.
   * Gravitationskraft dominiert → Wind irrelevant.
   *
   * @param {number} gradientPct - Steigung in Prozent
   */
  function windRelevanceFactor(gradientPct) {
    const g = Math.abs(gradientPct);
    if (g < 2)  return 1.0;
    if (g < 5)  return 0.6;
    if (g < 8)  return 0.3;
    return 0.15;
  }

  /**
   * Aerodynamischer Geschwindigkeitsvorteil durch Rückenwind.
   *
   * Luftwiderstand ∝ v_air² → nicht-linearer Effekt.
   * Je schneller der Fahrer, desto mehr bringt Rückenwind.
   *
   * Gibt geschätzten Geschwindigkeitsvorteil in km/h zurück.
   *
   * @param {number} riderSpeedKmh   - Typische Pace auf dem Segment
   * @param {number} tailwindKmh     - Effektiver Rückenwind
   */
  function estimatedSpeedGain(riderSpeedKmh, tailwindKmh) {
    if (riderSpeedKmh <= 0) return 0;
    const vAir = riderSpeedKmh - tailwindKmh;
    const vAirBase = riderSpeedKmh;
    // Drag reduction fraction (clamped to 0–0.8 to avoid physics absurdities)
    const dragReduction = Math.max(0, Math.min(0.8,
      (vAirBase * vAirBase - vAir * vAir) / (vAirBase * vAirBase)
    ));
    // Approximate speed gain assuming power is constant (P = F_drag * v)
    // New speed ≈ v / (1 - dragReduction * Cd_fraction)
    const Cd_fraction = 0.7; // ~70% of total resistance is aerodynamic at 35km/h
    const newSpeed = riderSpeedKmh / (1 - dragReduction * Cd_fraction);
    return Math.min(newSpeed - riderSpeedKmh, 15); // cap at 15 km/h gain
  }

  /**
   * Hauptfunktion: Vollständige Bewertung für ein Segment
   *
   * @param {object} segment  - { bearing, gradient, typicalSpeedKmh }
   * @param {object} weather  - { windDirection, windSpeed }
   * @returns {object}        - { effectiveTailwind, relevanceFactor, speedGain, rating }
   */
  function scoreSegment(segment, weather) {
    const { bearing, gradient = 2, typicalSpeedKmh = 35 } = segment;
    const { windDirection, windSpeed } = weather;

    const raw     = rawTailwind(bearing, windDirection, windSpeed);
    const factor  = windRelevanceFactor(gradient);
    const effective = raw * factor;
    const speedGain = estimatedSpeedGain(typicalSpeedKmh, effective);

    return {
      effectiveTailwind: effective,
      rawTailwind: raw,
      relevanceFactor: factor,
      speedGain,
      rating: getRating(effective),
    };
  }

  /**
   * Rating-System: 7 Stufen
   * Schwellen basieren auf effektivem Tailwind (km/h)
   */
  const RATINGS = [
    {
      min: 15,
      key: 'monster',
      label: 'Monster-Rückenwind',
      sub: 'KOM-Jagd — jetzt losfahren',
      icon: '🚀',
      colorClass: 'score-great',
      color: '#4ade80',
    },
    {
      min: 8,
      key: 'strong',
      label: 'Starker Rückenwind',
      sub: 'Sehr günstige Bedingungen',
      icon: '↑',
      colorClass: 'score-good',
      color: '#a3e635',
    },
    {
      min: 3,
      key: 'light',
      label: 'Leichter Rückenwind',
      sub: 'Spürbar hilfreich',
      icon: '↗',
      colorClass: 'score-ok',
      color: '#e8ff47',
    },
    {
      min: -3,
      key: 'neutral',
      label: 'Neutral',
      sub: 'Kaum Einfluss des Windes',
      icon: '→',
      colorClass: 'score-neutral',
      color: '#555',
    },
    {
      min: -8,
      key: 'headlight',
      label: 'Leichter Gegenwind',
      sub: 'Spürbarer Nachteil',
      icon: '↙',
      colorClass: 'score-bad',
      color: '#fb923c',
    },
    {
      min: -15,
      key: 'headstrong',
      label: 'Starker Gegenwind',
      sub: 'KOM heute unrealistisch',
      icon: '↓',
      colorClass: 'score-worse',
      color: '#f87171',
    },
    {
      min: -Infinity,
      key: 'brutal',
      label: 'Brutaler Gegenwind',
      sub: 'Vergiss es — komm morgen',
      icon: '✕',
      colorClass: 'score-brutal',
      color: '#ef4444',
    },
  ];

  function getRating(effectiveTailwind) {
    if (!isFinite(effectiveTailwind)) return RATINGS[RATINGS.length - 1];
    return RATINGS.find(r => effectiveTailwind >= r.min) || RATINGS[RATINGS.length - 1];
  }

  /**
   * Bearing aus zwei GPS-Koordinaten (Haversine-Bearing)
   * Gibt Bearing in Grad (0–360) zurück.
   */
  function bearingFromCoords(lat1, lon1, lat2, lon2) {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
      Math.cos(φ1) * Math.sin(φ2) -
      Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /**
   * Gewichteter Bearing aus Polyline-Punkten.
   * Mehrere Punkte → genauerer Gesamt-Bearing als nur Start→Ziel.
   *
   * @param {Array} points - Array von [lat, lon] Paaren
   */
  function weightedBearingFromPolyline(points) {
    if (points.length < 2) return 0;
    let sinSum = 0;
    let cosSum = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const b = bearingFromCoords(
        points[i][0], points[i][1],
        points[i + 1][0], points[i + 1][1]
      );
      sinSum += Math.sin((b * Math.PI) / 180);
      cosSum += Math.cos((b * Math.PI) / 180);
    }
    return ((Math.atan2(sinSum, cosSum) * 180) / Math.PI + 360) % 360;
  }

  /**
   * Windrichtung in Kompass-String
   */
  function compassLabel(deg) {
    const dirs = ['N','NO','O','SO','S','SW','W','NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  /**
   * Windrichtung formatiert (z.B. "270° W")
   */
  function formatWindDir(deg) {
    return `${Math.round(deg)}° ${compassLabel(deg)}`;
  }

  return {
    scoreSegment,
    bearingFromCoords,
    weightedBearingFromPolyline,
    getRating,
    RATINGS,
    formatWindDir,
    compassLabel,
    windRelevanceFactor,
    estimatedSpeedGain,
  };
})();
