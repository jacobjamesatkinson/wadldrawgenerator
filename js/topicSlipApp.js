/**
 * Topic slip generator: Tabbycat pairings (all divisions) → printable slips by venue.
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
  debateKey,
} from "./scheduleData.js";
import { STANDARD_TIMESLOTS } from "./timeslot.js";
import { buildTopicSlips, slipSummary, prepAssignmentKey } from "./topicSlipData.js";
import { assignPrepRooms, suggestedRoomPoolSize } from "./topicSlipPrep.js";
import { downloadTopicSlipDocx, downloadTopicSlipPdf } from "./topicSlipExport.js";
import { compareRoomNames } from "./venuePrefix.js";

const PROD = "https://draw.wadl.org";
const STAGING = "https://wadlsdc26-staging-2f6d981ee2d9.herokuapp.com";
const STORAGE_KEY = "wadlTopicSlips:v3";

const el = (id) => document.getElementById(id);

/** @type {{ teams: object[][], venues: object[][], adjudicators: object[][], rounds: object[][] } | null} */
let cachedMeta = null;
/** @type {object[]} */
let allDebates = [];
/** @type {object[]} */
let filteredDebates = [];
/** @type {string[]} */
let roomOrder = [];
/** @type {Record<string, string>} prepAssignmentKey → prep room (computed + overrides) */
let prepAssignments = {};
/** @type {Record<string, string>} manual prep overrides by prepAssignmentKey */
let prepOverrides = {};
/** @type {string[]} */
let prepWarnings = [];
/** @type {Map<string, { room: string, slot: string }>} */
let manualPlacements = new Map();
let dragSource = null;

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

