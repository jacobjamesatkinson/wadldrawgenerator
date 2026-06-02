/**
 * Multi-tournament draw data, venue filtering, layout auto-selection.
 */

import { venuePrefixFromRoomName, compareRoomNames } from "./venuePrefix.js";
import { STANDARD_TIMESLOTS, timeslotLabelFromScheduledAt } from "./timeslot.js";
import { isByeLikeTeamName, isRetractedOrWithdrawnTeam, parseCsv, sanitizeCsvCell } from "./merge.js";

export const DIVISION_SLUGS = [
  { slug: "sdcnov26", label: "Novice" },
  { slug: "sdcjnr26", label: "Junior" },
  { slug: "sdcsnr26", label: "Senior" },
];

const DIVISION_ORDER = { Novice: 0, Junior: 1, Senior: 2 };

/**
 * @param {string} side
 */
function sideNorm(side) {
  const s = String(side ?? "").toLowerCase();
  if (s === "aff" || s === "affirmative") return "aff";
  if (s === "neg" || s === "negative") return "neg";
  return s;
}

/**
 * @param {object[]} teams
 * @returns {Map<string, object>}
 */
export function teamMapByUrl(teams) {
  const m = new Map();
  for (const t of teams || []) {
    const u = t?.url || t?._links?.url;
    if (u) m.set(String(u), t);
  }
  return m;
}

/**
 * @param {object[]} venues
 * @returns {Map<string, object>}
 */
export function venueMapByUrl(venues) {
  const m = new Map();
  for (const v of venues || []) {
    const u = v?.url || v?._links?.url;
    if (u) m.set(String(u), v);
  }
  return m;
}

/**
 * @param {object[]} adjudicators
 * @returns {Map<string, object>}
 */
export function adjudicatorMapByUrl(adjudicators) {
  const m = new Map();
  for (const a of adjudicators || []) {
    const u = a?.url || a?._links?.url;
    if (u) m.set(String(u), a);
  }
  return m;
}

function teamLabel(t) {
  if (!t) return "";
  const s = String(t.short_name ?? "").trim();
  if (s) return s;
  return String(t.long_name ?? t.name ?? "").trim() || "";
}

/** Team display name contains bye / withdrawn / retracted (case-insensitive). */
function labelHasScheduleExcludeWord(label) {
  const s = String(label || "").toLowerCase();
  if (!s) return false;
  if (/\bbye\b/.test(s) || s.includes("withdrawn") || s.includes("retracted")) return true;
  return isByeLikeTeamName(label);
}

function isPostponedPairing(pairing) {
  const st = String(pairing?.result_status ?? "").trim().toUpperCase();
  return st === "P" || st === "POSTPONED";
}

/**
 * @param {object} pairing
 * @param {object|null} affTeam
 * @param {object|null} negTeam
 */
export function shouldExcludePairing(pairing, affTeam, negTeam) {
  if (isPostponedPairing(pairing)) return true;
  for (const row of pairing?.teams || []) {
    if (sideNorm(row.side) === "bye") return true;
  }
  if (isRetractedOrWithdrawnTeam(affTeam) || isRetractedOrWithdrawnTeam(negTeam)) return true;
  if (isByeLikeTeamName(affTeam?.short_name) || isByeLikeTeamName(negTeam?.short_name)) return true;
  if (isByeLikeTeamName(affTeam?.long_name) || isByeLikeTeamName(negTeam?.long_name)) return true;
  const affL = teamLabel(affTeam);
  const negL = teamLabel(negTeam);
  if (labelHasScheduleExcludeWord(affL) || labelHasScheduleExcludeWord(negL)) return true;
  return false;
}

/**
 * @param {object} pairing - Tabbycat round pairing
 * @param {{ teamByUrl: Map<string, object>, venueByUrl: Map<string, object>, adjByUrl: Map<string, object>, division: string, slug: string }} ctx
 * @returns {object|null}
 */
