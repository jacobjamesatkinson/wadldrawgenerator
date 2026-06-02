/**
 * Prep room assignment: prep starts 1h before each debate timeslot.
 * - 5.15 AFF may prep in their debate room.
 * - 5.15 NEG and all 6.15 / 7.15 teams need separate prep rooms.
 * - During prep for slot T, rooms hosting debates at the previous slot are unavailable.
 */

import { STANDARD_TIMESLOTS } from "./timeslot.js";
import { requiredRoomRowCount } from "./scheduleData.js";
import { prepAssignmentKey } from "./topicSlipData.js";

/**
 * Rooms hosting debates in the timeslot immediately before prep for `debateSlot`.
 * @param {Map<string, Map<string, object|null>>} matrix
 * @param {string[]} roomOrder
 * @param {string} debateSlot
 */
export function debateRoomsBlockedForPrep(matrix, roomOrder, debateSlot) {
  const idx = STANDARD_TIMESLOTS.indexOf(debateSlot);
  const blocked = new Set();
  if (idx <= 0) return blocked;
  const prevSlot = STANDARD_TIMESLOTS[idx - 1];
  for (const room of roomOrder) {
    const cell = matrix.get(room)?.get(prevSlot);
    if (cell && !cell._collision && (cell.aff || cell.neg)) blocked.add(room);
  }
  return blocked;
}

/**
 * @param {Map<string, Map<string, object|null>>} matrix
 * @param {string[]} roomOrder
 * @param {Record<string, string>} [overrides]
 * @returns {{ assignments: Record<string, string>, unassigned: string[], warnings: string[] }}
 */
export function assignPrepRooms(matrix, roomOrder, overrides = {}) {
  /** @type {Record<string, string>} */
  const assignments = {};
  /** @type {string[]} */
  const unassigned = [];
  /** @type {string[]} */
  const warnings = [];

  for (let slotIdx = 0; slotIdx < STANDARD_TIMESLOTS.length; slotIdx++) {
    const slot = STANDARD_TIMESLOTS[slotIdx];
    const blockedDebate = debateRoomsBlockedForPrep(matrix, roomOrder, slot);
    // Each prep room can host only one team during this prep window (availability).
    const usedPrep = new Set();
    let slotUnassigned = 0;

    // Gather every team needing a prep room in this slot, in draw order.
    /** @type {{ side: 'AFF'|'NEG', team: string, key: string, debateRoom: string }[]} */
    const entries = [];
    for (const room of roomOrder) {
      const cell = matrix.get(room)?.get(slot);
      if (!cell || cell._collision || (!cell.aff && !cell.neg)) continue;
      for (const { side, team } of [
        { side: "AFF", team: String(cell.aff ?? "").trim() },
        { side: "NEG", team: String(cell.neg ?? "").trim() },
      ]) {
        if (!team || team === "—") continue;
        entries.push({ side, team, key: prepAssignmentKey(slot, team, side), debateRoom: room });
      }
    }

    // Pass 1 — reserve fixed rooms first so they can't be taken by auto-assignment:
    //   (a) manual overrides, (b) 5.15 Aff prepping in its own debate room.
    /** @type {{ side: 'AFF'|'NEG', team: string, key: string, debateRoom: string }[]} */
    const needAuto = [];
    for (const e of entries) {
      const override = overrides[e.key];
      if (override !== undefined && String(override).trim()) {
        const v = String(override).trim();
        assignments[e.key] = v;
        usedPrep.add(v);
      } else if (slotIdx === 0 && e.side === "AFF") {
        assignments[e.key] = e.debateRoom;
        usedPrep.add(e.debateRoom);
      } else {
        needAuto.push(e);
      }
    }

    // Pass 2 — assign remaining teams from rooms that are free this window.
    for (const e of needAuto) {
      let picked = "";
      for (const candidate of roomOrder) {
        if (blockedDebate.has(candidate)) continue;
        if (usedPrep.has(candidate)) continue;
        // Only 5.15 Aff may prep in the debate room; all other teams need a different room.
        if (candidate === e.debateRoom) continue;
        picked = candidate;
        break;
      }

      if (picked) {
        assignments[e.key] = picked;
        usedPrep.add(picked);
      } else {
        assignments[e.key] = "";
        slotUnassigned++;
        unassigned.push(`${e.team} (${e.side}, ${slot})`);
      }
    }

    if (slotUnassigned) {
      const prev = slotIdx > 0 ? STANDARD_TIMESLOTS[slotIdx - 1] : null;
      warnings.push(
        `${slot}: ${slotUnassigned} prep room(s) unassigned.${prev ? ` ${prev} debate rooms are blocked during this prep window.` : ""}`
      );
    }
  }

  return { assignments, unassigned, warnings };
}

function debatesInSlot(matrix, roomOrder, filteredDebates, slot) {
  if (matrix && roomOrder.length) {
    let n = 0;
    for (const room of roomOrder) {
      const cell = matrix.get(room)?.get(slot);
      if (cell && !cell._collision && (cell.aff || cell.neg)) n++;
    }
    return n;
  }
  return (filteredDebates || []).filter((d) => d.timeslot === slot).length;
}

/**
 * Minimum rooms suggested for debate rows + prep windows.
 * @param {object[]} filteredDebates
 * @param {Map<string, Map<string, object|null>>|null} matrix
 * @param {string[]} roomOrder
 */
export function suggestedRoomPoolSize(filteredDebates, matrix, roomOrder) {
  const debateRows = requiredRoomRowCount(filteredDebates);
  let maxNeeded = debateRows;

  for (let slotIdx = 0; slotIdx < STANDARD_TIMESLOTS.length; slotIdx++) {
    const slot = STANDARD_TIMESLOTS[slotIdx];
    const n = debatesInSlot(matrix, roomOrder, filteredDebates, slot);
    // Every team (Aff + Neg) needs its own room in the prep window. At 5.15 the Aff
    // rooms are the debate rooms, but they are still distinct rooms occupied at once.
    const prepTeams = n * 2;
    const blocked =
      slotIdx > 0 ? debatesInSlot(matrix, roomOrder, filteredDebates, STANDARD_TIMESLOTS[slotIdx - 1]) : 0;
    maxNeeded = Math.max(maxNeeded, prepTeams + blocked);
  }

  return maxNeeded;
}