function getRoundSeq() {
  const v = parseInt(el("roundSelect").value, 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function getVenuePrefix() {
  return el("venuePrefixSelect").value.trim();
}

function divisionContentFromForm() {
  return DIVISION_SLUGS.map(({ label }) => {
    const key = label.toLowerCase();
    return {
      topic: el(`topic_${key}`)?.value ?? "",
      infoSlide: el(`info_${key}`)?.value ?? "",
    };
  });
}

function saveUiState() {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        roomOrder,
        prepOverrides,
        venuePrefix: el("venuePrefixSelect").value,
        roundSeq: el("roundSelect").value,
        divisionContent: divisionContentFromForm(),
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
    if (Array.isArray(o.roomOrder)) roomOrder = o.roomOrder;
    if (o.prepOverrides && typeof o.prepOverrides === "object") prepOverrides = o.prepOverrides;
    if (Array.isArray(o.divisionContent)) {
      o.divisionContent.forEach((c, i) => {
        const label = DIVISION_SLUGS[i]?.label;
        if (!label || !c) return;
        const key = label.toLowerCase();
        if (el(`topic_${key}`) && c.topic != null) el(`topic_${key}`).value = c.topic;
        if (el(`info_${key}`) && c.infoSlide != null) el(`info_${key}`).value = c.infoSlide;
      });
    }
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

function updateManualSwapUi() {
  const btn = el("btnResetSwaps");
  if (!btn) return;
  const n = manualPlacements.size;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `Reset manual swaps (${n})` : "Reset manual swaps";
}

function resetManualPlacements() {
  if (!manualPlacements.size) {
    updateManualSwapUi();
    return;
  }
  manualPlacements = new Map();
  log("Cleared manual debate swaps.");
  refreshDerived();
}

function renameRoom(oldName, newName) {
  const old = String(oldName || "").trim();
  const neu = String(newName || "").trim();
  if (!old || !neu || old === neu) return;
  for (const [k, v] of manualPlacements) {
    if (v?.room === old) manualPlacements.set(k, { room: neu, slot: v.slot });
  }
}

function buildMatrixBundle() {
  return buildCellMatrix(filteredDebates, roomOrder, { manualPlacements });
}

function mergeRoomList(incoming) {
  const { merged, added, skipped } = mergeRoomListWithStats(incoming, roomOrder);
  roomOrder = merged;
  return { added, skipped };
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
  const cls = divClass ? `schedule-slot-debate ${divClass}` : "schedule-slot-debate";
  const suffix = tag ? ` <span class="schedule-slot-tag">(${tag})</span>` : "";
  return `<span class="${cls}">${aff} <span class="schedule-vs">v</span> ${neg}${suffix}</span>`;
}

function lockSlotsInPlace(matrix, slots) {
  for (const slot of slots) {
    for (const room of roomOrder) {
      const c = matrix.get(room)?.get(slot);
      if (!c || c._collision || !c.debate) continue;
      const k = debateKey(c.debate);
      if (!k) continue;
      if (!manualPlacements.has(k)) manualPlacements.set(k, { room, slot });
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
    el("bulkStatus").textContent = "Can't swap into/out of a collision cell — fix overflow first.";
    return;
  }
  const dstDebate = dstCell?.debate || null;
  lockSlotsInPlace(matrix, new Set([srcSlot, dstSlot]));
  manualPlacements.set(debateKey(srcDebate), { room: dstRoom, slot: dstSlot });
  if (dstDebate) {
    manualPlacements.set(debateKey(dstDebate), { room: srcRoom, slot: srcSlot });
    el("bulkStatus").textContent = `Swapped debates: ${srcRoom}/${srcSlot} ↔ ${dstRoom}/${dstSlot}.`;
  } else {
    el("bulkStatus").textContent = `Moved debate to ${dstRoom} @ ${dstSlot}.`;
  }
  log(dstDebate ? `Swap: (${srcRoom}, ${srcSlot}) ↔ (${dstRoom}, ${dstSlot}).` : `Move: (${srcRoom}, ${srcSlot}) → (${dstRoom}, ${dstSlot}).`);
  refreshDerived();
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
        td.title = "Pinned by manual swap — drag to move, or Reset manual swaps.";
      } else {
        td.title = "Drag onto another cell to swap debates, or onto empty to move.";
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

  td.addEventListener("dragover", (e) => {
    if (!dragSource) return;
    if (dragSource.room === room && dragSource.slot === slot) return;
    if (isCollision) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    td.classList.add("schedule-slot-drop-target");
  });
  td.addEventListener("dragleave", () => td.classList.remove("schedule-slot-drop-target"));
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

function runPrepAssignment(matrix) {
  const { assignments, unassigned, warnings } = assignPrepRooms(matrix, roomOrder, prepOverrides);
  prepAssignments = assignments;
  prepWarnings = warnings;
  return { unassigned, warnings };
}

function buildPrepTd(matrix, room, slot) {
  const td = document.createElement("td");
  td.className = "schedule-slot-td schedule-prep-td";
  const cell = matrix.get(room)?.get(slot);
  if (!cell || cell._collision || (!cell.aff && !cell.neg)) {
    td.innerHTML = '<span class="topic-prep-empty">—</span>';
    return td;
  }

  const wrap = document.createElement("div");
  wrap.className = "topic-prep-cell";

  for (const [side, teamRaw, sideLabel] of [
    ["AFF", cell.aff, "Aff"],
    ["NEG", cell.neg, "Neg"],
  ]) {
    const team = String(teamRaw ?? "").trim();
    if (!team || team === "—") continue;
    const key = prepAssignmentKey(slot, team, side);
    const assigned = prepAssignments[key] ?? "";
    const isAffInFirst = slot === STANDARD_TIMESLOTS[0] && side === "AFF";
    const autoNote = isAffInFirst && assigned === room ? " (debate room)" : "";

    const row = document.createElement("div");
    row.className = "topic-prep-row";
    const lbl = document.createElement("span");
    lbl.className = "topic-prep-side";
    lbl.textContent = sideLabel;
    lbl.title = team + (isAffInFirst ? " — 5.15 Aff may prep in debate room" : "");
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "topic-prep-slot-input";
    inp.placeholder = "Prep";
    inp.dataset.prepKey = key;
    inp.title = `${team} prep for ${slot}${autoNote}`;
    inp.value = assigned;
    if (!assigned) inp.classList.add("topic-prep-missing");
    inp.addEventListener("change", () => {
      const v = inp.value.trim();
      if (v) prepOverrides[key] = v;
      else delete prepOverrides[key];
      refreshDerived({ skipTableRender: true });
    });
    row.appendChild(lbl);
    row.appendChild(inp);
    wrap.appendChild(row);
  }

  td.appendChild(wrap);
  return td;
}

function renderPreview(matrix, overflow = []) {
  const wrap = el("previewWrap");
  wrap.innerHTML = "";

  if (!roomOrder.length) {
    wrap.innerHTML = '<p class="hint">Add room rows (bulk add or autofill), then load pairings.</p>';
    updateStatusHint(overflow);
    return;
  }

  if (overflow.length) {
    const warn = document.createElement("p");
    warn.className = "hint schedule-overflow-warn";
    warn.textContent = overflow.join(" ");
    wrap.appendChild(warn);
  }

  const tbl = document.createElement("table");
  tbl.className = "schedule-preview-table schedule-allocation-table topic-allocation-table";
  const thead = document.createElement("thead");
  const headRow1 = document.createElement("tr");
  for (const h of ["#", "Room"]) {
    const th = document.createElement("th");
    th.textContent = h;
    if (h === "#") th.rowSpan = 2;
    if (h === "Room") th.rowSpan = 2;
    headRow1.appendChild(th);
  }
  for (const slot of STANDARD_TIMESLOTS) {
    const th = document.createElement("th");
    th.colSpan = 2;
    th.textContent = slot;
    th.className = "topic-slot-head";
    headRow1.appendChild(th);
  }
  const thRm = document.createElement("th");
  thRm.rowSpan = 2;
  thRm.textContent = "";
  headRow1.appendChild(thRm);
  thead.appendChild(headRow1);

  const headRow2 = document.createElement("tr");
  for (const _slot of STANDARD_TIMESLOTS) {
    for (const sub of ["Debate", "Prep"]) {
      const th = document.createElement("th");
      th.textContent = sub;
      th.className = sub === "Prep" ? "topic-prep-head" : "topic-debate-head";
      headRow2.appendChild(th);
    }
  }
  thead.appendChild(headRow2);
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
    inpRoom.addEventListener("change", () => {
      const neu = inpRoom.value.trim();
      if (!neu || neu === room) {
        inpRoom.value = room;
        return;
      }
      renameRoom(room, neu);
      roomOrder[idx] = neu;
      refreshDerived();
    });
    tdRoom.appendChild(inpRoom);
    tr.appendChild(tdRoom);

    for (const slot of STANDARD_TIMESLOTS) {
      tr.appendChild(buildSlotTd(matrix, room, slot));
      tr.appendChild(buildPrepTd(matrix, room, slot));
    }

    const tdRm = document.createElement("td");
    tdRm.className = "schedule-room-actions";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "✕";
    rm.className = "small";
    rm.addEventListener("click", () => {
      const r = roomOrder[idx];
      roomOrder.splice(idx, 1);
      for (const [k, v] of manualPlacements) {
        if (v?.room === r) manualPlacements.delete(k);
      }
      refreshDerived();
    });
    tdRm.appendChild(rm);
    tr.appendChild(tdRm);
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  wrap.appendChild(tbl);

  const sumP = document.createElement("p");
  sumP.className = "hint topic-slip-summary";
  wrap.appendChild(sumP);
  updateExportSummary(matrix);

  updateStatusHint(overflow);
}

function syncPrepInputValues() {
  for (const inp of document.querySelectorAll("input[data-prep-key]")) {
    const key = inp.dataset.prepKey;
    if (!key) continue;
    const v = prepAssignments[key] ?? "";
    if (inp !== document.activeElement) inp.value = v;
    inp.classList.toggle("topic-prep-missing", !String(v).trim());
  }
}

function updateStatusHint(overflow = []) {
  if (overflow.length) {
    el("layoutHint").textContent = overflow.join(" ");
    return;
  }
  if (!getVenuePrefix()) {
    el("layoutHint").textContent = "Load metadata → round → venue, then import one room list for debates and prep.";
    return;
  }
  const parts = [
    "One room list for debate rows and prep. Prep starts 1h before each timeslot — rooms in the previous timeslot cannot be used for prep (e.g. 5.15 debates block 6.15 prep). 5.15 Aff may prep in their debate room; 6.15/7.15 Aff and all Neg use separate prep rooms.",
  ];
  if (prepWarnings.length) parts.push(prepWarnings.join(" "));
  el("layoutHint").textContent = parts.join(" ");
}

function updateExportButtons() {
  const can = roomOrder.length > 0 && getVenuePrefix() && getRoundSeq();
  el("btnDocx").disabled = !can;
  el("btnPdf").disabled = !can;
}

function updateExportSummary(matrix) {
  const sumP = document.querySelector(".topic-slip-summary");
  if (!sumP) return;
  const slips = buildTopicSlips(matrix, roomOrder, divisionContentFromForm(), prepAssignments);
  const sum = slipSummary(slips);
  const unassigned = prepWarnings.length ? ` ${prepWarnings.length} prep warning(s).` : "";
  sumP.textContent = `Ready to export: ${sum.debateCount} debate(s) → ${sum.slipCount} slip(s) (${sum.debateCount} pages).${unassigned} ${Object.entries(sum.byDivision)
    .map(([d, n]) => `${d}: ${n}`)
    .join("; ")}`;
}

function updateAutofillRoomHint(matrix = null) {
  const hint = el("autofillRoomHint");
  if (!hint) return;
  if (!getVenuePrefix() || !filteredDebates.length) {
    hint.textContent = "Load round and venue to see how many rooms autofill will create.";
    return;
  }
  const debateRows = requiredRoomRowCount(filteredDebates);
  const pool = suggestedRoomPoolSize(filteredDebates, matrix, roomOrder);
  if (!debateRows) {
    hint.textContent = "No debates in standard timeslots (5.15 / 6.15 / 7.15) for this venue.";
    return;
  }
  const parts = STANDARD_TIMESLOTS.map((slot) => {
    const c = filteredDebates.filter((d) => d.timeslot === slot).length;
    return `${slot}: ${c}`;
  });
  hint.textContent = `Autofill creates ${pool} room(s) (${debateRows} for busiest debate slot + prep windows). ${parts.join(" · ")}.`;
}

function refreshDerived(opts = {}) {
  const { matrix, overflow } = buildMatrixBundle();
  if (opts.reassignPrep !== false) runPrepAssignment(matrix);
  if (opts.skipTableRender) {
    updateExportSummary(matrix);
    syncPrepInputValues();
  } else {
    renderPreview(matrix, overflow);
  }
  saveUiState();
  updateExportButtons();
  updateManualSwapUi();
  updateAutofillRoomHint(matrix);
}

function exportMeta() {
  const prefix = getVenuePrefix();
  const roundSeq = getRoundSeq();
  return {
    venueTitle: prefix ? `WADL topic slips — ${prefix}` : "WADL topic slips",
    roundLabel: roundSeq ? `Round ${roundSeq}` : "",
  };
}

function currentSlips() {
  const { matrix } = buildMatrixBundle();
  return buildTopicSlips(matrix, roomOrder, divisionContentFromForm(), prepAssignments);
}

function fileBaseName() {
  const prefix = getVenuePrefix().replace(/[^\w.-]+/g, "") || "venue";
  return `wadl-topic-slips-r${getRoundSeq()}-${prefix}`;
}

async function onDownloadDocx() {
  const slips = currentSlips();
  if (!slips.length) {
    log("No slips to export.", true);
    return;
  }
  el("exportHint").textContent = "Building Word document…";
  try {
    await downloadTopicSlipDocx(slips, `${fileBaseName()}.docx`);
    el("exportHint").textContent = `Saved ${fileBaseName()}.docx (${slips.length} slips, ${slipSummary(slips).debateCount} pages).`;
    log(`Downloaded ${fileBaseName()}.docx`);
  } catch (e) {
    el("exportHint").textContent = String(e.message || e);
    log(String(e.message || e), true);
  }
}

async function onDownloadPdf() {
  const slips = currentSlips();
  if (!slips.length) {
    log("No slips to export.", true);
    return;
  }
  el("exportHint").textContent = "Building PDF (one page per debate)…";
  try {
    await downloadTopicSlipPdf(slips, `${fileBaseName()}.pdf`, exportMeta());
    el("exportHint").textContent = `Saved ${fileBaseName()}.pdf`;
    log(`Downloaded ${fileBaseName()}.pdf`);
  } catch (e) {
    el("exportHint").textContent = String(e.message || e);
    log(String(e.message || e), true);
  }
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
  el("loadRoundStatus").textContent = "Loading pairings (Novice + Junior + Senior)…";
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
    el("loadRoundStatus").textContent = `OK: ${allDebates.length} debate(s) across all divisions.`;
    if (excludedCount > 0) {
      log(`Round ${roundSeq}: ${allDebates.length} kept; ${excludedCount} of ${rawCount} excluded.`);
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
  saveUiState();
  refreshDerived();
}

function onBulkRooms() {
  const parsed = parseBulkRooms(el("bulkRooms").value);
  if (!parsed.length) {
    el("bulkStatus").textContent = "No room codes found.";
    return;
  }
  const { added, skipped } = mergeRoomList(parsed);
  el("bulkRooms").value = "";
  el("bulkStatus").textContent = `Added ${added} row(s).${skipped ? ` ${skipped} duplicate(s) skipped.` : ""}`;
  refreshDerived();
}

function onAutofill() {
  const start = el("autoStart").value.trim();
  if (!start) {
    log("Enter a start room for autofill.", true);
    return;
  }
  const n = suggestedRoomPoolSize(filteredDebates, null, roomOrder);
  const debateRows = requiredRoomRowCount(filteredDebates);
  if (!debateRows) {
    el("bulkStatus").textContent = "No debates for this venue — load the round and pick a venue first.";
    log("Autofill needs loaded pairings for the selected venue.", true);
    return;
  }
  roomOrder = autofillRoomSeries(start, n);
  manualPlacements = new Map();
  prepOverrides = {};
  el("bulkStatus").textContent = `Replaced list with ${roomOrder.length} room(s) (${debateRows} debate rows + prep capacity) from ${start}. Prep rooms auto-assigned.`;
  log(`Autofill: ${roomOrder.length} rooms (${roomOrder[0]} … ${roomOrder[roomOrder.length - 1]}).`);
  refreshDerived();
}

function onAddRoom() {
  const name = prompt("Room code (e.g. H2.40)", "");
  if (!name?.trim()) return;
  const { added } = mergeRoomList([name.trim()]);
  if (added) refreshDerived();
}

function onSortRooms() {
  roomOrder = [...roomOrder].sort(compareRoomNames);
  refreshDerived();
}

wireBasePresets();
loadUiState();

el("btnLoadMeta").addEventListener("click", onLoadMeta);
el("btnLoadRound").addEventListener("click", onLoadRound);
el("venuePrefixSelect").addEventListener("change", onVenueChange);
el("btnBulkRooms").addEventListener("click", onBulkRooms);
el("btnAutofill").addEventListener("click", onAutofill);
el("btnReassignPrep")?.addEventListener("click", () => {
  prepOverrides = {};
  refreshDerived();
  el("bulkStatus").textContent = "Re-assigned all prep rooms from rules.";
  log("Re-assigned prep rooms.");
});
el("btnAddRoom").addEventListener("click", onAddRoom);
el("btnSortRooms").addEventListener("click", onSortRooms);
el("btnResetSwaps").addEventListener("click", resetManualPlacements);
el("btnDocx").addEventListener("click", onDownloadDocx);
el("btnPdf").addEventListener("click", onDownloadPdf);
el("btnClearLog").addEventListener("click", () => {
  el("log").innerHTML = "";
});

for (const { label } of DIVISION_SLUGS) {
  const key = label.toLowerCase();
  for (const field of ["topic", "info"]) {
    el(`${field}_${key}`)?.addEventListener("input", () => {
      saveUiState();
      refreshDerived({ skipTableRender: true });
    });
  }
}

updateManualSwapUi();
refreshDerived();
log("Serve over HTTP. Load metadata → round → venue → rooms → export.");