export function normalizePairing(pairing, ctx) {
  const teams = pairing?.teams || [];
  let aff = null;
  let neg = null;
  for (const row of teams) {
    const side = sideNorm(row.side);
    const t = ctx.teamByUrl.get(String(row.team || ""));
    if (side === "aff") aff = t;
    else if (side === "neg") neg = t;
  }
  if (!aff || !neg) return null;
  if (shouldExcludePairing(pairing, aff, neg)) return null;

  const venueUrl = pairing.venue;
  const v = venueUrl ? ctx.venueByUrl.get(String(venueUrl)) : null;
  const roomName = String(v?.name ?? "").trim();
  if (!roomName) return null;

  const chairUrl = pairing.adjudicators?.chair;
  let adjName = "";
  if (chairUrl) {
    const adj = ctx.adjByUrl.get(String(chairUrl));
    adjName = String(adj?.name ?? "").trim();
  }

  const ts = timeslotLabelFromScheduledAt(pairing.scheduled_at);

  return {
    division: ctx.division,
    slug: ctx.slug,
    timeslot: ts,
    /** Tabbycat room prefix only — used to pick venue, not for row labels or placement */
    venuePrefix: venuePrefixFromRoomName(roomName),
    aff: teamLabel(aff),
    neg: teamLabel(neg),
    adjFromApi: adjName,
    scheduled_at: pairing.scheduled_at || null,
  };
}

/**
 * @param {object[][]} pairingLists - same order as DIVISION_SLUGS
 * @param {{ teams: object[][], venues: object[][], adjudicators: object[][] }} resources - per division, same order
 */
export function normalizeAllPairings(pairingLists, resources) {
  const out = [];
  let excludedCount = 0;
  let rawCount = 0;
  for (let i = 0; i < DIVISION_SLUGS.length; i++) {
    const { slug, label } = DIVISION_SLUGS[i];
    const teamByUrl = teamMapByUrl(resources.teams[i]);
    const venueByUrl = venueMapByUrl(resources.venues[i]);
    const adjByUrl = adjudicatorMapByUrl(resources.adjudicators[i]);
    const ctx = { teamByUrl, venueByUrl, adjByUrl, division: label, slug };
    for (const p of pairingLists[i] || []) {
      rawCount++;
      const teams = p?.teams || [];
      let aff = null;
      let neg = null;
      for (const row of teams) {
        const side = sideNorm(row.side);
        const t = teamByUrl.get(String(row.team || ""));
        if (side === "aff") aff = t;
        else if (side === "neg") neg = t;
      }
      if (aff && neg && shouldExcludePairing(p, aff, neg)) {
        excludedCount++;
        continue;
      }
      const n = normalizePairing(p, ctx);
      if (n) out.push(n);
    }
  }
  return { debates: out, excludedCount, rawCount };
}

/**
 * @param {object[]} debates
 * @param {string} prefix
 */
export function filterDebatesByVenuePrefix(debates, prefix) {
  const pre = String(prefix || "").trim();
  if (!pre) return [];
  return (debates || []).filter((d) => {
    const vp = String(d.venuePrefix ?? "").trim();
    return vp === pre || vp.startsWith(pre) || pre.startsWith(vp);
  });
}

/**
 * @param {object[]} debates
 */
