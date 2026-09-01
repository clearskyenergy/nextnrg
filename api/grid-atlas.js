/* ═══════════════════════════════════════════════════════════════════════════════
   /api/grid-atlas.js — Grid Atlas as a service
   Vercel serverless function.

   ─────────────────────────────────────────────────────────────────────────────
   WHY A SERVICE RATHER THAN THE PAGE
   ─────────────────────────────────────────────────────────────────────────────
   grid-atlas.html is a browser tool: somebody opens it, types an address, reads
   the map. That is the right shape for a human, and the wrong shape for four
   things we now want:

     · running it automatically when a deal reaches screening
     · running it for a hundred adopted sites without opening a hundred tabs
     · letting OGI's tool call it, so their score is informed by our grid data
     · getting the same answer every time, from anywhere

   A service does all four. The page keeps working exactly as it does; it can
   even be pointed at this endpoint so there is one implementation rather than
   two — see the note at the bottom.

   ─────────────────────────────────────────────────────────────────────────────
   WHAT YOU HAVE TO FILL IN
   ─────────────────────────────────────────────────────────────────────────────
   Everything here is real except the three data lookups, which are marked
   ⚠ DATA SOURCE. Grid Atlas already queries something for substations, lines
   and plants — HIFLD, EIA, a cached layer, your own table. Point those three
   functions at whatever it uses and this is finished.

   The scoring model below is deliberate and defensible, but it is a starting
   position: if Grid Atlas already scores, replace `score()` with that logic
   rather than keeping two.

   ENVIRONMENT VARIABLES — both optional
     GOOGLE_GEOCODING_KEY   fallback geocoder for addresses the free US Census
                            geocoder cannot match. Not needed to start.
     GRID_ATLAS_KEY         require callers to present this, so OGI can call
                            the endpoint without it being open to the internet.
   ═══════════════════════════════════════════════════════════════════════════════ */

/* ── The scoring model ────────────────────────────────────────────────────
   Four measurements, weighted. Every one of them is a distance or a number
   somebody could check on a map, which is the point: this is a MEASUREMENT,
   and the judgement about whether the site is worth developing happens
   elsewhere with this as an input.

   Weights are here rather than buried so they can be argued with. */
/* Stamped into every response, including errors. The last round of confusion
   was entirely "which version of this function is actually running" — the
   console showed a new build stamp while the serverless function was still the
   previous one, and nothing in the reply said so. Bump this whenever the file
   changes and the answer is visible from any response. */
const BUILD = '2026-09-01.layers-connected';

const MODEL = {
  version: 'grid-atlas-svc-v1',
  weights: { substation: 4, voltage: 3, transmission: 2, congestion: 1 },

  /* Distance to the nearest substation. The curve is deliberately steep early:
     the difference between 0.5 km and 2 km is most of the interconnection cost,
     while the difference between 20 km and 30 km barely matters because both
     are "you are building a line". */
  substationScore(km) {
    if (km == null) return null;
    if (km <= 0.5) return 10;
    if (km <= 1)   return 9;
    if (km <= 2)   return 8;
    if (km <= 5)   return 6;
    if (km <= 10)  return 4;
    if (km <= 20)  return 2;
    return 1;
  },

  /* Is the voltage class useful for a project this size? A 12 kV distribution
     tap is fine for 2 MW and useless for 75 MW, so this is scored against the
     project rather than in the abstract. */
  voltageScore(kv, sizeMw) {
    if (kv == null) return null;
    const mw = sizeMw || 5;
    if (mw <= 5)   return kv >= 12  ? 10 : 5;
    if (mw <= 20)  return kv >= 34  ? 10 : kv >= 12 ? 6 : 3;
    if (mw <= 100) return kv >= 115 ? 10 : kv >= 69 ? 7 : 3;
    return kv >= 230 ? 10 : kv >= 115 ? 7 : 3;
  },

  transmissionScore(km) {
    if (km == null) return null;
    if (km <= 1)  return 10;
    if (km <= 3)  return 8;
    if (km <= 10) return 5;
    return 2;
  },

  /* Generation already nearby is a mixed signal: it proves the area is
     interconnectable, and it is also what fills a queue. Scored mildly and
     weighted lightly for exactly that reason. */
  congestionScore(plants) {
    const n = (plants || []).length;
    if (n === 0) return 7;
    if (n <= 2)  return 8;
    if (n <= 5)  return 6;
    return 4;
  }
};

