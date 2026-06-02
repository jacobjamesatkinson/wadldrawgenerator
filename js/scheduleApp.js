/**
 * Staff draw sheet UI: Tabbycat → preview → Excel/CSV export.
 */

import {
  listRounds,
  listTeams,
  listVenues,
  listAdjudicators,
  listPairingsForRound,
} from "./tabbycat.js";
import {
  DIVISION_SLUGS,
  normalizeAllPairings,
  filterDebatesByVenuePrefix,
  uniquePrefixesFromDebates,
  unionRoundSeqs,
  buildCellMatrix,
  parseBulkRooms,
  autofillRoomSeries,
  requiredRoomRowCount,
  mergeRoomListWithStats,
  applyBulkAdjudicatorsCsv,
  debateKey,
} from "./scheduleData.js";
import { compareRoomNames } from "./venuePrefix.js";
import {
  wadlScheduledDateYmd,
  scheduleVenueKeyFromRoomPrefix,
  defaultVenueTitleFromRoomPrefix,
} from "./wadlVenueSchedule.js";
import { STANDARD_TIMESLOTS } from "./timeslot.js";
import {
  buildScheduleWorkbook,
  downloadWorkbook,
  debatesToScheduleCsv,
  downloadTextFile,
  shareScheduleFile,
  workbookToXlsxFile,
} from "./scheduleExport.js";

const PROD = "https://draw.wadl.org";
const STAGING = "https://wadlsdc26-staging-2f6d981ee2d9.herokuapp.com";
const STORAGE_KEY = "wadlScheduleSheet:v1";

const el = (id) => document.getElementById(id);

/** @type {{ teams: object[][], venues: object[][], adjudicators: object[][], rounds: object[][] } | null} */
let cachedMeta = null;
/** @type {object[]} */
let allDebates = [];
/** @type {object[]} */
let filteredDebates = [];
/** @type {string[]} */
let roomOrder = [];
/** @type {Record<string, string>} */
let adjByRoom = {};
/** @type {Record<string, Record<string, string>>} */
let adjByRoomSlot = {};
/** @type {Map<string, { room: string, slot: string }>} debate key → preview cell override */
let manualPlacements = new Map();
/** Drag source info for the active drag, if any. */
let dragSource = null;

function isInconsistentAdj() {
  return !!el("inconsistentAdj")?.checked;
}

function ensureAdjSlots(room) {
  if (!adjByRoomSlot[room]) adjByRoomSlot[room] = {};
  for (const t of STANDARD_TIMESLOTS) {
    if (adjByRoomSlot[room][t] === undefined) adjByRoomSlot[room][t] = "";
  }
}

function syncSlotAdjsFromRow(room) {
  const base = String(adjByRoom[room] ?? "");
  ensureAdjSlots(room);
  for (const t of STANDARD_TIMESLOTS) {
    if (!String(adjByRoomSlot[room][t] ?? "").trim()) adjByRoomSlot[room][t] = base;
  }
}

function copyRowAdjToAllSlots(room) {
  ensureAdjSlots(room);
  const base = String(adjByRoom[room] ?? "");
  for (const t of STANDARD_TIMESLOTS) adjByRoomSlot[room][t] = base;
}

function getBaseUrl() {
  const preset = document.querySelector('input[name="basePreset"]:checked')?.value;
  if (preset === "custom") {
    const u = el("baseManual").value.trim().replace(/\/+$/, "");
    return u || PROD;
  }
  if (preset === "staging") return STAGING;
  return PROD;
}

function getToken() {
  return el("token").value.trim();
}

function log(msg, err = false) {
  const p = el("log");
  if (!p) return;
  const line = document.createElement("div");
  line.className = err ? "log-err" : "log-ok";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  p.appendChild(line);
  p.scrollTop = p.scrollHeight;
}

function saveUiState() {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        venueTitle: el("venueTitle").value,
        ha: el("haField").value,
        adjRoom: el("adjRoomField").value,
        prepMonitors: el("prepMonitors").value,
        roomOrder,
        adjByRoom,
        adjByRoomSlot,
        inconsistentAdjAllocation: isInconsistentAdj(),
        venuePrefix: el("venuePrefixSelect").value,
        roundSeq: el("roundSelect").value,
        manualPlacements: [...manualPlacements.entries()],
      })
    );
  } catch {
    /* ignore */
  }
}