export function uniquePrefixesFromDebates(debates) {
  const set = new Set();
  for (const d of debates || []) {
    const p = String(d.venuePrefix ?? "").trim();
    if (p) set.add(p);
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

/** Sort debates for slot placement (division, then teams) — not by Tabbycat room. */
export function sortDebatesForSlotPlacement(debates) {
  return [...(debates || [])].sort((a, b) => {
    const da = DIVISION_ORDER[a.division] ?? 99;
    const db = DIVISION_ORDER[b.division] ?? 99;
    if (da !== db) return da - db;
    const aff = String(a.aff ?? "").localeCompare(String(b.aff ?? ""), undefined, { sensitivity: "base", numeric: true });
    if (aff !== 0) return aff;
    return String(a.neg ?? "").localeCompare(String(b.neg ?? ""), undefined, { sensitivity: "base", numeric: true });
  });
}

/**
 * @param {object[]} debates
 */
export function sortPreviewDebates(debates) {
  return [...(debates || [])].sort((a, b) => {
    const da = DIVISION_ORDER[a.division] ?? 99;
    const db = DIVISION_ORDER[b.division] ?? 99;
    if (da !== db) return da - db;
    const ta = STANDARD_TIMESLOTS.indexOf(a.timeslot ?? "");
    const tb = STANDARD_TIMESLOTS.indexOf(b.timeslot ?? "");
    if (ta >= 0 && tb >= 0 && ta !== tb) return ta - tb;
    if (ta >= 0 && tb < 0) return -1;
    if (ta < 0 && tb >= 0) return 1;
    const tsCmp = String(a.timeslot ?? "").localeCompare(String(b.timeslot ?? ""), undefined, { numeric: true });
    if (tsCmp !== 0) return tsCmp;
    const aff = String(a.aff ?? "").localeCompare(String(b.aff ?? ""), undefined, { sensitivity: "base", numeric: true });
    if (aff !== 0) return aff;
    return String(a.neg ?? "").localeCompare(String(b.neg ?? ""), undefined, { sensitivity: "base", numeric: true });
  });
}

/**
 * Union of round seq from multiple tournaments' round lists.
 * @param {object[][]} roundsPerSlug
 */
export function unionRoundSeqs(roundsPerSlug) {
  const set = new Set();
  for (const rounds of roundsPerSlug || []) {
    for (const r of rounds || []) {
      const seq = Number(r.seq);
      if (Number.isFinite(seq) && seq > 0) set.add(seq);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Stable identity for a normalized debate (used for manual placement overrides).
 * @param {object|null|undefined} d
 * @returns {string}
 */
export function debateKey(d) {
  if (!d) return "";
  return [
    d.slug ?? "",
    d.division ?? "",
    d.aff ?? "",
    d.neg ?? "",
    d.scheduled_at ?? d.timeslot ?? "",
  ].join("|");
}

function cellFromDebate(d) {
  return {
    aff: d.aff,
    neg: d.neg,
    division: d.division,
    adjFromApi: d.adjFromApi || "",
    prepBySlot: {},
    debate: d,
  };
}

function mergeCellWithDebate(cur, d) {
  const next = cellFromDebate(d);
  if (!cur) return next;
  next._collision = true;
  next.aff = `${cur.aff || ""} / ${d.aff || ""}`.replace(/^ \/ | \/ $/g, "").trim();
  next.neg = `${cur.neg || ""} / ${d.neg || ""}`.replace(/^ \/ | \/ $/g, "").trim();
  return next;
}

/**
 * Build cell map: user room row → timeslot → debate.
 * Tabbycat room codes are not used; debates fill rows in order per timeslot (division, then team names).
 * Manual placements (from drag-and-drop swap) are honored first, then remaining debates auto-fill.
 * @param {object[]} debates - filtered to venue
 * @param {string[]} roomOrder - staff-defined room labels only
 * @param {{ manualPlacements?: Map<string, { room: string, slot: string }> }} [opts]
 * @returns {{ matrix: Map<string, Map<string, object|null>>, overflow: string[] }}
 */
export function buildCellMatrix(debates, roomOrder, opts = {}) {
  const manualPlacements =
    opts.manualPlacements instanceof Map ? opts.manualPlacements : new Map();
  const validRooms = new Set(roomOrder);
  const validSlots = new Set(STANDARD_TIMESLOTS);

  /** @type {Map<string, Map<string, object|null>>} */
  const map = new Map();
  for (const r of roomOrder) {
    const inner = new Map();
    for (const t of STANDARD_TIMESLOTS) inner.set(t, null);
    map.set(r, inner);
  }
  const overflow = [];
  const list = debates || [];

  /** Debate keys with a valid (room, slot) override actually applied. */
  const placedKeys = new Set();
  for (const d of list) {
    const k = debateKey(d);
    const p = manualPlacements.get(k);
    if (!p) continue;
    if (!validRooms.has(p.room) || !validSlots.has(p.slot)) continue;
    const cur = map.get(p.room).get(p.slot);
    map.get(p.room).set(p.slot, mergeCellWithDebate(cur, d));
    placedKeys.add(k);
  }

  for (const slot of STANDARD_TIMESLOTS) {
    const auto = sortDebatesForSlotPlacement(
      list.filter((d) => d.timeslot === slot && !placedKeys.has(debateKey(d)))
    );
    const freeRooms = roomOrder.filter((r) => map.get(r).get(slot) === null);
    if (auto.length > freeRooms.length) {
      overflow.push(
        `${slot}: ${auto.length} unplaced debate(s) but only ${freeRooms.length} free room row(s) — last ${auto.length - freeRooms.length} omitted.`
      );
    }
    auto.forEach((d, i) => {
      if (i >= freeRooms.length) return;
      const room = freeRooms[i];
      map.get(room).set(slot, cellFromDebate(d));
    });
  }
  return { matrix: map, overflow };
}

/**
 * Parse bulk room lines and ranges like H2.15-H2.35
 * @param {string} text
 * @returns {string[]}
 */
/**
 * @param {string} text
 * @returns {string[]}
 */
function parseBulkRoomTokens(text) {
  return String(text || "")
    .split(/[\r\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Parse bulk room lines and ranges like H2.15-H2.35
 * @param {string} text
 * @returns {string[]}
 */
export function parseBulkRooms(text) {
  const tokens = parseBulkRoomTokens(text);
  const out = [];
  for (const line of tokens) {
    const rangeM = line.match(/^(.+?)(\d+)\s*[-–]\s*\1(\d+)$/);
    if (rangeM) {
      const pre = rangeM[1];
      const n1 = parseInt(rangeM[2], 10);
      const n2 = parseInt(rangeM[3], 10);
      if (Number.isFinite(n1) && Number.isFinite(n2)) {
        const lo = Math.min(n1, n2);
        const hi = Math.max(n1, n2);
        const width = Math.max(rangeM[2].length, rangeM[3].length);
        for (let n = lo; n <= hi; n++) out.push(`${pre}${String(n).padStart(width, "0")}`);
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * @param {string[]} incoming
 * @param {string[]} current
 * @returns {{ merged: string[], added: number, skipped: number }}
 */
export function mergeRoomListWithStats(incoming, current) {
  const seen = new Set(current);
  const merged = [...current];
  let added = 0;
  let skipped = 0;
  for (const r of incoming) {
    const s = String(r || "").trim();
    if (!s) continue;
    if (seen.has(s)) {
      skipped++;
      continue;
    }
    seen.add(s);
    merged.push(s);
    added++;
  }
  return { merged, added, skipped };
}

/**
 * Room rows needed = debates in the busiest standard timeslot (5.15 / 6.15 / 7.15).
 * @param {object[]} debates - venue-filtered debates with timeslot labels
 * @returns {number}
 */
export function requiredRoomRowCount(debates) {
  let max = 0;
  for (const slot of STANDARD_TIMESLOTS) {
    const n = (debates || []).filter((d) => d.timeslot === slot).length;
    if (n > max) max = n;
  }
  return max;
}

/**
 * Autofill sequential rooms: start "H2.15", count 21 → H2.15 … H2.35
 * @param {string} startRoom
 * @param {number} count
 */
export function autofillRoomSeries(startRoom, count) {
  const s = String(startRoom || "").trim();
  const m = s.match(/^(.+?)(\d+)$/);
  if (!m) return [s];
  const pre = m[1];
  const n0 = parseInt(m[2], 10);
  const width = m[2].length;
  if (!Number.isFinite(n0) || !Number.isFinite(count) || count < 1) return [s];
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = n0 + i;
    out.push(`${pre}${String(n).padStart(width, "0")}`);
  }
  return out;
}

function normHeaderCell(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function findCsvColumn(headers, names) {
  for (let i = 0; i < headers.length; i++) {
    const h = normHeaderCell(headers[i]);
    if (names.some((n) => h === n || h.includes(n))) return i;
  }
  return -1;
}

/**
 * Apply room → adjudicator pairs from CSV (headers room/adjudicator or two columns).
 * @param {string} text
 * @param {string[]} roomOrder
 * @param {Record<string, string>} adjByRoom - mutated
 */
export function applyBulkAdjudicatorsCsv(text, roomOrder, adjByRoom) {
  const rows = parseCsv(text);
  if (!rows.length) return { applied: 0, unmatched: [], skipped: 0 };

  let roomCol = 0;
  let adjCol = 1;
  let startRow = 0;

  const hdr = rows[0].map((c) => normHeaderCell(c));
  const rIdx = findCsvColumn(hdr, ["room", "rooms", "room_code"]);
  const aIdx = findCsvColumn(hdr, ["adjudicator", "adj", "judge", "adjudicators"]);
  if (rIdx >= 0 && aIdx >= 0) {
    roomCol = rIdx;
    adjCol = aIdx;
    startRow = 1;
  } else if (rows[0].length < 2) {
    return { applied: 0, unmatched: [], skipped: 0 };
  }

  const roomLookup = new Map();
  for (const r of roomOrder) {
    roomLookup.set(String(r).trim().toLowerCase(), r);
  }

  let applied = 0;
  let skipped = 0;
  const unmatched = [];

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const roomRaw = sanitizeCsvCell(row[roomCol] ?? "");
    const adj = sanitizeCsvCell(row[adjCol] ?? "");
    if (!roomRaw) {
      skipped++;
      continue;
    }
    const key = roomLookup.get(roomRaw.toLowerCase());
    if (!key) {
      unmatched.push(roomRaw);
      continue;
    }
    adjByRoom[key] = adj;
    applied++;
  }

  return { applied, unmatched, skipped };
}
