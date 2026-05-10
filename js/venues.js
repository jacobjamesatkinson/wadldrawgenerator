/**
 * Map CSV scheduling site labels to Tabbycat rooms (GET …/venues) for display and POST …/pairings.
 * Matching is case- and spacing-insensitive on Tabbycat name and display_name.
 */

import { sanitizeCsvCell } from "./merge.js";

function normalizeSiteKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function venueSelfUrl(v) {
  return v?.url || v?._links?.url || null;
}

export function venueDisplayLabel(v) {
  const d = String(v?.display_name ?? "").trim();
  if (d) return d;
  const n = String(v?.name ?? "").trim();
  return n || "—";
}

/** Label shown in the room datalist / input (disambiguate duplicate names with Tabbycat id). */
export function venuePickerLabel(v) {
  const d = venueDisplayLabel(v);
  if (v != null && v.id !== undefined && v.id !== null && `${v.id}`.trim() !== "") {
    return `${d} (#${v.id})`;
  }
  return d;
}

/**
 * Resolve text from the manual room field to a venue row (exact picker label, (#id), display/name, or unique partial match).
 */
export function resolveVenueFromPickerInput(text, venues) {
  const raw = sanitizeCsvCell(text);
  if (!raw) return null;
  if (normalizeSiteKey(raw) === normalizeSiteKey("CCGS")) {
    const viaChristchurch = resolveVenueFromPickerInput("Christchurch", venues);
    if (viaChristchurch) return viaChristchurch;
  }
  const list = Array.isArray(venues) ? venues : [];
  const lower = raw.toLowerCase();

  for (const v of list) {
    if (venuePickerLabel(v).toLowerCase() === lower) return v;
  }

  const idM = raw.match(/\(#\s*(\d+)\s*\)\s*$/);
  if (idM) {
    const id = parseInt(idM[1], 10);
    if (!Number.isNaN(id)) {
      const byId = list.find((x) => Number(x.id) === id);
      if (byId) return byId;
    }
  }

  const dispEq = list.filter(
    (v) =>
      venueDisplayLabel(v).toLowerCase() === lower || normalizeSiteKey(v.name) === normalizeSiteKey(raw)
  );
  if (dispEq.length === 1) return dispEq[0];

  const starts = list.filter((v) => venuePickerLabel(v).toLowerCase().startsWith(lower));
  if (starts.length === 1) return starts[0];

  const incl = list.filter((v) => venuePickerLabel(v).toLowerCase().includes(lower));
  if (incl.length === 1) return incl[0];

  return null;
}

function dedupeVenuesByUrl(venues) {
  const seen = new Set();
  const out = [];
  for (const v of venues || []) {
    const u = venueSelfUrl(v);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(v);
  }
  return out;
}

function sortVenuesForAssignment(venues) {
  return venues.slice().sort((a, b) => {
    const pa = Number(a.priority);
    const pb = Number(b.priority);
    const aOk = Number.isFinite(pa);
    const bOk = Number.isFinite(pb);
    if (aOk && bOk && pa !== pb) return pa - pb;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

function normTimeslotKey(ts) {
  return sanitizeCsvCell(String(ts ?? ""));
}

function sortTimeslotKeysAsc(keys) {
  const toNum = (s) => {
    const x = String(s ?? "").replace(/,/g, ".").replace(/:/g, ".");
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : null;
  };
  return [...new Set(keys)].sort((a, b) => {
    const na = toNum(a);
    const nb = toNum(b);
    if (na != null && nb != null && na !== nb) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  });
}

/**
 * @param {object[]} venues - from listVenues (Tabbycat API)
 */
export function buildVenueResolver(venues) {
  const list = dedupeVenuesByUrl(Array.isArray(venues) ? venues : []);
  const byKey = new Map();

  function addAlias(key, v) {
    if (!key) return;
    const u = venueSelfUrl(v);
    if (!u) return;
    if (!byKey.has(key)) byKey.set(key, []);
    const arr = byKey.get(key);
    if (!arr.some((x) => venueSelfUrl(x) === u)) arr.push(v);
  }

  for (const v of list) {
    addAlias(normalizeSiteKey(v.name), v);
    addAlias(normalizeSiteKey(v.display_name), v);
  }

  /** CSV "CCGS" ↔ Christchurch site: any Tabbycat room whose name/display suggests Christchurch. */
  function isChristchurchLikeVenue(v) {
    const nk = normalizeSiteKey(v.name);
    const dk = normalizeSiteKey(v.display_name);
    return (
      nk.includes("christchurch") ||
      dk.includes("christchurch") ||
      nk.includes("christ church") ||
      dk.includes("christ church")
    );
  }

  const christchurchKey = normalizeSiteKey("Christchurch");
  const ccgsKey = normalizeSiteKey("CCGS");
  const chchVenues = list.filter(isChristchurchLikeVenue);
  for (const v of chchVenues) {
    addAlias(christchurchKey, v);
    addAlias(ccgsKey, v);
  }

  function venuesForSiteLabel(csvSiteLabel) {
    const k = normalizeSiteKey(csvSiteLabel);
    if (!k) return [];

    let pool = dedupeVenuesByUrl(byKey.get(k) || []);
    if (pool.length) return sortVenuesForAssignment(pool);

    if (k.length < 3) return [];

    const prefixHits = [];
    for (const v of list) {
      const nk = normalizeSiteKey(v.name);
      const dk = normalizeSiteKey(v.display_name);
      const hit =
        nk.startsWith(`${k} `) ||
        nk.startsWith(`${k}-`) ||
        dk.startsWith(`${k} `) ||
        dk.startsWith(`${k}-`);
      if (hit) prefixHits.push(v);
    }
    return sortVenuesForAssignment(dedupeVenuesByUrl(prefixHits));
  }

  return { venuesForSiteLabel, venueCount: list.length };
}

/**
 * Assign Tabbycat venue URL + display label to each debate (mutates debates).
 *
 * For each CSV site (venueKey) we hand out distinct Tabbycat rooms in priority order
 * across every timeslot + draw position. The draw no longer tries to infer "which
 * room hosts which timeslot" from the room name — the debate's scheduled_at field
 * (date picked per venue + CSV timeslot) carries the clock time on POST, so any
 * matching room can host any timeslot's debate.
 *
 * @returns {string[]} human-readable warnings
 */
export function assignTabbycatVenuesToDebates(debates, resolver) {
  const warnings = [];
  if (!debates?.length) return warnings;
  if (!resolver?.venuesForSiteLabel) return warnings;

  for (const d of debates) {
    delete d.venueUrl;
    delete d.tabbycatVenueDisplay;
    delete d.tabbycatVenueNote;
  }

  const byVenue = new Map();
  for (const d of debates) {
    const vk = d.venueKey ?? "";
    if (!byVenue.has(vk)) byVenue.set(vk, new Map());
    const tsK = normTimeslotKey(d.timeslot);
    const tsM = byVenue.get(vk);
    if (!tsM.has(tsK)) tsM.set(tsK, []);
    tsM.get(tsK).push(d);
  }

  for (const [, tsMap] of byVenue) {
    const flat = [...tsMap.values()].flat();
    const label = flat[0]?.venueLabel || "";
    if (!label) continue;

    const matches = resolver.venuesForSiteLabel(label);
    if (!matches.length) {
      warnings.push(
        `No Tabbycat room matched CSV site "${label}" (try matching Tabbycat room name or display name, ignoring case). Those debates will post without a venue.`
      );
      continue;
    }

    const roomQ = [...sortVenuesForAssignment(matches)];
    const totalDebates = flat.length;
    let lastResort = roomQ[roomQ.length - 1];
    let reuseWarned = false;

    const slotKeys = sortTimeslotKeysAsc([...tsMap.keys()]);
    for (const tsK of slotKeys) {
      const group = (tsMap.get(tsK) || []).slice().sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
      for (const d of group) {
        let pick = roomQ.shift();
        if (!pick) {
          pick = lastResort;
          if (!reuseWarned) {
            reuseWarned = true;
            warnings.push(
              `Site "${label}": ran out of distinct Tabbycat rooms for this site — extra debates reuse a room.`
            );
          }
        }
        d.venueUrl = venueSelfUrl(pick);
        d.tabbycatVenueDisplay = venueDisplayLabel(pick);
        lastResort = pick;
      }
    }

    if (matches.length === 1 && totalDebates > 1) {
      warnings.push(
        `Site "${label}": only one Tabbycat room matched — every debate may use the same venue (Tabbycat may reject duplicates in one round).`
      );
    }
  }

  return warnings;
}