function weightedScore(parts) {
  let earned = 0, total = 0;
  const rows = [];
  for (const [key, weight] of Object.entries(MODEL.weights)) {
    const v = parts[key];
    if (v == null) {
      /* UNSCORED IS NOT ZERO. A measurement we could not take drops out of
         both sides rather than counting against the site — scoring a missing
         lookup as nil quietly turns a weighted model into a random one. */
      rows.push({ key, weight, value: null, unscored: true });
      continue;
    }
    earned += v * weight;
    total  += weight;
    rows.push({ key, weight, value: v, unscored: false });
  }
  return {
    score: total ? Math.round((earned / (total * 10)) * 100) : null,
    rows,
    unscored: rows.filter(r => r.unscored).length
  };
}

/* ── Geocoding ─────────────────────────────────────────────────────────────
   NOBODY SHOULD HAVE TO TYPE COORDINATES. A site has an address; turning that
   into a point is this file's job, and asking a person to right-click a map
   means the automation failed.

   Three things make that work in practice.

   1 · CLEAN THE ADDRESS FIRST. Real addresses on real deals carry building and
       suite designators — "600 N Union Ave Blg 6B" — and street-level
       geocoders reject the whole string rather than ignoring the part they do
       not understand. Stripping the unit is not lossy for this purpose: Grid
       Atlas cares which parcel the building sits on, not which door.

   2 · TRY MORE THAN ONE PROVIDER, all free. Census is authoritative for US
       street addresses; Nominatim covers what Census misses, including places
       named rather than numbered. Google is used only if a key happens to be
       set, and is not needed.

   3 · DEGRADE, DO NOT FAIL. If the full address will not match, try it without
       the unit, then without the street number, then the town. A point two
       streets away still answers "how far to the nearest substation" usefully;
       no point at all answers nothing. Whatever it settles for is reported, so
       a rough match is visible rather than silently passed off as exact. */

const UNIT_RE = /[,\s]+(?:apt|apartment|bldg|blg|bld|building|ste|suite|unit|fl|floor|rm|room|lot|trlr|space|spc|dept|hangar|slip|pier)\.?\s*[\w-]*/ig;
const HASH_RE = /[,\s]*#\s*[\w-]+/g;

function cleanAddress(a) {
  return String(a || '')
    .replace(/\s+/g, ' ')
    .replace(UNIT_RE, '')
    .replace(HASH_RE, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/[,\s]+$/, '')
    .replace(/^\s*,\s*/, '')
    .trim();
}

/* Progressively less specific attempts. Each is a real address somebody could
   post a letter to, so a match against one is a real place — just less precise
   than the last. */
function addressVariants(a) {
  const out = [];
  const push = v => { v = (v || '').trim(); if (v && out.indexOf(v) < 0) out.push(v); };
  push(a);
  push(cleanAddress(a));

  const cleaned = cleanAddress(a);
  const parts = cleaned.split(',').map(s => s.trim()).filter(Boolean);

  /* Drop the street number: "600 N Union Ave" becomes "N Union Ave", which
     still lands on the right street. */
  if (parts.length) {
    const noNumber = parts[0].replace(/^\s*\d+[A-Za-z]?\s+/, '');
    if (noNumber !== parts[0]) push([noNumber].concat(parts.slice(1)).join(', '));
  }
  /* Town and state alone. Coarse, and reported as such in the response. */
  if (parts.length > 1) push(parts.slice(1).join(', '));
  return out;
}

async function tryCensus(q) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
            + '?address=' + encodeURIComponent(q)
            + '&benchmark=Public_AR_Current&format=json';
  const r = await fetch(url);
  if (!r.ok) throw new Error('census ' + r.status);
  const j = await r.json();
  const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
  if (!m) throw new Error('census: no match');
  return { lat: m.coordinates.y, lng: m.coordinates.x,
           resolved: m.matchedAddress, provider: 'census' };
}

/* OpenStreetMap. Free, no key. Their policy asks for an identifying
   User-Agent, which is why one is set — sending a generic one would be
   rude and gets you blocked. */
async function tryNominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1'
            + '&countrycodes=us&q=' + encodeURIComponent(q);
  const r = await fetch(url, {
    headers: { 'User-Agent': 'ClearSky-OMEGA/1.0 (grid-atlas; ops@clearsky-usa.com)' }
  });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const j = await r.json();
  if (!j || !j.length) throw new Error('nominatim: no match');
  return { lat: Number(j[0].lat), lng: Number(j[0].lon),
           resolved: j[0].display_name, provider: 'nominatim' };
}