function loadUiState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o.venueTitle != null) el("venueTitle").value = o.venueTitle;
    if (o.ha != null) el("haField").value = o.ha;
    if (o.adjRoom != null) el("adjRoomField").value = o.adjRoom;
    if (o.prepMonitors != null) el("prepMonitors").value = o.prepMonitors;
    if (Array.isArray(o.roomOrder)) roomOrder = o.roomOrder;
    if (o.adjByRoom && typeof o.adjByRoom === "object") adjByRoom = o.adjByRoom;
    if (o.adjByRoomSlot && typeof o.adjByRoomSlot === "object") adjByRoomSlot = o.adjByRoomSlot;
    if (el("inconsistentAdj")) el("inconsistentAdj").checked = !!o.inconsistentAdjAllocation;
    if (Array.isArray(o.manualPlacements)) {
      manualPlacements = new Map(
        o.manualPlacements.filter(
          (e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && typeof e[1].room === "string" && typeof e[1].slot === "string"
        )
      );
    }
  } catch {
    /* ignore */
  }
}

function manualSwapCount() {
  return manualPlacements.size;
}

function updateManualSwapUi() {
  const btn = el("btnResetSwaps");
  if (!btn) return;
  const n = manualSwapCount();
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `Reset manual swaps (${n})` : "Reset manual swaps";
}

function resetManualPlacements({ silent = false } = {}) {
  if (!manualPlacements.size) {
    updateManualSwapUi();
    return;
  }
  manualPlacements = new Map();
  if (!silent) log("Cleared manual debate swaps.");
  saveUiState();
  refreshDerived({ prefillAdj: false });
}

function getRoundSeq() {
  const v = parseInt(el("roundSelect").value, 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function getVenuePrefix() {
  return el("venuePrefixSelect").value.trim();
}

function renameRoom(oldName, newName) {
  const old = String(oldName || "").trim();
  const neu = String(newName || "").trim();
  if (!old || !neu || old === neu) return;
  if (adjByRoom[old] !== undefined) {
    adjByRoom[neu] = adjByRoom[old];
    delete adjByRoom[old];
  }
  if (adjByRoomSlot[old] !== undefined) {
    adjByRoomSlot[neu] = adjByRoomSlot[old];
    delete adjByRoomSlot[old];
  }
  for (const [k, v] of manualPlacements) {
    if (v?.room === old) manualPlacements.set(k, { room: neu, slot: v.slot });
  }
}

function dropManualPlacementsForRoom(room) {
  let changed = false;
  for (const [k, v] of manualPlacements) {
    if (v?.room === room) {
      manualPlacements.delete(k);
      changed = true;
    }
  }
  return changed;
}

function buildMatrixBundle() {
  return buildCellMatrix(filteredDebates, roomOrder, { manualPlacements });
}

function mergeRoomList(incoming) {
  const { merged, added, skipped } = mergeRoomListWithStats(incoming, roomOrder);
  roomOrder = merged;
  return { added, skipped };
}

function prefillAdjudicators(matrix) {
  for (const room of roomOrder) {
    if (isInconsistentAdj()) {
      ensureAdjSlots(room);
      for (const t of STANDARD_TIMESLOTS) {
        if (String(adjByRoomSlot[room][t] ?? "").trim()) continue;
        const c = matrix.get(room)?.get(t);
        if (c?.adjFromApi) adjByRoomSlot[room][t] = c.adjFromApi;
      }
    } else {
      if (String(adjByRoom[room] ?? "").trim()) continue;
      const adjs = [];
      for (const t of STANDARD_TIMESLOTS) {
        const c = matrix.get(room)?.get(t);
        if (c && (c.aff || c.neg)) adjs.push(String(c.adjFromApi ?? "").trim());
      }
      if (adjs.length && adjs.every((a) => a === adjs[0]) && adjs[0]) adjByRoom[room] = adjs[0];
    }
  }
}

function datePartsForHeader(roundSeq, prefix) {
  const siteKey = scheduleVenueKeyFromRoomPrefix(prefix);
  const ymd = siteKey ? wadlScheduledDateYmd(roundSeq, siteKey) : null;
  if (!ymd) {
    const d = new Date();
    return {
      dateDisplay: d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "2-digit" }),
      weekday: d.toLocaleDateString("en-AU", { weekday: "long" }).toUpperCase(),
    };
  }
  const d = new Date(`${ymd}T12:00:00`);
  return {
    dateDisplay: d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "2-digit" }),
    weekday: d.toLocaleDateString("en-AU", { weekday: "long" }).toUpperCase(),
  };
}

