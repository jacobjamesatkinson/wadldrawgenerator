/**
 * Build topic slip records from room×timeslot matrix (all three divisions).
 */

import { STANDARD_TIMESLOTS } from "./timeslot.js";
import { DIVISION_SLUGS } from "./scheduleData.js";

const DIVISION_ORDER = { Novice: 0, Junior: 1, Senior: 2 };

/** @param {string} team */
export function teamPrepKey(team) {
  return String(team ?? "")
    .trim()
    .toLowerCase();
}

/** @param {string} timeslot @param {string} team @param {'AFF'|'NEG'} side */
export function prepAssignmentKey(timeslot, team, side) {
  return `${timeslot}|${teamPrepKey(team)}|${side}`;
}

/**
 * @typedef {{ team: string, side: 'AFF'|'NEG', division: string, timeslot: string, debateRoom: string, prepRoom: string, topic: string, infoSlide: string }} TopicSlip
 */

/**
 * @param {Map<string, Map<string, object|null>>} matrix
 * @param {string[]} roomOrder
 * @param {{ topic: string, infoSlide: string }[]} divisionContent - index matches DIVISION_SLUGS order
 * @param {Record<string, string>} prepAssignments - keyed by prepAssignmentKey(timeslot, team, side)
 * @returns {TopicSlip[]}
 */
export function buildTopicSlips(matrix, roomOrder, divisionContent, prepAssignments = {}) {
  /** @type {TopicSlip[]} */
  const slips = [];

  for (const slot of STANDARD_TIMESLOTS) {
    for (const room of roomOrder) {
      const cell = matrix.get(room)?.get(slot);
      if (!cell || cell._collision || (!cell.aff && !cell.neg)) continue;
      const division = cell.division || "";
      const divIdx = DIVISION_SLUGS.findIndex((d) => d.label === division);
      const content = divisionContent[divIdx >= 0 ? divIdx : 0] || { topic: "", infoSlide: "" };

      const base = {
        division,
        timeslot: slot,
        debateRoom: room,
        topic: String(content.topic ?? "").trim(),
        infoSlide: String(content.infoSlide ?? "").trim(),
      };

      const affTeam = String(cell.aff ?? "").trim() || "—";
      const negTeam = String(cell.neg ?? "").trim() || "—";

      slips.push({
        ...base,
        team: affTeam,
        side: "AFF",
        prepRoom: String(prepAssignments[prepAssignmentKey(slot, affTeam, "AFF")] ?? "").trim(),
      });
      slips.push({
        ...base,
        team: negTeam,
        side: "NEG",
        prepRoom: String(prepAssignments[prepAssignmentKey(slot, negTeam, "NEG")] ?? "").trim(),
      });
    }
  }

  slips.sort((a, b) => {
    const ta = STANDARD_TIMESLOTS.indexOf(a.timeslot);
    const tb = STANDARD_TIMESLOTS.indexOf(b.timeslot);
    if (ta !== tb) return ta - tb;
    const ra = roomOrder.indexOf(a.debateRoom);
    const rb = roomOrder.indexOf(b.debateRoom);
    if (ra !== rb) return ra - rb;
    const da = DIVISION_ORDER[a.division] ?? 99;
    const db = DIVISION_ORDER[b.division] ?? 99;
    if (da !== db) return da - db;
    if (a.side !== b.side) return a.side === "AFF" ? -1 : 1;
    return a.team.localeCompare(b.team, undefined, { sensitivity: "base", numeric: true });
  });

  return slips;
}

/**
 * Unique team names appearing in the current matrix (all divisions).
 * @param {Map<string, Map<string, object|null>>} matrix
 * @param {string[]} roomOrder
 * @returns {string[]}
 */
export function uniqueTeamsInMatrix(matrix, roomOrder) {
  const set = new Set();
  for (const room of roomOrder) {
    for (const slot of STANDARD_TIMESLOTS) {
      const cell = matrix.get(room)?.get(slot);
      if (!cell || cell._collision) continue;
      const aff = String(cell.aff ?? "").trim();
      const neg = String(cell.neg ?? "").trim();
      if (aff) set.add(aff);
      if (neg) set.add(neg);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

/**
 * Teams in draw order: timeslot → room row → AFF then NEG (first appearance only).
 * @param {Map<string, Map<string, object|null>>} matrix
 * @param {string[]} roomOrder
 * @returns {string[]}
 */
export function teamsInMatrixOrder(matrix, roomOrder) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const slot of STANDARD_TIMESLOTS) {
    for (const room of roomOrder) {
      const cell = matrix.get(room)?.get(slot);
      if (!cell || cell._collision) continue;
      for (const name of [cell.aff, cell.neg]) {
        const t = String(name ?? "").trim();
        if (!t || t === "—") continue;
        const k = teamPrepKey(t);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(t);
      }
    }
  }
  return out;
}

/**
 * Group slips into pages (AFF + NEG per debate).
 * @param {TopicSlip[]} slips
 * @returns {{ aff: TopicSlip, neg: TopicSlip|null }[]}
 */
export function slipsToPages(slips) {
  /** @type {{ aff: TopicSlip, neg: TopicSlip|null }[]} */
  const pages = [];
  for (let i = 0; i < slips.length; i++) {
    const s = slips[i];
    if (s.side === "AFF") {
      const next = slips[i + 1];
      const neg =
        next &&
        next.side === "NEG" &&
        next.debateRoom === s.debateRoom &&
        next.timeslot === s.timeslot
          ? next
          : null;
      pages.push({ aff: s, neg });
      if (neg) i++;
    } else {
      pages.push({ aff: s, neg: null });
    }
  }
  return pages;
}

/**
 * @param {TopicSlip[]} slips
 */
export function slipSummary(slips) {
  const pages = slipsToPages(slips);
  const byDiv = {};
  for (const p of pages) {
    const d = p.aff.division;
    byDiv[d] = (byDiv[d] || 0) + 1;
  }
  return { debateCount: pages.length, slipCount: slips.length, byDivision: byDiv };
}