async function tryGoogle(q) {
  const key = process.env.GOOGLE_GEOCODING_KEY;
  if (!key) throw new Error('google: no key set');
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address='
            + encodeURIComponent(q) + '&key=' + key;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 'OK' || !j.results || !j.results.length)
    throw new Error('google: ' + j.status);
  const g = j.results[0];
  return { lat: g.geometry.location.lat, lng: g.geometry.location.lng,
           resolved: g.formatted_address, provider: 'google' };
}

/* ── Guarding against a confident wrong match ──────────────────────────────
   "600 N Union Ave Blg 6B" has no city, state or postcode, so Census matched
   "600 W NORTH UNION RD, AUBURN, MI" — a real address 900 km from the real
   site, in the wrong state. Everything downstream then measured the wrong
   place and reported it with the same confidence as a correct one.

   Two defences:

   1 · REFUSE A BARE STREET. Without a city, state or ZIP there is nothing to
       disambiguate between the dozens of "N Union Ave" in the country, and a
       geocoder will pick one rather than admit it cannot tell. Asking for the
       city is a five-second fix; a silently wrong location is not.

   2 · CHECK THE MATCH AGAINST WHAT WAS ASKED. If the address named a state or
       ZIP and the match came back in a different one, that is not a near miss,
       it is a different place. */

const STATES = ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN '
  + 'MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC')
  .split(' ');

function statesIn(s) {
  var up = ' ' + String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ') + ' ';
  return STATES.filter(function (st) { return up.indexOf(' ' + st + ' ') >= 0; });
}
function zipsIn(s) {
  return (String(s || '').match(/\b\d{5}\b/g) || []);
}

