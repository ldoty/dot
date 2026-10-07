// Starting data for House Hunt: the Greer Trail Neighborhoods map (2026-09-27: shortlist, visits,
// drive times, pins) merged with the pool + Riverside High research (2026-10-04: median prices).
// Prices are median sales Oct 2025 – Sep 2026 from Palmetto Park unless the price note says otherwise.
// Drive times are [minutes, miles] with no traffic (OSRM), in the order of DESTS.
// Personal places (family, Amber's gym) live in private/house-hunt-places.json, not here.

export const DESTS = ['GREEN Charter Elementary', 'Langston Charter Middle', "Mom's house", "Amber's cheer gym"];

const PP = 'https://www.palmettopark.com/greer/';
const RIVERSIDE = { elementary: 'Woodland Elementary', middle: 'Riverside Middle', high: 'Riverside High' };
const drives = (rows) => rows.map(([min, mi], i) => ({ to: DESTS[i], min, mi }));

export const HOODS = [
  // Shortlist, ranked
  {
    id: 'pelham-falls', name: 'Pelham Falls', status: 'shortlist', rank: 1, visited: 'Sep 26', ...RIVERSIDE,
    summary: 'A 1.2-mile paved walking and biking path along the Enoree River and Rocky Creek. Pelham Mill Park is next door.',
    pool: 'Two pools; SAIL swim team', price: 510000, sales: 15,
    priceNote: 'Up 7.3% on the year. On the Greer–Greenville line; some homes have Greenville addresses.',
    facts: ['1.2-mile paved walking and biking path along the Enoree River and Rocky Creek', 'Walk to Pelham Mill Park (river trail, dog park)', 'Clubhouse and neighborhood events'],
    drives: drives([[11, 5.0], [8, 3.9], [9, 3.7], [16, 7.5]]), ll: [34.8495, -82.2227], source: `${PP}pelham-falls`,
  },
  {
    id: 'sugar-creek', name: 'Sugar Creek', status: 'shortlist', rank: 2, visited: 'drove through',
    elementary: 'Buena Vista Elementary', middle: 'Northwood Middle', high: 'Riverside High',
    summary: 'A large amenity neighborhood off Sugar Creek Rd, near Riverside High. Walking paths around two ponds.',
    pool: '3 pools, 3 clubhouses; swim team', price: 637500, sales: 30, priceNote: 'Up 1.6% on the year.',
    facts: ['3 pools, 3 clubhouses, tennis and pickleball courts, swim team', 'Two ponds, internal walking paths and lit sidewalks', 'Playgrounds and year-round neighborhood events'],
    drives: drives([[9, 3.6], [16, 7.8], [17, 7.5], [11, 4.9]]), ll: [34.8901, -82.2772], source: `${PP}sugar-creek`,
  },
  {
    id: 'sugar-mill', name: 'Sugar Mill', status: 'shortlist', rank: 3,
    elementary: 'Buena Vista Elementary', middle: 'Riverside Middle', high: 'Riverside High',
    summary: '7 acres of common ground on the Enoree River, plus a pool, tennis courts and sidewalks. Off S. Batesville Rd.',
    pool: 'Neighborhood pool, clubhouse, tennis and pickleball', price: 675000, sales: 10, priceNote: 'Up 0.9% on the year.',
    facts: ['7 acres of HOA common ground, including 600 ft of Enoree riverfront', 'Pool, tennis courts, clubhouse, playground, sidewalks', 'Mostly traditional brick homes'],
    drives: drives([[10, 4.0], [14, 6.6], [15, 6.0], [13, 5.3]]), ll: [34.8816, -82.2585], source: `${PP}sugarmill`,
  },
  {
    id: 'brushy-meadows', name: 'Brushy Meadows', status: 'shortlist', rank: 4, visited: 'Sep 26', ...RIVERSIDE,
    summary: 'Off Brushy Creek Rd, between Brushy Creek Townes and downtown Greer.',
    pool: 'Pool, clubhouse; youth swim team', price: 528000, sales: 5,
    priceNote: 'Up 18.7% on the year (small sample). Listings $475,000–$500,000.',
    facts: ['Pool, clubhouse, tennis and pickleball courts, pond', 'Bike path, walking trails and a youth swim team', 'Homes 2,000–3,400 sq ft on about 1/3-acre lots'],
    drives: drives([[17, 7.5], [19, 10.0], [16, 7.8], [6, 1.8]]), ll: [34.9196, -82.2504], source: `${PP}brushy-meadows`,
  },
  // No-go
  {
    id: 'shelburne-farms', name: 'Shelburne Farms', status: 'nogo', visited: 'Sep 26', ...RIVERSIDE,
    summary: 'Off Dillard Rd, between Sugar Mill and the airport.', fitNote: 'Community pool not confirmed',
    facts: ['Same Riverside school zone as Pelham Falls'],
    drives: drives([[14, 6.2], [15, 6.9], [14, 5.6], [11, 4.2]]), ll: [34.8889, -82.2465],
  },
  // To explore: pool + Riverside High
  {
    id: 'bent-creek-plantation', name: 'Bent Creek Plantation', status: 'explore', ...RIVERSIDE,
    pool: 'Community pool with a swim team', price: 345000, sales: 7, priceNote: 'Up 3.0% on the year.', source: `${PP}bent-creek-plantation`,
  },
  {
    id: 'village-at-bent-creek', name: 'The Village at Bent Creek', status: 'explore', ...RIVERSIDE,
    pool: 'Large pool with a youth swim team (gated)', price: 405000,
    priceNote: 'Estimate: the only published median ($405,000) is from Apr 2021 – Mar 2022; recent sales were $363,000, $418,000 and $500,000.',
    source: `${PP}the-village-at-bent-creek`,
  },
  {
    id: 'riverwood-farm', name: 'Riverwood Farm', status: 'explore', ...RIVERSIDE,
    summary: 'Gated, off Pelham Rd about five minutes from GSP.',
    pool: 'Junior Olympic-size pool (gated)', price: 620000, priceNote: 'Up 24% on the year (small sample). Active listings around $665,000.',
    source: `${PP}riverwood-farm`,
  },
  {
    id: 'sudduth-farms', name: 'Sudduth Farms', status: 'explore', ...RIVERSIDE,
    pool: 'Junior Olympic-size pool', price: 330750, sales: 16, priceNote: 'Up 11.0% on the year.', source: `${PP}sudduth-farms`,
  },
  {
    id: 'silverleaf', name: 'Silverleaf', status: 'explore', elementary: 'Brushy Creek Elementary', middle: 'Northwood Middle', high: 'Riverside High',
    pool: 'Olympic-size pool; Swordfish swim team', price: 558515, sales: 10, priceNote: 'Different elementary and middle schools from most of the others.',
    source: 'https://ppk26.palmettopark.com/greer/silverleaf',
  },
  {
    id: 'river-oaks', name: 'River Oaks', status: 'explore', high: 'Riverside High',
    summary: 'Established Eastside neighborhood near Pelham Rd, GSP and BMW.',
    pool: 'Community pool', price: 645000, priceNote: 'Up 7.5% on the year. Elementary and middle schools not listed.',
    source: 'https://ppk26.palmettopark.com/greer/river-oaks',
  },
  {
    id: 'riverside-glen', name: 'Riverside Glen', status: 'explore', high: 'Riverside High',
    pool: 'Pool with a cabana', price: 319900, sales: 5,
    priceNote: 'Older figure: Nov 2023 – Oct 2024, probably higher now. Zoning from the weakest source; verify.', source: `${PP}riverside-glen`,
  },
  // To explore: from the trail map, outside the pool + Riverside High filter
  {
    id: 'gresham-woods', name: 'Gresham Woods', status: 'explore',
    elementary: 'Bells Crossing Elementary', middle: 'Mauldin Middle', high: 'Mauldin High', fitNote: 'Mauldin High, not Riverside',
    summary: "Walking trails and sidewalks inside the neighborhood. It's in the Five Forks area, farther south than the others.",
    pool: 'Pool, tennis and basketball courts, clubhouse',
    facts: ['Simpsonville mailing address, Five Forks area', 'Walking trails and sidewalks, pool, tennis and basketball courts, clubhouse', 'Different school zone from the other neighborhoods here'],
    drives: drives([[18, 7.9], [8, 4.0], [14, 7.3], [24, 12.0]]), ll: [34.7993, -82.2089],
  },
  {
    id: 'brushy-creek-townes', name: 'Brushy Creek Townes', status: 'explore',
    elementary: 'Brushy Creek Elementary', middle: 'Northwood Middle', high: 'Riverside High', fitNote: 'No community pool listed',
    summary: 'Newer townhomes (2019–2021) with sidewalks and trails. Close to East Riverside Park.',
    facts: ['Townhomes built 2019–2021 by D.R. Horton / Express Homes', 'Sidewalks and trails, dog friendly', 'Short drive to East Riverside Park'],
    drives: drives([[14, 6.2], [20, 9.4], [18, 8.8], [8, 2.8]]), ll: [34.9134, -82.2678],
  },
  {
    id: 'downtown-greer', name: 'Downtown Greer', status: 'explore',
    elementary: 'Varies by street (e.g. Crestview)', middle: 'Greer Middle', high: 'Greer High', fitNote: 'Greer High, not Riverside; no community pool',
    schoolNote: 'Some addresses east of downtown are in Spartanburg District 5 instead of Greenville County Schools.',
    summary: 'The most walkable area. Shops and restaurants on Trade St., and the Greer City Park loop.',
    facts: ['Walk to shops and restaurants on Trade St.', 'Greer City Park loop, pond and amphitheater', 'Mostly older homes on small lots'],
    drives: drives([[19, 8.7], [19, 9.9], [11, 5.6], [4, 0.9]]), ll: [34.9336, -82.2254],
  },
  // To explore: added 2026-10-07 (Palmetto Park; county and school district from the Census geocoder)
  {
    id: 'dillard-creek-crossing', name: 'Dillard Creek Crossing', status: 'explore', ...RIVERSIDE,
    summary: 'Newer homes (2008–2015) off Horton Grove Rd, close to Hwy 14, Pelham Rd and GSP. Minutes from Pelham Falls.',
    pool: 'Pool with a lighted cabana; playground', price: 565000, sales: 9,
    priceNote: 'Up 8.7% on the year. Recent sales $400,000–$630,000.',
    schoolNote: 'In Spartanburg County, but zoned for Greenville County Schools.',
    facts: ['Homes built 2008–2015, mostly Craftsman and traditional; about 4 bedrooms on 0.2-acre lots', 'Pool, lighted cabana, playground and sidewalks',
      'Spartanburg County address (county taxes and services), Greenville County Schools'],
    drives: drives([[13, 6.8], [12, 5.8], [5, 1.6], [16, 7.3]]), ll: [34.8579, -82.2081], source: `${PP}dillard-creek-crossing`,
  },
];

export const PLACES = [
  { id: 'gsp', kind: 'airport', name: 'GSP International Airport', note: 'The airport sits inside Greer city limits. Map rings are 3, 6 and 9 miles from it.', ll: [34.8954, -82.2172] },
  { id: 'pelham-mill-park', kind: 'park', name: 'Pelham Mill Park', note: 'A river trail past 1800s cotton mill ruins and the Enoree shoals. Has a dog park and picnic area.', ll: [34.8585, -82.2302] },
  { id: 'greer-city-park', kind: 'park', name: 'Greer City Park', note: 'A 12-acre park with a walking loop, pond, playground and amphitheater.', ll: [34.9389, -82.2227] },
  { id: 'east-riverside-park', kind: 'park', name: 'East Riverside Park', note: '18 pickleball courts, a big playground and community gardens.', ll: [34.9053, -82.2621] },
  { id: 'lake-cunningham', kind: 'park', name: 'Lake Cunningham', note: 'A quiet reservoir north of town for fishing and kayaking.', ll: [34.9810, -82.2685] },
  { id: 'lake-robinson', kind: 'park', name: 'Lake Robinson', note: "A larger reservoir with a boat landing. It's a drive from the airport side of town.", ll: [35.0169, -82.3132] },
];
