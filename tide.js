// Skookumchuck Narrows (Sechelt Rapids) Tide Predictor
// Fetches hi/lo tide predictions from the DFO IWLS API for Egmont (station 5dd3064ee0fdc4b9b4be670d)
// and derives surfable flood sessions using a 59-minute lag and 3.6 kn/m range formula.
// The 59-minute lag shifts Egmont high-tide time to the Skookumchuck peak flood current,
// calibrated against the Skookumchuck Tourism Board schedule. Adjust if observations differ.

const EGMONT_STATION_ID  = '5dd3064ee0fdc4b9b4be670d';
const TIDE_LOCATION_LAT  = 50.4833;
const TIDE_LOCATION_LNG  = -123.9;

const FLOOD_LAG_MINUTES  = 59;
const KNOTS_PER_METRE    = 3.6;
const MIN_SURFABLE_KNOTS = 7.0;
const WINDOW_BEFORE_PEAK = 2.5 * 60 * 60 * 1000; // ms
const WINDOW_AFTER_PEAK  = 1.0 * 60 * 60 * 1000; // ms

const WAVE_QUALITY = [
  { min: 15.0, label: 'Huge',   css: 'tide-green-fast', description: 'Mostly Green Wave — surf and sea kayaks' },
  { min: 12.0, label: 'Large',  css: 'tide-large',      description: 'Perfect for playboats' },
  { min:  9.0, label: 'Medium', css: 'tide-medium',     description: 'Long boats & playboats' },
  { min:  7.0, label: 'Small',  css: 'tide-small',      description: 'Sea kayakers and long boats' },
];

function waveQuality(knots) {
  return WAVE_QUALITY.find(q => knots >= q.min) || null;
}

// Fetch hi/lo tide events from DFO IWLS API for a given month
async function fetchHeightEvents(year, month) {
  const start = new Date(year, month - 1, 1);
  // Fetch a bit extra on each side to get neighbours for tagging
  const fromDate = new Date(start.getTime() - 2 * 24 * 60 * 60 * 1000);
  const toDate   = new Date(year, month, 1 + 2); // 2 days into next month

  const fmt = d => d.toISOString().replace('.000', '');
  const url = `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/${EGMONT_STATION_ID}/data` +
              `?time-series-code=wlp-hilo` +
              `&from=${fmt(fromDate)}` +
              `&to=${fmt(toDate)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DFO API error: ${resp.status}`);
  const json = await resp.json();

  // Parse events — API returns alternating hi/lo; tag by comparing to neighbours
  const events = json.map(e => ({
    time:  new Date(e.eventDate),
    value: parseFloat(e.value),
    type:  null,
  }));

  events.forEach((e, i) => {
    const neighbours = [
      i > 0             ? events[i - 1].value : null,
      i < events.length - 1 ? events[i + 1].value : null,
    ].filter(v => v !== null);
    e.type = neighbours.every(n => e.value > n) ? 'high' : 'low';
  });

  return events;
}

// Convert a UTC Date to BC local date string "YYYY-MM-DD" (permanent UTC-7, no DST since 2026)
function toPacificDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Etc/GMT+7' });
}

// Compute surfable sessions for the given year/month
async function computeSessions(year, month) {
  const events = await fetchHeightEvents(year, month);
  const highTides = events.filter(e => e.type === 'high');

  const sessions = [];

  for (const high of highTides) {
    // Only include sessions whose peak falls in this month (Pacific time)
    const peakTime = new Date(high.time.getTime() - FLOOD_LAG_MINUTES * 60 * 1000);
    const [peakYear, peakMonth] = toPacificDateStr(peakTime).split('-').map(Number);
    if (peakYear !== year || peakMonth !== month) continue;

    // Preceding low
    const precedingLow = events
      .filter(e => e.type === 'low' && e.time < high.time)
      .sort((a, b) => b.time - a.time)[0];
    if (!precedingLow) continue;

    const rangeM = high.value - precedingLow.value;
    const knots  = Math.round(rangeM * KNOTS_PER_METRE * 10) / 10;
    if (knots < MIN_SURFABLE_KNOTS) continue;

    const quality = waveQuality(knots);
    if (!quality) continue;

    // Ebb speed: preceding high → preceding low
    const precedingHigh = events
      .filter(e => e.type === 'high' && e.time < precedingLow.time)
      .sort((a, b) => b.time - a.time)[0];
    const ebbKnots = precedingHigh
      ? Math.round((precedingHigh.value - precedingLow.value) * KNOTS_PER_METRE * 10) / 10
      : null;

    const windowStart = new Date(peakTime.getTime() - WINDOW_BEFORE_PEAK);
    const windowEnd   = new Date(peakTime.getTime() + WINDOW_AFTER_PEAK);

    const dateStr = toPacificDateStr(peakTime);
    const [sunrise, sunset] = solarEvents(TIDE_LOCATION_LAT, TIDE_LOCATION_LNG, dateStr);

    sessions.push({
      dateStr,
      peakTime,
      peakKnots: knots,
      quality,
      windowStart,
      windowEnd,
      highTideM:  Math.round(high.value * 100) / 100,
      lowTideM:   Math.round(precedingLow.value * 100) / 100,
      tideDiffM:  Math.round(rangeM * 100) / 100,
      ebbKnots,
      sunrise,
      sunset,
    });
  }

  return sessions.sort((a, b) => a.peakTime - b.peakTime);
}

