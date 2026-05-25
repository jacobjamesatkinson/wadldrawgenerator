/**
 * Timeslot parsing for WADL evening rounds (5.15 / 6.15 / 7.15 pm local).
 */

/**
 * Parse a CSV timeslot cell like "5.15", "5:15", "5.15pm", "17:15" into 24h {h, m}.
 * WADL rounds run 5.15pm / 6.15pm / 7.15pm, so hours 1–9 with no am/pm marker default to PM.
 * @param {string|number|null|undefined} ts
 * @returns {{ h: number, m: number } | null}
 */
export function parseTimeslotToHM(ts) {
  const s = String(ts ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?:[.:](\d{1,2}))?(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = m[2] != null ? parseInt(m[2], 10) : 0;
  const suf = m[3] || "";
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (suf === "pm" && h < 12) h += 12;
  else if (suf === "am" && h === 12) h = 0;
  else if (!suf && h >= 1 && h <= 9) h += 12;
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

/**
 * ISO datetime (UTC Z) for venue date + debate timeslot, or null if either is missing/invalid.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string|number|null|undefined} ts
 */
export function buildScheduledAt(dateStr, ts) {
  if (!dateStr) return null;
  const hm = parseTimeslotToHM(ts);
  if (!hm) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(hm.h, hm.m, 0, 0);
  return d.toISOString();
}

/** Standard WADL debate timeslots (label, display). */
export const STANDARD_TIMESLOTS = ["5.15", "6.15", "7.15"];

/**
 * Map Tabbycat scheduled_at (ISO) to a WADL-style timeslot label.
 * Uses local wall clock; matches 17:15 → 5.15, etc.
 * @param {string|null|undefined} iso
 * @returns {string|null}
 */
export function timeslotLabelFromScheduledAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const h = d.getHours();
  const mi = d.getMinutes();
  const tol = 8;
  const near = (th, tm) => h === th && Math.abs(mi - tm) <= tol;
  if (near(17, 15)) return "5.15";
  if (near(18, 15)) return "6.15";
  if (near(19, 15)) return "7.15";
  if (h >= 12) {
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}.${String(mi).padStart(2, "0")}`;
  }
  return `${h}.${String(mi).padStart(2, "0")}`;
}