function venueTitleEffective(prefix) {
  const o = el("venueTitle").value.trim();
  if (o) return o;
  return defaultVenueTitleFromRoomPrefix(prefix);
}

function renderStatusHint(overflow = []) {
  const parts = [];
  if (overflow.length) parts.push(...overflow);
  if (parts.length) {
    el("layoutHint").textContent = parts.join(" ");
    return;
  }
  if (!roomOrder.length) {
    el("layoutHint").textContent = "Load a round and venue to preview.";
    return;
  }
  el("layoutHint").textContent = isInconsistentAdj()
    ? "Per-timeslot adjudicators — export matches this grid."
    : "One adjudicator per room row — export matches this grid.";
}

function divisionAbbrev(division) {
  if (division === "Novice") return "N";
  if (division === "Junior") return "J";
  if (division === "Senior") return "S";
  return "";
}

function slotCellHtml(cell) {
  if (!cell || (!cell.aff && !cell.neg)) return "—";
  const tag = divisionAbbrev(cell.division);
  const aff = String(cell.aff || "").trim() || "—";
  const neg = String(cell.neg || "").trim() || "—";
  let divClass = "";
  if (cell.division === "Novice") divClass = "div-nov";
  else if (cell.division === "Junior") divClass = "div-jnr";
  else if (cell.division === "Senior") divClass = "div-snr";
  const cls = divClass ? ` class="schedule-slot-debate ${divClass}"` : ' class="schedule-slot-debate"';
  const suffix = tag ? ` <span class="schedule-slot-tag">(${tag})</span>` : "";
  return `<span${cls}>${aff} <span class="schedule-vs">v</span> ${neg}${suffix}</span>`;
}

/**
 * Lock auto-placed debates in the given slots at their current cells so a swap
 * (especially one involving an empty cell) doesn't cause other debates to shift.
 * Cells with collisions (`_collision`) are skipped — we don't move ambiguous cells.
 * @param {Map<string, Map<string, object|null>>} matrix
 * @param {Iterable<string>} slots
 */
function lockSlotsInPlace(matrix, slots) {
  for (const slot of slots) {
    for (const room of roomOrder) {
      const c = matrix.get(room)?.get(slot);
      if (!c || c._collision || !c.debate) continue;
      const k = debateKey(c.debate);
      if (!k) continue;
      if (!manualPlacements.has(k)) {
        manualPlacements.set(k, { room, slot });
      }
    }
  }
}

function applyDebateSwap(srcRoom, srcSlot, dstRoom, dstSlot) {
  if (srcRoom === dstRoom && srcSlot === dstSlot) return;
  const { matrix } = buildMatrixBundle();
  const srcCell = matrix.get(srcRoom)?.get(srcSlot) || null;
  const dstCell = matrix.get(dstRoom)?.get(dstSlot) || null;
  const srcDebate = srcCell?.debate || null;
  if (!srcDebate) return;
  if (srcCell?._collision || dstCell?._collision) {
    el("bulkStatus").textContent =
      "Can't move a debate into or out of a merged (collision) cell — fix overflow first.";
    return;
  }
  const dstDebate = dstCell?.debate || null;

  lockSlotsInPlace(matrix, new Set([srcSlot, dstSlot]));

  manualPlacements.set(debateKey(srcDebate), { room: dstRoom, slot: dstSlot });
  if (dstDebate) {
    manualPlacements.set(debateKey(dstDebate), { room: srcRoom, slot: srcSlot });
  } else {
    el("bulkStatus").textContent = `Moved debate to ${dstRoom} @ ${dstSlot}.`;
  }
  if (dstDebate) {
    el("bulkStatus").textContent = `Swapped debates between ${srcRoom}/${srcSlot} and ${dstRoom}/${dstSlot}.`;
  }
  log(
    dstDebate
      ? `Swap: (${srcRoom}, ${srcSlot}) ↔ (${dstRoom}, ${dstSlot}).`
      : `Move: (${srcRoom}, ${srcSlot}) → (${dstRoom}, ${dstSlot}).`
  );

  refreshDerived({ prefillAdj: false });
}