// NOAA solar calculation — returns [sunrise, sunset] as Date objects in Pacific time
function solarEvents(lat, lng, dateStr) {
  // Parse date as local (year, month-1, day)
  const [y, m, d] = dateStr.split('-').map(Number);

  // Julian day number
  const jd = julianDay(y, m, d);

  // Julian century from J2000.0
  const t = (jd - 2451545.0) / 36525.0;

  // Geometric mean longitude of the sun (degrees)
  const l0 = ((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360 + 360) % 360;

  // Geometric mean anomaly of the sun (degrees)
  const mAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const mRad = mAnomaly * Math.PI / 180;

  // Equation of center
  const c = Math.sin(mRad) * (1.914602 - t * (0.004817 + 0.000014 * t))
          + Math.sin(2 * mRad) * (0.019993 - 0.000101 * t)
          + Math.sin(3 * mRad) * 0.000289;

  const sunLon = l0 + c;
  const omega  = 125.04 - 1934.136 * t;
  const lambda = sunLon - 0.00569 - 0.00478 * Math.sin(omega * Math.PI / 180);

  const epsilon0 = 23.0 + (26.0 + (21.448 - t * (46.8150 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const epsilon  = epsilon0 + 0.00256 * Math.cos(omega * Math.PI / 180);

  const sinDec = Math.sin(epsilon * Math.PI / 180) * Math.sin(lambda * Math.PI / 180);
  const dec    = Math.asin(sinDec);

  const tanEps2 = Math.tan((epsilon / 2) * Math.PI / 180);
  const y2      = tanEps2 * tanEps2;
  const l0Rad   = l0 * Math.PI / 180;
  const eot     = 4 * (180 / Math.PI) * (
    y2 * Math.sin(2 * l0Rad)
    - 2 * 0.016708634 * Math.sin(mRad)
    + 4 * 0.016708634 * y2 * Math.sin(mRad) * Math.cos(2 * l0Rad)
    - 0.5 * y2 * y2 * Math.sin(4 * l0Rad)
    - 1.25 * 0.016708634 * 0.016708634 * Math.sin(2 * mRad)
  );

  const latRad = lat * Math.PI / 180;
  let cosHA = (Math.cos(90.833 * Math.PI / 180) / (Math.cos(latRad) * Math.cos(dec)))
              - Math.tan(latRad) * Math.tan(dec);
  cosHA = Math.max(-1, Math.min(1, cosHA));
  const haDeg = Math.acos(cosHA) * 180 / Math.PI;

  const tzOffsetMin = getPacificOffsetMinutes(new Date(`${dateStr}T12:00:00Z`));

  // Solar noon in minutes from midnight Pacific
  const solarNoon    = 720 - 4 * lng - eot - tzOffsetMin;
  const sunriseMin   = solarNoon - 4 * haDeg;
  const sunsetMin    = solarNoon + 4 * haDeg;

  // Convert to UTC Date objects
  const midnightUTC  = new Date(`${dateStr}T00:00:00Z`);
  const tzOffsetMs   = tzOffsetMin * 60 * 1000;
  const midnightPacificUTC = new Date(midnightUTC.getTime() + tzOffsetMs);

  const sunrise = new Date(midnightPacificUTC.getTime() + sunriseMin * 60 * 1000);
  const sunset  = new Date(midnightPacificUTC.getTime() + sunsetMin  * 60 * 1000);

  return [sunrise, sunset].sort((a, b) => a - b);
}

function julianDay(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

// BC is permanently UTC-7 as of 2026 (no Daylight Saving Time).
// Returns 420 minutes (the number of minutes UTC midnight is ahead of BC midnight).
function getPacificOffsetMinutes(_utcDate) {
  return 420;
}

function isNightSession(s) {
  if (!s.sunrise || !s.sunset) return false;
  return s.peakTime > new Date(s.sunset.getTime() + 45 * 60 * 1000) ||
         s.peakTime < new Date(s.sunrise.getTime() + 60 * 60 * 1000);
}

export {
  computeSessions,
  waveQuality,
  isNightSession,
  WAVE_QUALITY,
};