/* Enough to place it: a state, a ZIP, or a comma-separated locality. */
function hasLocality(a) {
  var s = String(a || '').trim();
  if (zipsIn(s).length) return true;
  if (statesIn(s).length) return true;
  /* "275 Research Parkway, Meriden" — a comma with words after it is a town. */
  return /,\s*[A-Za-z][A-Za-z .'-]{2,}\s*$/.test(s);
}

function matchConflicts(asked, matched) {
  var aS = statesIn(asked), mS = statesIn(matched);
  if (aS.length && mS.length && aS.indexOf(mS[0]) < 0 && mS.indexOf(aS[0]) < 0)
    return 'the address says ' + aS[0] + ' but the match is in ' + mS[0];
  var aZ = zipsIn(asked), mZ = zipsIn(matched);
  if (aZ.length && mZ.length && aZ[0] !== mZ[0]
      && aZ[0].slice(0, 3) !== mZ[0].slice(0, 3))
    return 'the address says ' + aZ[0] + ' but the match is ' + mZ[0];
  return null;
}

async function geocode(address) {
  if (!hasLocality(address))
    throw Object.assign(new Error(
      'The address "' + address + '" has no city, state or ZIP, so there is nothing to '
      + 'tell it apart from every other street of that name in the country. A geocoder '
      + 'will pick one rather than admit it cannot tell \u2014 which is how a New Jersey '
      + 'site gets measured in Michigan. Add the city and state to the deal.'),
      { needsLocality: true });

  const variants = addressVariants(address);
  const providers = [tryCensus, tryNominatim, tryGoogle];
  const tried = [];

  /* Variant-major: every provider gets a go at the most precise form before
     anything falls back to a rougher one. A precise match from the second
     provider beats a coarse match from the first. */
  for (let vi = 0; vi < variants.length; vi++) {
    for (const p of providers) {
      try {
        const hit = await p(variants[vi]);
        /* A match in the wrong state is not a near miss. Rejecting it and
           carrying on is better than returning it with a caveat nobody reads. */
        const conflict = matchConflicts(address, hit.resolved);
        if (conflict) { tried.push('rejected a match where ' + conflict); continue; }
        hit.precision = vi === 0 ? 'exact'
                      : vi === 1 ? 'street'
                      : vi === 2 ? 'street-approx' : 'area';
        hit.queried = variants[vi];
        if (vi > 0) hit.note = 'Matched on "' + variants[vi]
          + '" rather than the full address.';
        return hit;
      } catch (e) { tried.push(e.message || String(e)); }
    }
  }
  throw new Error('Could not locate "' + address + '". Tried '
    + variants.length + ' forms of the address against Census, OpenStreetMap'
    + (process.env.GOOGLE_GEOCODING_KEY ? ' and Google' : '')
    + '. Either the address is wrong, or this site has none — set coordinates by hand.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   ⚠ DATA SOURCE — connected.

   Two sources, tried in order, per layer.

     1 HIFLD Open (ArcGIS).  The authoritative US infrastructure layers, the
       same family of data the utilities' own planners look at. Free, no key.
     2 OpenStreetMap (Overpass).  Global, free, no key, and genuinely good on
       substations and transmission in most of the developed world.

   WHY TWO. HIFLD has reorganised its layers more than once, and several went
   access-restricted in 2022 without notice. If an endpoint has moved, the
   request fails and OSM answers instead — the site still gets measured, and
   the response says which source produced the number so a wrong endpoint
   shows up as "source: osm" rather than as silence.

   THE null / [] DISTINCTION IS PRESERVED, and it is the most important thing
   in this file. Read the note above the old stubs before touching it:

     null  no source answered. The measurement drops out of the weighting.
     []    a source answered and there is genuinely nothing within the radius.
           That is a finding, and a damning one.

   Every path below returns null on failure and [] only after a successful
   query. Getting this backwards is what scored a workable NJ site 21 and
   marked it not viable.
   ═══════════════════════════════════════════════════════════════════════════ */

const SOURCES = { substations: null, lines: null, plants: null };  /* per-request provenance */

/* HIFLD's ArcGIS host and layer names, overridable by environment variable.

   THESE ARE THE ONE THING IN THIS FILE I COULD NOT VERIFY. HIFLD has
   reorganised its layers more than once and restricted several without
   notice, so treat the defaults as a starting position rather than a fact.
   If a name has moved, this is an env var on Vercel rather than a code
   change and a redeploy:

     HIFLD_BASE          host + /arcgis/rest/services
     HIFLD_SUBSTATIONS   service name for substations
     HIFLD_LINES         service name for transmission lines
     HIFLD_PLANTS        service name for power plants

   GET /api/grid-atlas probes the substation layer live and reports which
   source answered, so a wrong name is one page-load away from being
   obvious — and OSM covers the layer meanwhile. */
const HIFLD = process.env.HIFLD_BASE
  || 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services';
const HIFLD_LAYERS = {
  substations: process.env.HIFLD_SUBSTATIONS || 'Electric_Substations',
  lines:       process.env.HIFLD_LINES       || 'Electric_Power_Transmission_Lines',
  plants:      process.env.HIFLD_PLANTS      || 'Power_Plants'
};
const OVERPASS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function getJson(url, opts, ms) {
  const g = withTimeout(ms || 9000);
  try {
    const r = await fetch(url, Object.assign({ signal: g.signal }, opts || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { g.done(); }
}

/* ── HIFLD ────────────────────────────────────────────────────────────────
   ArcGIS envelope query. A circle would be tighter, but an envelope is one
   parameter and the distance filter below trims the corners anyway. */
async function arcgis(service, layer, lat, lng, radiusKm, outFields) {
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.320 * Math.cos(lat * Math.PI / 180) || 1);
  const url = `${HIFLD}/${service}/FeatureServer/${layer}/query`
    + `?where=1%3D1&geometryType=esriGeometryEnvelope`
    + `&geometry=${(lng - dLng).toFixed(5)},${(lat - dLat).toFixed(5)},`
    + `${(lng + dLng).toFixed(5)},${(lat + dLat).toFixed(5)}`
    + `&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects`
    + `&outFields=${encodeURIComponent(outFields)}&returnGeometry=true`
    + `&resultRecordCount=200&f=json`;
  const j = await getJson(url);
  if (j && j.error) throw new Error(j.error.message || 'ArcGIS error');
  if (!j || !Array.isArray(j.features)) throw new Error('unexpected ArcGIS response');
  return j.features;
}

/* A feature's representative point, whatever geometry it carries. */
function featurePoint(geom) {
  if (!geom) return null;
  if (geom.x != null && geom.y != null) return { lng: geom.x, lat: geom.y };
  const path = (geom.paths && geom.paths[0]) || (geom.rings && geom.rings[0]);
  if (path && path.length) {
    const mid = path[Math.floor(path.length / 2)];
    if (mid && mid.length >= 2) return { lng: mid[0], lat: mid[1] };
  }
  return null;
}

function num(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : null; }

/* ── OpenStreetMap ────────────────────────────────────────────────────────
   Same tool the site visualizer already uses for building footprints, so
   the query shape is known-good. Tried in mirror order; a mirror that
   accepts the connection and then sits on it is handled by the timeout. */
async function overpass(query, ms) {
  let lastErr = null;
  for (const url of OVERPASS) {
    try {
      const j = await getJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: query
      }, ms || 12000);
      if (j && Array.isArray(j.elements)) return j.elements;
      lastErr = new Error('unexpected Overpass response');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no Overpass mirror answered');
}

function osmPoint(el) {
  if (el.lat != null && el.lon != null) return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  if (el.geometry && el.geometry.length) {
    const m = el.geometry[Math.floor(el.geometry.length / 2)];
    if (m) return { lat: m.lat, lng: m.lon };
  }
  return null;
}

/* OSM voltage tags carry volts, often several separated by ';'. The highest
   is the one that matters for interconnection. */
function osmKv(tag) {
  if (!tag) return null;
  const v = String(tag).split(/[;,|]/).map(x => parseFloat(x)).filter(x => isFinite(x) && x > 0);
  if (!v.length) return null;
  return Math.round(Math.max(...v) / 1000 * 10) / 10;
}

function bboxFor(lat, lng, radiusKm) {
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.320 * Math.cos(lat * Math.PI / 180) || 1);
  return [(lat - dLat).toFixed(5), (lng - dLng).toFixed(5),
          (lat + dLat).toFixed(5), (lng + dLng).toFixed(5)].join(',');
}

function within(list, radiusKm) {
  return list.filter(r => r.distanceKm != null && r.distanceKm <= radiusKm)
             .sort((a, b) => a.distanceKm - b.distanceKm);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUBSTATIONS
   ═══════════════════════════════════════════════════════════════════════════ */
async function findSubstations(lat, lng, radiusKm) {
  try {
    const f = await arcgis(HIFLD_LAYERS.substations, 0, lat, lng, radiusKm,
      'NAME,STATUS,MAX_VOLT,MIN_VOLT,TYPE,OWNER,COUNTY,STATE');
    const out = [];
    for (const ft of f) {
      const p = featurePoint(ft.geometry); if (!p) continue;
      const a = ft.attributes || {};
      if (a.STATUS && /NOT IN SERVICE|RETIRED/i.test(a.STATUS)) continue;
      out.push({
        name: a.NAME || 'Substation',
        distanceKm: distanceKm(lat, lng, p.lat, p.lng),
        voltageKv: num(a.MAX_VOLT) || num(a.MIN_VOLT),
        owner: a.OWNER || ''
      });
    }
    SOURCES.substations = 'hifld';
    return within(out, radiusKm);
  } catch (e) { SOURCES.substations = 'hifld-failed:' + (e.message || 'error'); }

  try {
    const els = await overpass(
      `[out:json][timeout:20];(node["power"="substation"](${bboxFor(lat, lng, radiusKm)});`
      + `way["power"="substation"](${bboxFor(lat, lng, radiusKm)}););out center tags;`);
    const out = [];
    for (const el of els) {
      const p = osmPoint(el); if (!p) continue;
      const t = el.tags || {};
      /* Distribution-level kiosks are not interconnection points. */
      if (t.substation && /minor_distribution/i.test(t.substation)) continue;
      out.push({
        name: t.name || t.operator || 'Substation',
        distanceKm: distanceKm(lat, lng, p.lat, p.lng),
        voltageKv: osmKv(t.voltage),
        owner: t.operator || ''
      });
    }
    SOURCES.substations = SOURCES.substations
      ? SOURCES.substations + ' -> osm' : 'osm';
    return within(out, radiusKm);
  } catch (e) {
    SOURCES.substations = (SOURCES.substations || '') + ' -> osm-failed:' + (e.message || 'error');
    return null;                     /* nobody answered: NOT measured */
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   TRANSMISSION LINES
   ═══════════════════════════════════════════════════════════════════════════ */
async function findLines(lat, lng, radiusKm) {
  try {
    const f = await arcgis(HIFLD_LAYERS.lines, 0, lat, lng, radiusKm,
      'ID,TYPE,STATUS,VOLTAGE,VOLT_CLASS,OWNER,NAICS_DESC');
    const out = [];
    for (const ft of f) {
      const p = featurePoint(ft.geometry); if (!p) continue;
      const a = ft.attributes || {};
      if (a.STATUS && /NOT AVAILABLE|RETIRED/i.test(a.STATUS)) continue;
      out.push({
        name: a.OWNER || a.VOLT_CLASS || a.TYPE || 'Transmission line',
        distanceKm: distanceKm(lat, lng, p.lat, p.lng),
        voltageKv: num(a.VOLTAGE)
      });
    }
    SOURCES.lines = 'hifld';
    return within(out, radiusKm);
  } catch (e) { SOURCES.lines = 'hifld-failed:' + (e.message || 'error'); }

  try {
    const els = await overpass(
      `[out:json][timeout:20];way["power"="line"](${bboxFor(lat, lng, radiusKm)});out geom tags;`);
    const out = [];
    for (const el of els) {
      const t = el.tags || {};
      /* Nearest POINT ON the line, not its midpoint. A 40 km circuit whose
         midpoint is far away can still run along the fence. */
      let best = null;
      for (const g of (el.geometry || [])) {
        const d = distanceKm(lat, lng, g.lat, g.lon);
        if (best == null || d < best) best = d;
      }
      if (best == null) continue;
      out.push({
        name: t.name || t.operator || 'Transmission line',
        distanceKm: best,
        voltageKv: osmKv(t.voltage)
      });
    }
    SOURCES.lines = SOURCES.lines ? SOURCES.lines + ' -> osm' : 'osm';
    return within(out, radiusKm);
  } catch (e) {
    SOURCES.lines = (SOURCES.lines || '') + ' -> osm-failed:' + (e.message || 'error');
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GENERATING PLANTS
   ═══════════════════════════════════════════════════════════════════════════ */
async function findPlants(lat, lng, radiusKm) {
  try {
    const f = await arcgis(HIFLD_LAYERS.plants, 0, lat, lng, radiusKm,
      'Plant_Name,PrimSource,Install_MW,Total_MW,Utility_Name,StateName');
    const out = [];
    for (const ft of f) {
      const p = featurePoint(ft.geometry); if (!p) continue;
      const a = ft.attributes || {};
      out.push({
        name: a.Plant_Name || 'Plant',
        distanceKm: distanceKm(lat, lng, p.lat, p.lng),
        fuel: a.PrimSource || '',
        capacityMw: num(a.Total_MW) || num(a.Install_MW)
      });
    }
    SOURCES.plants = 'hifld';
    return within(out, radiusKm);
  } catch (e) { SOURCES.plants = 'hifld-failed:' + (e.message || 'error'); }

  try {
    const bb = bboxFor(lat, lng, radiusKm);
    const els = await overpass(
      `[out:json][timeout:20];(way["power"="plant"](${bb});relation["power"="plant"](${bb}););out center tags;`);
    const out = [];
    for (const el of els) {
      const p = osmPoint(el); if (!p) continue;
      const t = el.tags || {};
      let mw = null;
      const o = t['plant:output:electricity'];
      if (o) {
        const m = String(o).match(/([\d.]+)\s*(MW|kW|GW)?/i);
        if (m) {
          mw = parseFloat(m[1]);
          if (/kW/i.test(m[2] || '')) mw /= 1000;
          if (/GW/i.test(m[2] || '')) mw *= 1000;
          if (!isFinite(mw)) mw = null;
        }
      }
      out.push({
        name: t.name || 'Generating plant',
        distanceKm: distanceKm(lat, lng, p.lat, p.lng),
        fuel: t['plant:source'] || t['generator:source'] || '',
        capacityMw: mw
      });
    }
    SOURCES.plants = SOURCES.plants ? SOURCES.plants + ' -> osm' : 'osm';
    return within(out, radiusKm);
  } catch (e) {
    SOURCES.plants = (SOURCES.plants || '') + ' -> osm-failed:' + (e.message || 'error');
    return null;
  }
}

/* Haversine, for computing distanceKm once the raw features are in hand. */
function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat/2) ** 2
          + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng/2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 100) / 100;
}

/* ── CROSS-ORIGIN ────────────────────────────────────────────────────────
   The portfolio console is served from the same deployment as this function,
   so it never needed CORS. The site editor is not: it runs on
   nextnrg.csebuilders.com and alpha.clearskyomega.com and calls this at
   osa.clearskyomega.com. Without the headers below the browser blocks the
   reply and the editor reports "Failed to fetch" — the same opaque failure
   the NREL lookups hit, and just as slow to diagnose from the symptom.

   A JSON POST also triggers a preflight OPTIONS, which this handler answered
   with 405 "GET or POST." — so the real request was never even sent.

   An allowlist rather than '*', because GRID_ATLAS_KEY exists to keep this
   off the open internet and a wildcard would undo that. Add hosts with
   GRID_ATLAS_ORIGINS, comma separated. */
const ALLOWED_ORIGINS = (process.env.GRID_ATLAS_ORIGINS
  || 'https://osa.clearskyomega.com,https://alpha.clearskyomega.com,'
   + 'https://nextnrg.csebuilders.com,https://tools.csebuilders.com')
  .split(',').map(s => s.trim()).filter(Boolean);

function applyCors(req, res) {
  /* Guarded: a header helper must never be the thing that takes the endpoint
     down. Any runtime whose response object differs still gets a working
     answer, just without the CORS headers. */
  if (!res || typeof res.setHeader !== 'function') return;
  const origin = req && req.headers && (req.headers.origin || req.headers.Origin);
  if (origin && ALLOWED_ORIGINS.indexOf(origin) >= 0) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);  /* local development */
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Grid-Atlas-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  /* Preflight. Must answer before the method check below, which used to
     reject OPTIONS with a 405 and stop every cross-origin call dead. */
  if (req.method === 'OPTIONS') return res.status(204).end();

  /* GET is a health check. "Is it deployed and what is configured" should be
     answerable from a browser address bar rather than by finding a deal with
     an address on it and pressing a button. */
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      build: BUILD,
      model: MODEL.version,
      geocoder: 'US Census, then OpenStreetMap \u2014 both free, no key'
        + (process.env.GOOGLE_GEOCODING_KEY ? ', then Google' : ' (no Google key set, not needed)'),
      addressHandling: 'Unit and building designators are stripped, then the address is '
        + 'retried progressively less specific until something matches.',
      authRequired: !!process.env.GRID_ATLAS_KEY,
      dataSources: {
        primary:  'HIFLD Open (ArcGIS) \u2014 substations, transmission lines, power plants',
        fallback: 'OpenStreetMap via Overpass \u2014 used per layer when HIFLD does not answer',
        keys:     'none required for either',
        hifldBase: HIFLD,
        hifldLayers: HIFLD_LAYERS,
        overpassMirrors: OVERPASS.length
      },
      probe: await (async () => {
        /* Actually ask, rather than assert. HIFLD has moved layers before and
           will again; a health check that only repeats what the file believes
           is worth nothing on the day that changes. */
        try {
          const r = await findSubstations(41.8781, -87.6298, 10);
          return { ran: true, chicagoSubstationsWithin10km: r ? r.length : null,
                   source: SOURCES.substations,
                   nearestKm: r && r[0] ? r[0].distanceKm : null };
        } catch (e) { return { ran: false, error: String(e.message || e) }; }
      })(),
      note: 'A layer no source answers for is UNSCORED, not zero \u2014 it drops out of the '
          + 'weighting rather than counting against the site.'
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST.' });

  /* Optional shared secret. Set GRID_ATLAS_KEY once OGI is calling this, so
     the endpoint is not simply open. Skipped when unset so it works from the
     console on day one without ceremony. */
  const want = process.env.GRID_ATLAS_KEY;
  if (want) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (got !== want) return res.status(401).json({ error: 'Bad or missing key.' });
  }

  SOURCES.substations = SOURCES.lines = SOURCES.plants = null;
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const { address, sizeMw } = body;
  let { lat, lng } = body;
  const radiusKm = Number(body.radiusKm) || 25;

  if (lat == null || lng == null) {
    if (!address) return res.status(400).json({ error: 'address or lat/lng required.' });
    try {
      const g = await geocode(address);
      lat = g.lat; lng = g.lng;
      body.resolvedAddress = g.resolved;
      body.geocode = { provider: g.provider, precision: g.precision,
                       queried: g.queried, note: g.note || '' };
    } catch (e) {
      return res.status(422).json({ build: BUILD, error: String(e.message || e) });
    }
  }

  try {
    /* In parallel: one slow layer should not serialise the others. */
    const [substations, lines, plants] = await Promise.all([
      findSubstations(lat, lng, radiusKm).catch(() => null),
      findLines(lat, lng, radiusKm).catch(() => null),
      findPlants(lat, lng, radiusKm).catch(() => null)
    ]);

    /* null means the layer failed; [] means it worked and found nothing. The
       difference matters: "no substation within 25 km" is a finding, "we could
       not check" is not. */
    const nearestSub  = substations && substations[0];
    const nearestLine = lines && lines[0];

    const computed = weightedScore({
      substation:   substations ? MODEL.substationScore(nearestSub ? nearestSub.distanceKm : 999) : null,
      voltage:      substations && nearestSub ? MODEL.voltageScore(nearestSub.voltageKv, sizeMw) : null,
      transmission: lines ? MODEL.transmissionScore(nearestLine ? nearestLine.distanceKm : 999) : null,
      congestion:   plants ? MODEL.congestionScore(plants) : null
    });

    /* Declared BEFORE the findings that read it. It was previously a `const`
       sixteen lines further down, which put every read here inside the
       temporal dead zone and threw ReferenceError on every POST — the
       service answered 502 "Grid Atlas failed." for every site, and the
       message gave no hint that the cause was two lines in the wrong order. */
    const anyLayer = substations || lines || plants;

    const findings = [];
    if (!anyLayer) findings.push({ severity:'note',
      text:'Neither HIFLD nor OpenStreetMap answered for any layer, so nothing was '
         + 'measured and no score was produced. Sources tried: '
         + JSON.stringify(SOURCES) + '.' });
    if (anyLayer && !substations) findings.push({ severity:'note', text:'Substation layer unavailable — not scored.' });
    if (anyLayer && !lines)       findings.push({ severity:'note', text:'Transmission layer unavailable — not scored.' });
    if (substations && !nearestSub)
      findings.push({ severity:'blocker', text:'No substation within ' + radiusKm + ' km.' });
    if (nearestSub && nearestSub.distanceKm > 10)
      findings.push({ severity:'risk', text:'Nearest substation is ' + nearestSub.distanceKm
        + ' km — interconnection cost will dominate the budget.' });
    if (nearestSub && sizeMw && nearestSub.voltageKv && MODEL.voltageScore(nearestSub.voltageKv, sizeMw) <= 3)
      findings.push({ severity:'risk', text:'Nearest substation is '
        + nearestSub.voltageKv + ' kV, thin for ' + sizeMw + ' MW.' });

    /* No score means no claim. Saying "no substation found" when we never
       looked is the same lie in words that the 21 was in numbers. */
    const summary = !anyLayer
      ? 'No grid data source answered \u2014 nothing measured.'
      : nearestSub
        ? nearestSub.voltageKv + ' kV substation ' + nearestSub.distanceKm + ' km away'
          + (nearestLine ? ', transmission ' + nearestLine.distanceKm + ' km' : '')
        : substations
          ? 'No substation found within ' + radiusKm + ' km'
          : 'Substation layer not connected';

    /* A rough match must be visible. A score computed from a point two streets
       away is still useful; a score computed from the middle of the town while
       everyone assumes it was the parcel is not \u2014 the number looks identical
       either way, so the only defence is saying so. */
    if (body.geocode && body.geocode.precision && body.geocode.precision !== 'exact') {
      findings.unshift({ severity: body.geocode.precision === 'area' ? 'risk' : 'note',
        text: 'Location is approximate \u2014 ' + body.geocode.note });
    }

    res.status(200).json({
      build: BUILD,
      score: computed.score,
      model: MODEL.version,
      summary,
      lat, lng,
      geocode: body.geocode || null,
      resolvedAddress: body.resolvedAddress || address || '',
      substations: substations || [],
      lines: lines || [],
      plants: plants || [],
      criteria: computed.rows,
      unscored: computed.unscored,
      /* Which source produced each layer. A wrong or moved HIFLD endpoint
         shows up here as "hifld-failed:... -> osm" rather than as silence,
         so a degraded answer is visible instead of merely quieter. */
      sources: Object.assign({}, SOURCES),
      findings
    });
  } catch (err) {
    res.status(502).json({ build: BUILD, error: 'Grid Atlas failed.',
      detail: String((err && err.message) || err).slice(0, 300) });
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
   POINTING grid-atlas.html AT THIS
   ─────────────────────────────────────────────────────────────────────────────
   Optional, and worth doing eventually. If the page calls this endpoint instead
   of doing its own lookups, there is one implementation of the scoring model
   and the page cannot drift from what the pipeline records. The map rendering
   stays exactly where it is — only the analysis moves.

       const r = await fetch('/api/grid-atlas', {
         method:'POST', headers:{'Content-Type':'application/json'},
         body: JSON.stringify({ address, sizeMw })
       });

   Until then the two coexist safely: the console uses this, the page uses its
   own, and the only cost is that a number in the console may not exactly match
   the same site opened in the page. Worth closing, not urgent.
   ───────────────────────────────────────────────────────────────────────────── */
