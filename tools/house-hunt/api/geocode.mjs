// Address -> map point, for "Show on map" on listings and the page's address box.
// The US Census geocoder places a house number along the street (TIGER), which covers new
// subdivisions OpenStreetMap often lacks; OpenStreetMap (Nominatim, biased to the Upstate) is the
// fallback and may only know the street. Neither allows calls from a browser, so the API asks.
// Free services: Census asks nothing; Nominatim asks for a real User-Agent and at most 1 request/s,
// which a family clicking buttons never approaches.
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const PLACES = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UPSTATE = '-82.7,35.25,-81.6,34.5'; // lon/lat box around Greenville–Spartanburg: a preference, not a limit
const ADDRESS_TYPES = ['building', 'house', 'place', 'house_number'];

const round = (n) => Math.round(n * 1e5) / 1e5;

/** Returns { ll: [lat, lng], label, precision: 'address' | 'street' | 'area' } or null */
export async function geocode(q, { fetch = globalThis.fetch, log = console.log } = {}) {
  const get = async (url, headers) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return res.json();
  };
  try {
    const r = await get(`${CENSUS}?${new URLSearchParams({ address: q, benchmark: 'Public_AR_Current', format: 'json' })}`);
    const m = r?.result?.addressMatches?.[0];
    if (m && Number.isFinite(m.coordinates?.y) && Number.isFinite(m.coordinates?.x)) {
      return { ll: [round(m.coordinates.y), round(m.coordinates.x)], label: String(m.matchedAddress || q), precision: 'address' };
    }
  } catch (e) { log({ geocoder: 'census', error: e.message }); }
  try {
    const r = await get(`${NOMINATIM}?${new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'us', viewbox: UPSTATE })}`,
      { 'user-agent': 'dot-y.co house-hunt (contact@dot-y.co)' });
    const m = Array.isArray(r) ? r[0] : null;
    const lat = Number(m?.lat), lng = Number(m?.lon);
    if (m && Number.isFinite(lat) && Number.isFinite(lng)) {
      const precision = ADDRESS_TYPES.includes(m.addresstype) ? 'address' : m.addresstype === 'road' ? 'street' : 'area';
      return { ll: [round(lat), round(lng)], label: String(m.display_name || q).slice(0, 200), precision };
    }
  } catch (e) { log({ geocoder: 'nominatim', error: e.message }); }
  return null;
}

// Whether a point is inside Greer's city limits: 'in', 'out', or '' when we can't tell. From the
// Census's incorporated places, which it redraws once a year from what the city reports, so a
// recent annexation may be missing; the city's GIS office is the word that counts (we may run for
// council, and that needs a home inside). Only worth asking for a house-level point.
export async function cityLimits(ll, { fetch = globalThis.fetch, log = console.log } = {}) {
  try {
    const url = `${PLACES}?${new URLSearchParams({ x: String(ll[1]), y: String(ll[0]), benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'Incorporated Places', format: 'json' })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`census ${res.status}`);
    const geo = (await res.json())?.result?.geographies;
    if (!geo || typeof geo !== 'object') return '';
    // Outside every town, the layer is left out entirely rather than listed empty
    return (geo['Incorporated Places'] || []).some((p) => p?.NAME === 'Greer city') ? 'in' : 'out';
  } catch (e) { log({ cityLimits: 'census', error: e.message }); return ''; }
}

/** A listing's address -> 'in' | 'out' | '' (see cityLimits) */
export async function locate(address, city, deps = {}) {
  const g = await geocode(`${address}, ${city || 'Greer'}, SC`, deps);
  return g?.precision === 'address' ? cityLimits(g.ll, deps) : '';
}
