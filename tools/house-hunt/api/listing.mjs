// Listing rows, shared by the page's API (api.mjs) and the email ingest (ingest.mjs).
// A listing is a home for sale, filed under a neighborhood (hoodId) or unsorted (null), ranked
// within it. A rejected one is hidden on the page but kept, so a later alert about the same house
// updates it (still rejected) instead of adding it again. Rows: pk = TOOL, sk = LISTING#<id>.

export const STATUSES = ['active', 'pending', 'sold', 'gone'];
// What a listing alert said about a home; ingest maps these onto status
export const EVENTS = ['new', 'price_cut', 'price_increase', 'back_on_market', 'pending', 'sold', 'open_house', 'other'];

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const whole = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
export const webUrl = (v) => {
  try { const u = new URL(str(v, 1000)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; }
};

// Redfin alerts often link a home only through "Go tour" (/tours/checkout/times?propertyId=…), a
// scheduling page. Redfin redirects /<state>/<city>/<any slug>/home/<propertyId> to the home's own
// page, so we keep that instead; on its home pages we drop the tracking query (utm_*, riftinfo).
export function listingUrl(v, address, city) {
  const href = webUrl(v);
  if (!href) return '';
  const u = new URL(href);
  if (!/(^|\.)redfin\.com$/i.test(u.hostname)) return href;
  const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
  const propertyId = u.searchParams.get('propertyId');
  if (u.pathname.startsWith('/tours/') && /^\d+$/.test(propertyId || '')) {
    return `https://www.redfin.com/SC/${slug(city || 'Greer')}/${slug(address)}/home/${propertyId}`;
  }
  if (/\/home\/\d+\/?$/.test(u.pathname)) return u.origin + u.pathname;
  return href;
}

// "123 Sugar Lake Court, Greer, SC 29650" and "123 sugar lake ct" are the same house
const ABBREV = { road: 'rd', drive: 'dr', court: 'ct', street: 'st', lane: 'ln', circle: 'cir', avenue: 'ave', boulevard: 'blvd', place: 'pl', trail: 'trl', terrace: 'ter', parkway: 'pkwy', north: 'n', south: 's', east: 'e', west: 'w' };
export function addressKey(address) {
  return str(address, 200).split(',')[0].toLowerCase().replace(/[.#]/g, ' ').replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/).filter(Boolean).map((w) => ABBREV[w] || w).join(' ');
}

// We're only looking in Greer: a home counts when its city is Greer or its address carries a Greer
// zip (29650–29652). Alerts also bring Taylors, Greenville, Spartanburg…; those aren't filed.
export function isGreer(city, address) {
  return str(city, 60).toLowerCase() === 'greer' || /,\s*greer\b|\b2965[012]\b/i.test(str(address, 200));
}

/** Validates a listing from the page or ingest. Returns { listing } or { error }. */
export function cleanListing(body, id) {
  const address = str(body.address, 160);
  if (!address) return { error: 'address required' };
  if (body.hoodId != null && body.hoodId !== '' && !/^[A-Za-z0-9_-]{1,40}$/.test(body.hoodId)) return { error: 'bad hoodId' };
  for (const [k, max] of [['price', 1e8], ['beds', 50], ['sqft', 100000], ['rank', 999]]) {
    if (body[k] != null && whole(body[k], max) === null) return { error: `${k} must be a whole number` };
  }
  if (body.baths != null && !(Number.isFinite(body.baths) && body.baths >= 0 && body.baths <= 50)) return { error: 'baths must be a number' };
  const status = body.status ?? 'active';
  if (!STATUSES.includes(status)) return { error: `status must be one of ${STATUSES.join(', ')}` };
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > 50) return { error: 'history must be a list' };
  return {
    listing: {
      id, hoodId: body.hoodId || null, address, city: str(body.city, 60),
      price: body.price ?? null, beds: body.beds ?? null, baths: body.baths ?? null, sqft: body.sqft ?? null,
      url: listingUrl(body.url, address, str(body.city, 60)), status, event: EVENTS.includes(body.event) ? body.event : '', summary: str(body.summary, 400),
      notes: str(body.notes, 5000), rank: body.rank ?? null, reviewed: body.reviewed === true, rejected: body.rejected === true,
      source: body.source === 'email' ? 'email' : 'manual',
      firstSeenAt: iso(body.firstSeenAt), lastSeenAt: iso(body.lastSeenAt),
      history: history.filter((h) => h && iso(h.at) && EVENTS.includes(h.kind)).slice(-30)
        .map((h) => ({ at: iso(h.at), kind: h.kind, price: whole(h.price, 1e8) })),
    },
  };
}

export const listingOut = (i) => ({
  id: i.sk.slice(8), hoodId: i.hoodId ?? null, address: i.address, city: i.city || '', price: i.price ?? null,
  beds: i.beds ?? null, baths: i.baths ?? null, sqft: i.sqft ?? null, url: i.url || '', status: i.status, event: i.event || '',
  summary: i.summary || '', notes: i.notes || '', rank: i.rank ?? null, reviewed: !!i.reviewed, rejected: !!i.rejected, source: i.source || 'manual',
  firstSeenAt: i.firstSeenAt || null, lastSeenAt: i.lastSeenAt || null, history: i.history || [],
  rev: i.rev, updatedAt: i.updatedAt, updatedByName: i.updatedByName || '',
});