function buildSlotTd(matrix, room, slot) {
  const td = document.createElement("td");
  td.className = "schedule-slot-td";
  td.dataset.room = room;
  td.dataset.slot = slot;
  const cell = matrix.get(room)?.get(slot) || null;
  const hasDebate = !!(cell && (cell.aff || cell.neg));
  const isCollision = !!cell?._collision;
  td.innerHTML = slotCellHtml(cell);

  if (hasDebate && !isCollision) {
    td.classList.add("schedule-slot-draggable");
    td.setAttribute("draggable", "true");
    if (cell?.debate) {
      const k = debateKey(cell.debate);
      if (k && manualPlacements.has(k)) {
        td.classList.add("schedule-slot-pinned");
        td.title = "Pinned by manual swap — drag to move again, or click “Reset manual swaps”.";
      } else {
        td.title = "Drag onto another cell to swap, or onto an empty cell to move.";
      }
    }
    td.addEventListener("dragstart", (e) => {
      dragSource = { room, slot };
      td.classList.add("schedule-slot-dragging");
      try {
        e.dataTransfer.setData("text/plain", `${room}|${slot}`);
      } catch {
        /* ignore */
      }
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    td.addEventListener("dragend", () => {
      td.classList.remove("schedule-slot-dragging");
      dragSource = null;
      document
        .querySelectorAll(".schedule-slot-td.schedule-slot-drop-target")
        .forEach((n) => n.classList.remove("schedule-slot-drop-target"));
    });
  }

  // Any slot td is a drop target (move/swap). Collision cells reject in handler.
  td.addEventListener("dragover", (e) => {
    if (!dragSource) return;
    if (dragSource.room === room && dragSource.slot === slot) return;
    if (isCollision) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    td.classList.add("schedule-slot-drop-target");
  });
  td.addEventListener("dragleave", () => {
    td.classList.remove("schedule-slot-drop-target");
  });
  td.addEventListener("drop", (e) => {
    td.classList.remove("schedule-slot-drop-target");
    if (!dragSource) return;
    e.preventDefault();
    const src = dragSource;
    dragSource = null;
    applyDebateSwap(src.room, src.slot, room, slot);
  });

  return td;
}

function renderPreview(matrix, overflow = []) {
  const wrap = el("previewWrap");
  wrap.innerHTML = "";

  if (!roomOrder.length) {
    wrap.innerHTML =
      '<p class="hint">Add room rows below (bulk add or autofill). Tabbycat room codes are only used to pick the venue — they are not copied into this table.</p>';
    renderStatusHint(overflow);
    return;
  }

  if (overflow.length) {
    const warn = document.createElement("p");
    warn.className = "hint schedule-overflow-warn";
    warn.textContent = overflow.join(" ");
    wrap.appendChild(warn);
  }

  const tbl = document.createElement("table");
  tbl.className = "schedule-preview-table schedule-allocation-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headers = ["#", "Room"];
  if (isInconsistentAdj()) {
    for (const slot of STANDARD_TIMESLOTS) {
      headers.push(slot, "Adj");
    }
  } else {
    headers.push(...STANDARD_TIMESLOTS, "Adjudicator");
  }
  headers.push("");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  const tb = document.createElement("tbody");
  roomOrder.forEach((room, idx) => {
    const tr = document.createElement("tr");

    const tdNum = document.createElement("td");
    tdNum.textContent = String(idx + 1);
    tdNum.className = "schedule-row-num";
    tr.appendChild(tdNum);

    const tdRoom = document.createElement("td");
    const inpRoom = document.createElement("input");
    inpRoom.type = "text";
    inpRoom.className = "schedule-room-input";
    inpRoom.value = room;
    inpRoom.placeholder = "Room code";
    inpRoom.addEventListener("change", () => {
      const neu = inpRoom.value.trim();
      if (!neu || neu === room) {
        inpRoom.value = room;
        return;
      }
      renameRoom(room, neu);
      roomOrder[idx] = neu;
      refreshDerived({ prefillAdj: false });
    });
    tdRoom.appendChild(inpRoom);
    tr.appendChild(tdRoom);

    if (isInconsistentAdj()) {
      ensureAdjSlots(room);
      for (const slot of STANDARD_TIMESLOTS) {
        tr.appendChild(buildSlotTd(matrix, room, slot));

        const tdAdj = document.createElement("td");
        const inpAdj = document.createElement("input");
        inpAdj.type = "text";
        inpAdj.className = "schedule-adj-input";
        inpAdj.value = adjByRoomSlot[room][slot] ?? "";
        inpAdj.placeholder = "Adj";
        inpAdj.addEventListener("input", () => {
          const r = roomOrder[idx];
          ensureAdjSlots(r);
          adjByRoomSlot[r][slot] = inpAdj.value;
          saveUiState();
        });
        tdAdj.appendChild(inpAdj);
        tr.appendChild(tdAdj);
      }
    } else {
      for (const slot of STANDARD_TIMESLOTS) {
        tr.appendChild(buildSlotTd(matrix, room, slot));
      }

      const tdAdj = document.createElement("td");
      const inpAdj = document.createElement("input");
      inpAdj.type = "text";
      inpAdj.className = "schedule-adj-input";
      inpAdj.value = adjByRoom[room] ?? "";
      inpAdj.placeholder = "Adjudicator";
      inpAdj.addEventListener("input", () => {
        adjByRoom[roomOrder[idx]] = inpAdj.value;
        saveUiState();
      });
      tdAdj.appendChild(inpAdj);
      tr.appendChild(tdAdj);
    }

    const tdRm = document.createElement("td");
    tdRm.className = "schedule-room-actions";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "✕";
    rm.className = "small";
    rm.title = "Remove row";
    rm.addEventListener("click", () => {
      const r = roomOrder[idx];
      roomOrder.splice(idx, 1);
      delete adjByRoom[r];
      delete adjByRoomSlot[r];
      dropManualPlacementsForRoom(r);
      refreshDerived();
    });
    tdRm.appendChild(rm);
    tr.appendChild(tdRm);

    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  wrap.appendChild(tbl);
  renderStatusHint(overflow);
}

function updateExportButtons() {
  const can = roomOrder.length > 0 && getVenuePrefix() && getRoundSeq();
  el("btnXlsx").disabled = !can;
  el("btnCsv").disabled = !can;
  el("btnShare").disabled = !can || !navigator.share;
}

function updateAutofillRoomHint() {
  const hint = el("autofillRoomHint");
  if (!hint) return;
  const n = requiredRoomRowCount(filteredDebates);
  if (!getVenuePrefix() || !filteredDebates.length) {
    hint.textContent = "Load round and venue to see how many room rows autofill will create.";
    return;
  }
  if (!n) {
    hint.textContent = "No debates in standard timeslots (5.15 / 6.15 / 7.15) for this venue.";
    return;
  }
  const parts = STANDARD_TIMESLOTS.map((slot) => {
    const c = filteredDebates.filter((d) => d.timeslot === slot).length;
    return `${slot}: ${c}`;
  });
  hint.textContent = `Autofill will create ${n} room row(s) (busiest timeslot). ${parts.join(" · ")}.`;
}

function refreshDerived(opts = {}) {
  const { matrix, overflow } = buildMatrixBundle();
  if (opts.prefillAdj !== false) prefillAdjudicators(matrix);
  renderPreview(matrix, overflow);
  saveUiState();
  updateExportButtons();
  updateManualSwapUi();
  updateAutofillRoomHint();
}

function wireBasePresets() {
  for (const r of document.querySelectorAll('input[name="basePreset"]')) {
    r.addEventListener("change", () => {
      el("baseManual").disabled = r.value !== "custom";
    });
  }
  el("baseManual").disabled = true;
}

async function onLoadMeta() {
  const base = getBaseUrl();
  const token = getToken();
  if (!token) {
    log("Enter API token first.", true);
    return;
  }
  el("loadMetaStatus").textContent = "Loading…";
  try {
    const results = await Promise.all(
      DIVISION_SLUGS.map(async ({ slug }) => {
        const [rounds, teams, venues, adjudicators] = await Promise.all([
          listRounds(base, token, slug),
          listTeams(base, token, slug),
          listVenues(base, token, slug),
          listAdjudicators(base, token, slug),
        ]);
        return { rounds, teams, venues, adjudicators };
      })
    );
    cachedMeta = { teams: [], venues: [], adjudicators: [], rounds: [] };
    for (const r of results) {
      cachedMeta.rounds.push(r.rounds);
      cachedMeta.teams.push(r.teams);
      cachedMeta.venues.push(r.venues);
      cachedMeta.adjudicators.push(r.adjudicators);
    }
    const seqs = unionRoundSeqs(cachedMeta.rounds);
    const sel = el("roundSelect");
    sel.innerHTML = "";
    for (const s of seqs) {
      const opt = document.createElement("option");
      opt.value = String(s);
      opt.textContent = `Round ${s}`;
      sel.appendChild(opt);
    }
    sel.disabled = seqs.length === 0;
    el("btnLoadRound").disabled = seqs.length === 0;
    el("loadMetaStatus").textContent = `OK: metadata for ${DIVISION_SLUGS.length} divisions.`;
    log(`Loaded metadata for ${DIVISION_SLUGS.map((x) => x.slug).join(", ")}.`);
  } catch (e) {
    el("loadMetaStatus").textContent = String(e.message || e);
    log(String(e.message || e), true);
  }
}

async function onLoadRound() {
  const base = getBaseUrl();
  const token = getToken();
  const roundSeq = getRoundSeq();
  if (!token || !roundSeq) {
    log("Token and round required.", true);
    return;
  }
  if (!cachedMeta) {
    log("Run “Load rounds & divisions” first.", true);
    return;
  }
  el("loadRoundStatus").textContent = "Loading pairings…";
  try {
    const lists = await Promise.all(
      DIVISION_SLUGS.map(({ slug }) => listPairingsForRound(base, token, slug, roundSeq))
    );
    const { debates, excludedCount, rawCount } = normalizeAllPairings(lists, {
      teams: cachedMeta.teams,
      venues: cachedMeta.venues,
      adjudicators: cachedMeta.adjudicators,
    });
    allDebates = debates;
    const prefs = uniquePrefixesFromDebates(allDebates);
    const vs = el("venuePrefixSelect");
    vs.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "— pick venue —";
    vs.appendChild(opt0);
    for (const p of prefs) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      vs.appendChild(opt);
    }
    vs.disabled = prefs.length === 0;
    el("loadRoundStatus").textContent = `OK: ${allDebates.length} debate(s) included.`;
    if (excludedCount > 0) {
      log(
        `Round ${roundSeq}: ${allDebates.length} debate(s) kept; ${excludedCount} of ${rawCount} pairing(s) excluded (bye / withdrawn / retracted / postponed).`
      );
    } else {
      log(`Round ${roundSeq}: ${allDebates.length} debate(s); ${prefs.length} venue prefix(es).`);
    }
    onVenueChange();
  } catch (e) {
    el("loadRoundStatus").textContent = String(e.message || e);
    log(String(e.message || e), true);
  }
}

function onVenueChange() {
  const prefix = getVenuePrefix();
  filteredDebates = prefix ? filterDebatesByVenuePrefix(allDebates, prefix) : [];
  refreshDerived();
}

function exportPayload(matrix) {
  const prefix = getVenuePrefix();
  const roundSeq = getRoundSeq() || 1;
  const { dateDisplay, weekday } = datePartsForHeader(roundSeq, prefix);
  const prepLines = el("prepMonitors").value
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    inconsistentAdjAllocation: isInconsistentAdj(),
    dateDisplay,
    weekday,
    venueTitle: venueTitleEffective(prefix),
    ha: el("haField").value.trim(),
    adjRoom: el("adjRoomField").value.trim(),
    prepMonitorLines: prepLines,
    roomOrder: [...roomOrder],
    adjByRoom: { ...adjByRoom },
    adjByRoomSlot: JSON.parse(JSON.stringify(adjByRoomSlot)),
    cellByRoomSlot: matrix,
  };
}

function xlsxBaseName() {
  const prefix = getVenuePrefix().replace(/[^\w.-]+/g, "") || "venue";
  return `wadl-draw-r${getRoundSeq()}-${prefix}`;
}

async function onDownloadXlsx() {
  const { matrix } = buildMatrixBundle();
  el("exportHint").textContent = "Building workbook…";
  try {
    const wb = await buildScheduleWorkbook(exportPayload(matrix));
    const fname = `${xlsxBaseName()}.xlsx`;
    await downloadWorkbook(wb, fname);
    el("exportHint").textContent = `Saved ${fname}`;
    log(`Downloaded ${fname}`);
  } catch (e) {
    el("exportHint").textContent = String(e.message || e);
    log(String(e.message || e), true);
  }
}

async function onShare() {
  const { matrix } = buildMatrixBundle();
  try {
    const wb = await buildScheduleWorkbook(exportPayload(matrix));
    const fname = `${xlsxBaseName()}.xlsx`;
    const file = await workbookToXlsxFile(wb, fname);
    await shareScheduleFile(file, fname);
    log(`Shared ${fname}`);
  } catch (e) {
    log(String(e.message || e), true);
  }
}

function onDownloadCsv() {
  const csv = debatesToScheduleCsv(filteredDebates);
  const prefix = getVenuePrefix().replace(/[^\w.-]+/g, "") || "venue";
  downloadTextFile(`wadl-draw-r${getRoundSeq()}-${prefix}.csv`, csv, "text/csv;charset=utf-8");
  log("Downloaded CSV.");
}

function onBulkRooms() {
  const parsed = parseBulkRooms(el("bulkRooms").value);
  if (!parsed.length) {
    el("bulkStatus").textContent = "No room codes found — enter one per line, comma-separated, or a range like H2.15-H2.35.";
    return;
  }
  const { added, skipped } = mergeRoomList(parsed);
  el("bulkRooms").value = "";
  const parts = [`Added ${added} room(s).`];
  if (skipped) parts.push(`${skipped} already in the list.`);
  el("bulkStatus").textContent = parts.join(" ");
  log(`Bulk add: ${parts.join(" ")}`);
  refreshDerived();
}

function onAutofill() {
  const start = el("autoStart").value.trim();
  if (!start) {
    log("Enter a start room for autofill.", true);
    return;
  }
  const n = requiredRoomRowCount(filteredDebates);
  if (!n) {
    el("bulkStatus").textContent = "No debates for this venue — load the round and pick a venue first.";
    log("Autofill needs loaded pairings for the selected venue.", true);
    return;
  }
  roomOrder = autofillRoomSeries(start, n);
  adjByRoom = {};
  adjByRoomSlot = {};
  manualPlacements = new Map();
  el("bulkStatus").textContent = `Replaced list with ${roomOrder.length} room(s) (${n} needed for busiest timeslot) from ${start}.`;
  log(`Autofill: ${roomOrder.length} rooms (${roomOrder[0]} … ${roomOrder[roomOrder.length - 1]}).`);
  refreshDerived();
}

function onAddRoom() {
  const name = prompt("Room code (e.g. H2.40)", "");
  if (!name?.trim()) return;
  const { added } = mergeRoomList([name.trim()]);
  if (added) {
    el("bulkStatus").textContent = `Added room ${name.trim()}.`;
    refreshDerived();
  } else {
    el("bulkStatus").textContent = `Room ${name.trim()} is already in the list.`;
  }
}

function onSortRooms() {
  roomOrder = [...roomOrder].sort(compareRoomNames);
  el("bulkStatus").textContent = "Sorted rooms A→Z.";
  refreshDerived({ prefillAdj: false });
}

function onApplyAdjAll() {
  const first = roomOrder
    .map((r) => {
      if (isInconsistentAdj()) {
        ensureAdjSlots(r);
        return STANDARD_TIMESLOTS.map((t) => String(adjByRoomSlot[r][t] ?? "").trim()).find(Boolean);
      }
      return String(adjByRoom[r] ?? "").trim();
    })
    .find(Boolean);
  if (!first) {
    log("No adjudicator on any row to copy.", true);
    return;
  }
  for (const r of roomOrder) {
    adjByRoom[r] = first;
    if (isInconsistentAdj()) {
      ensureAdjSlots(r);
      for (const t of STANDARD_TIMESLOTS) adjByRoomSlot[r][t] = first;
    }
  }
  el("bulkStatus").textContent = `Copied “${first}” to all ${roomOrder.length} row(s).`;
  refreshDerived({ prefillAdj: false });
}

function onBulkAdjs() {
  if (!roomOrder.length) {
    el("bulkStatus").textContent = "Add room rows first, then paste adjudicator CSV.";
    return;
  }
  const text = el("bulkAdjs").value;
  const { applied, unmatched, skipped } = applyBulkAdjudicatorsCsv(text, roomOrder, adjByRoom);
  if (isInconsistentAdj()) {
    for (const r of roomOrder) {
      if (adjByRoom[r] !== undefined) copyRowAdjToAllSlots(r);
    }
  }
  if (!applied && !unmatched.length) {
    el("bulkStatus").textContent =
      "No rows applied — use room,adjudicator columns (e.g. H2.15,Eugene).";
    return;
  }
  const parts = [`Set adjudicator on ${applied} room(s).`];
  if (unmatched.length) parts.push(`${unmatched.length} room(s) not in table: ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? "…" : ""}.`);
  if (skipped) parts.push(`${skipped} blank row(s) skipped.`);
  el("bulkStatus").textContent = parts.join(" ");
  log(`Bulk adjudicators: ${parts.join(" ")}`);
  el("bulkAdjs").value = "";
  refreshDerived({ prefillAdj: false });
}

wireBasePresets();
loadUiState();

el("btnLoadMeta").addEventListener("click", onLoadMeta);
el("btnLoadRound").addEventListener("click", onLoadRound);
el("venuePrefixSelect").addEventListener("change", () => {
  saveUiState();
  onVenueChange();
});
el("venueTitle").addEventListener("input", () => {
  saveUiState();
  refreshDerived({ prefillAdj: false });
});
el("haField").addEventListener("input", saveUiState);
el("adjRoomField").addEventListener("input", saveUiState);
el("prepMonitors").addEventListener("input", saveUiState);
el("inconsistentAdj").addEventListener("change", () => {
  if (isInconsistentAdj()) {
    for (const room of roomOrder) syncSlotAdjsFromRow(room);
  }
  refreshDerived({ prefillAdj: false });
});
el("btnBulkRooms").addEventListener("click", onBulkRooms);
el("btnBulkAdjs").addEventListener("click", onBulkAdjs);
el("btnAutofill").addEventListener("click", onAutofill);
el("btnAddRoom").addEventListener("click", onAddRoom);
el("btnSortRooms").addEventListener("click", onSortRooms);
el("btnApplyAdjAll").addEventListener("click", onApplyAdjAll);
el("btnXlsx").addEventListener("click", onDownloadXlsx);
el("btnShare").addEventListener("click", onShare);
el("btnCsv").addEventListener("click", onDownloadCsv);
el("btnResetSwaps")?.addEventListener("click", () => resetManualPlacements());
el("btnClearLog").addEventListener("click", () => {
  el("log").innerHTML = "";
});

updateManualSwapUi();

log("Serve over HTTP. Load metadata → round → venue prefix.");
