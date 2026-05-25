/**
 * WADL venue debate dates by "round to post" (1–5). CSV `venueKey` uses the same
 * normalization as merge scheduling: trim, lower case, internal spaces collapsed.
 * DD/MM is calendar-day in the season year below (Perth / WA draw dates).
 */

const SCHEDULE_YEAR = 2026;

function normVenueKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseDdMmToYmd(ddmm, year) {
  const m = String(ddmm || "").trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (!Number.isFinite(day) || !Number.isFinite(month) || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime()) || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** Rounds 1–5 → DD/MM for that site (same order as published WADL staff draw calendar). */
const WADL_VENUE_SITES = [
  {
    roundsDdMm: ["10/03", "24/03", "28/04", "19/05", "02/06"],
    aliases: ["ccgs (christchurch)", "ccgs", "christchurch"],
  },
  {
    roundsDdMm: ["10/03", "24/03", "28/04", "19/05", "02/06"],
    aliases: ["pc (perth college)", "perth college", "pc"],
  },
  {
    roundsDdMm: ["11/03", "25/03", "29/04", "20/05", "03/06"],
    aliases: ["hale"],
  },
  {
    roundsDdMm: ["11/03", "25/03", "29/04", "20/05", "03/06"],
    aliases: ["leeming"],
  },
  {
    roundsDdMm: ["12/03", "26/03", "30/04", "21/05", "04/06"],
    aliases: ["mt lawley", "mount lawley"],
  },
  {
    roundsDdMm: ["17/03", "31/03", "05/05", "26/05", "09/06"],
    aliases: ["shenton"],
  },
  {
    roundsDdMm: ["17/03", "31/03", "05/05", "26/05", "09/06"],
    aliases: ["duncraig"],
  },
  {
    roundsDdMm: ["18/03", "01/04", "06/05", "27/05", "10/06"],
    aliases: ["pmod (perth modern)", "pmod", "perth modern"],
  },
];

/**
 * @param {number} roundToPost - "Round to post" (1–5)
 * @param {string} venueKey - normalized venue key from debates / CSV
 * @returns {string|null} `YYYY-MM-DD` for date inputs, or null if unknown
 */
export function wadlScheduledDateYmd(roundToPost, venueKey) {
  const k = normVenueKey(venueKey);
  if (!k || roundToPost < 1 || roundToPost > 5) return null;
  const idx = roundToPost - 1;
  for (const row of WADL_VENUE_SITES) {
    if (!row.aliases.includes(k)) continue;
    const ddmm = row.roundsDdMm[idx];
    return parseDdMmToYmd(ddmm, SCHEDULE_YEAR);
  }
  return null;
}

/**
 * Map Tabbycat room-name prefix (from {@link venuePrefixFromRoomName}) to a WADL site key
 * used by {@link wadlScheduledDateYmd}. Extend as new site codes appear.
 * @param {string} prefix
 * @returns {string|null}
 */
export function scheduleVenueKeyFromRoomPrefix(prefix) {
  const p = String(prefix || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!p) return null;
  if (p.startsWith("h2.")) return "shenton";
  if (p.startsWith("bl") || p.startsWith("bu")) return "pmod";
  if (p.startsWith("hale") || p === "h") return "hale";
  if (p.startsWith("ccgs") || p.startsWith("christchurch")) return "christchurch";
  if (p.startsWith("pc ") || p === "pc") return "perth college";
  if (p.startsWith("leeming")) return "leeming";
  if (p.startsWith("mt lawley") || p.startsWith("ml")) return "mt lawley";
  if (p.startsWith("duncraig")) return "duncraig";
  return null;
}

/**
 * Default spreadsheet header title from room prefix when user has not overridden.
 * @param {string} prefix
 */
export function defaultVenueTitleFromRoomPrefix(prefix) {
  const k = scheduleVenueKeyFromRoomPrefix(prefix);
  if (k === "shenton") return "Shenton College";
  if (k === "pmod") return "Perth Modern";
  if (k === "hale") return "Hale School";
  if (k === "christchurch") return "Christ Church Grammar School";
  if (k === "perth college") return "Perth College";
  if (k === "leeming") return "Leeming Senior High School";
  if (k === "mt lawley") return "Mount Lawley Senior High School";
  if (k === "duncraig") return "Duncraig Senior High School";
  const raw = String(prefix || "").trim();
  return raw || "Venue";
}
