import {
  listTeams,
  listTeamStandings,
  listTeamStandingsRounds,
  speaksTotalsFromStandingsRounds,
  speaksTotalsFromStandings,
  listPairingsForRound,
  listVenues,
  deleteAllPairings,
  createPairing,
  idFromUrl,
} from "./tabbycat.js";
import {
  buildVenueResolver,
  assignTabbycatVenuesToDebates,
  venueDisplayLabel,
  venueSelfUrl,
  venuePickerLabel,
  resolveVenueFromPickerInput,
} from "./venues.js";
import {
  mergeScheduling,
  findByePlaceholderTeams,
  isRetractedOrWithdrawnTeam,
  parseCsv,
  assertNoPointsColumns,
  teamLabelForCsvRoster,
  deriveSchoolKeyFromTeam,
  sanitizeCsvCell,
} from "./merge.js";
import {
  generateDraw,
  buildRematchSet,
  buildSideHistory,
  buildByeHistory,
  augmentByeHistoryWithAbsentFromLoadedRounds,
  groupPairingsByRoundSeq,
  computeLivePairingClashes,
} from "./pair.js";
import { debatesToCsv, downloadText } from "./export.js";
import { wadlScheduledDateYmd } from "./wadlVenueSchedule.js";

const PROD = "https://draw.wadl.org";
const STAGING = "https://wadlsdc26-staging-2f6d981ee2d9.herokuapp.com";

const el = (id) => document.getElementById(id);

const state = {
  debates: [],
  warnings: [],
  missing: [],
  excludedTeamIds: new Set(),
  byeTeamIds: new Set(),
  lastSlug: "",
  /** @type {object[]|null} */
  standings: null,
  /** Total speaks per team id from GET …/teams/standings/rounds (sum through standings round) */
  speaksTotalByTeamId: null,
  /** @type {{ key: string | null; asc: boolean }} */
  rosterSort: { key: null, asc: true },
  /** Tabbycat team ids manually marked as already had a bye (autocomplete chips) */
  extraByeTeamIds: new Set(),
  /** Team ids that had a bye in loaded Tabbycat pairings (refreshed with bye section) */
  apiByeTeamIdsFromHistory: new Set(),
  /** venueKey -> "YYYY-MM-DD" picked per venue block; combined with each debate's timeslot to form scheduled_at */
  venueDates: new Map(),
  /** venueKey values last set from WADL calendar (updated when round changes until user edits that venue's date) */
  venueDateAutoKeys: new Set(),
  /** Last "round to post" used when applying WADL venue dates (null until first apply) */
  wadlVenueDatesLastRound: null,
};

const ROSTER_SORT_COLS = [
  { key: "id", label: "ID", kind: "number" },
  { key: "name", label: "Name (short / code — matches CSV)", kind: "string" },
  { key: "speaks", label: "Speaks (total)", kind: "number" },
  { key: "venue", label: "Venue", kind: "string" },
  { key: "timeslot", label: "Timeslot", kind: "string" },
];

function cmpRosterNullableNum(a, b, asc) {
  const aN = a != null && Number.isFinite(Number(a)) ? Number(a) : null;
  const bN = b != null && Number.isFinite(Number(b)) ? Number(b) : null;
  if (aN == null && bN == null) return 0;
  if (aN == null) return 1;
  if (bN == null) return -1;
  const d = aN - bN;
  return asc ? d : -d;
}

function cmpRosterString(a, b, asc) {
  const sa = String(a ?? "")
    .trim()
    .toLocaleLowerCase();
  const sb = String(b ?? "")
    .trim()
    .toLocaleLowerCase();
  const d = sa.localeCompare(sb, undefined, { sensitivity: "base", numeric: true });
  return asc ? d : -d;
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

function getSlug() {
  return el("slug").value.trim();
}

function getRound() {
  const r = parseInt(el("round").value, 10);
  return Number.isNaN(r) ? 1 : r;
}

/** Per-round pairings for bye-absence logic: Action 1 map, else group `__lastPairings` by round URL, else treat flat list as round 1 only. */
function pairingsByRoundForAbsentAugment() {
  const pbr = window.__pairingsByRound;
  if (pbr && typeof pbr === "object") {
    const has = Object.values(pbr).some((arr) => Array.isArray(arr) && arr.length > 0);
    if (has) return pbr;
  }
  const flat = window.__lastPairings || [];
  if (!flat.length) return {};
  const grouped = groupPairingsByRoundSeq(flat);
  if (Object.keys(grouped).length) return grouped;
  const maxR = window.__pairingsLoadedMaxRound ?? 0;
  if (maxR === 1 && flat.length) return { 1: flat };
  return {};
}

function log(msg, err = false) {
  const p = el("log");
  if (!p) {
    console[err ? "error" : "log"](msg);
    return;
  }
  const line = document.createElement("div");
  line.className = err ? "log-err" : "log-ok";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  p.appendChild(line);
  p.scrollTop = p.scrollHeight;
}

function instKey(team) {
  return team.schoolKey || team.institution || null;
}

/** Refresh long-form note + flags from current aff/neg (after edits or before render). */
function syncDebatePairingMetadata(d) {
  const rematch = buildRematchSet(window.__lastPairings || [], state.byeTeamIds);
  const sideHist = buildSideHistory(window.__lastPairings || [], state.byeTeamIds);
  if (d.kind === "bye") {
    d.pairingRematch = false;
    d.pairingSameInst = false;
    d.pairingPowerIssue = false;
    d.pairingClashes = [];
    return;
  }
  if (!d.aff || !d.neg) return;
  const live = computeLivePairingClashes(
    d.aff,
    d.neg,
    rematch,
    instKey,
    sideHist,
    d.powerMeta,
    d._generatedTeamKey
  );
  d.pairingClashes = live.clashes;
  d.pairingRematch = live.pairingRematch;
  d.pairingSameInst = live.pairingSameInst;
  d.pairingPowerIssue = live.pairingPowerIssue;
  d.note = live.note;
}

function involvesExcluded(d) {
  if (!d.aff || !d.neg) return true;
  if (d.aff.isPlaceholder || d.neg.isPlaceholder) {
    const real = d.aff.isPlaceholder ? d.neg : d.aff;
    if (state.excludedTeamIds.has(real.id)) return true;
    return false;
  }
  if (state.excludedTeamIds.has(d.aff.id)) return true;
  if (state.excludedTeamIds.has(d.neg.id)) return true;
  return false;
}

/**
 * Parse a CSV timeslot cell like "5.15", "5:15", "5.15pm", "17:15" into 24h {h, m}.
 * WADL rounds run 5.15pm / 6.15pm / 7.15pm, so hours 1–9 with no am/pm marker default to PM.
 */
function parseTimeslotToHM(ts) {
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

/** ISO datetime (UTC Z) for venue date + debate timeslot, or null if either is missing/invalid. */
function buildScheduledAt(dateStr, ts) {
  if (!dateStr) return null;
  const hm = parseTimeslotToHM(ts);
  if (!hm) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(hm.h, hm.m, 0, 0);
  return d.toISOString();
}

function scheduledAtForDebate(d) {
  const dateStr = state.venueDates.get(d.venueKey || "");
  return buildScheduledAt(dateStr, d.timeslot);
}

/** Human-readable local datetime for display next to a timeslot heading. */
function formatScheduledAtLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function debatePayload(d) {
  const o = {
    teams: [
      { team: d.aff.url, side: "aff" },
      { team: d.neg.url, side: "neg" },
    ],
  };
  if (d.venueUrl) o.venue = d.venueUrl;
  const scheduledAt = scheduledAtForDebate(d);
  if (scheduledAt) o.scheduled_at = scheduledAt;
  return o;
}

/**
 * Tabbycat enforces at most one debate per venue per round. Same URL on multiple rows makes later POSTs fail.
 * Keep the first occurrence in post order; drop venue on later rows so every debate can still be created.
 */
function stripDuplicateRoomUrlsInPostOrder(debateList) {
  const seen = new Set();
  let n = 0;
  for (const d of debateList) {
    const u = d.venueUrl;
    if (!u) continue;
    if (seen.has(u)) {
      delete d.venueUrl;
      n++;
    } else {
      seen.add(u);
    }
  }
  return n;
}

function venueErrorMaybeRetryWithoutRoom(err) {
  const t = String(err?.message || err).toLowerCase();
  if (!t.includes("venue") && !t.includes("room")) return false;
  return (
    /unique|already|taken|duplicate|in use|assigned|may not|cannot|invalid|conflict/.test(t) ||
    /\b409\b/.test(t)
  );
}

async function tryCreatePairingWithVenueFallback(baseUrl, token, slug, round, d) {
  const venueBefore = d.venueUrl || null;
  try {
    await createPairing(baseUrl, token, slug, round, debatePayload(d));
    return { retriedWithoutVenue: false };
  } catch (e) {
    if (!venueBefore || !venueErrorMaybeRetryWithoutRoom(e)) throw e;
    delete d.venueUrl;
    try {
      await createPairing(baseUrl, token, slug, round, debatePayload(d));
      return { retriedWithoutVenue: true };
    } catch (e2) {
      if (venueBefore) d.venueUrl = venueBefore;
      throw e2;
    }
  }
}

function apiPath(slug, sub) {
  return `${getBaseUrl()}/api/v1/tournaments/${encodeURIComponent(slug)}${sub}`;
}

function resetMergedAndRosterScheduling() {
  window.__merged = null;
  state.missing = [];
  const mb = el("missingBox");
  if (mb) mb.textContent = "(run Action 2 after Action 1)";
}

let byeSearchHighlight = 0;
let byeSuggestBlurTimer = null;

let roomAllocHighlight = 0;
let roomAllocBlurTimer = null;
let teamDragPayload = null;

/** Stable numeric id for API team rows (handles string ids and url-only fallbacks). */
function numericTeamId(team) {
  if (!team) return null;
  if (team.id !== undefined && team.id !== null && `${team.id}`.trim() !== "") {
    const n = typeof team.id === "number" ? team.id : parseInt(String(team.id), 10);
    if (!Number.isNaN(n)) return n;
  }
  return idFromUrl(team.url);
}

function parseIdListText(text) {
  const ids = new Set();
  for (const part of String(text || "").split(/[,\s]+/)) {
    const n = parseInt(part.trim(), 10);
    if (!Number.isNaN(n)) ids.add(n);
  }
  return ids;
}

/** Bye-like names from API + optional manual ids (#schedulingExemptTeamIds); no CSV venue×timeslot required. */
function rebuildByeTeamIds(teams) {
  const manual = parseIdListText(el("schedulingExemptTeamIds")?.value ?? "");
  if (!teams?.length) {
    state.byeTeamIds = manual;
    return;
  }
  const auto = findByePlaceholderTeams(teams)
    .map((t) => numericTeamId(t))
    .filter((x) => x != null);
  state.byeTeamIds = new Set([...auto, ...manual]);
}

function teamByeSearchHaystack(t) {
  const tid = numericTeamId(t);
  const parts = [
    teamLabelForCsvRoster(t),
    t.short_name,
    t.code_name,
    t.short_reference,
    t.reference,
    t.long_name,
    tid != null ? String(tid) : "",
  ];
  return parts
    .filter((x) => x != null && String(x).trim() !== "" && String(x) !== "—")
    .map((x) => String(x).toLowerCase());
}

function teamsMatchingByeSearch(raw) {
  const q = String(raw || "").trim().toLowerCase();
  if (!q) return [];
  const teams = window.__teams || [];
  if (!teams.length) return [];
  const scored = [];
  for (const t of teams) {
    const tid = numericTeamId(t);
    if (tid == null) continue;
    if (isRetractedOrWithdrawnTeam(t)) continue;
    if (state.byeTeamIds.has(tid)) continue;
    if (state.extraByeTeamIds.has(tid)) continue;
    if (state.apiByeTeamIdsFromHistory.has(tid)) continue;
    const idStr = String(tid);
    const hay = teamByeSearchHaystack(t);
    const label = hay[0] || "";
    let score = 0;
    if (idStr === q) score = 99;
    else if (idStr.startsWith(q)) score = 78;
    if (hay.some((h) => h === q)) score = Math.max(score, 100);
    else if (hay.some((h) => h.startsWith(q))) score = Math.max(score, 80);
    else if (hay.some((h) => h.includes(q))) score = Math.max(score, 50);
    else if (idStr.includes(q)) score = Math.max(score, 45);
    if (score <= 0) continue;
    scored.push({ t, tid, score });
  }
  scored.sort((a, b) => b.score - a.score || a.tid - b.tid);
  return scored.slice(0, 15).map((x) => x.t);
}

function hideByeSuggestionsSoon() {
  if (byeSuggestBlurTimer) clearTimeout(byeSuggestBlurTimer);
  byeSuggestBlurTimer = setTimeout(() => {
    byeSuggestBlurTimer = null;
    const ul = el("byeTeamSuggestions");
    if (ul) {
      ul.hidden = true;
      ul.innerHTML = "";
    }
  }, 180);
}

function showByeSuggestionsFromInput() {
  if (byeSuggestBlurTimer) {
    clearTimeout(byeSuggestBlurTimer);
    byeSuggestBlurTimer = null;
  }
  const input = el("byeTeamSearch");
  const ul = el("byeTeamSuggestions");
  if (!input || !ul) return;
  const list = teamsMatchingByeSearch(input.value);
  byeSearchHighlight = list.length ? 0 : -1;
  ul.innerHTML = "";
  if (!list.length) {
    ul.hidden = true;
    return;
  }
  ul.hidden = false;
  list.forEach((t, i) => {
    const tid = numericTeamId(t);
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.className = i === byeSearchHighlight ? "active" : "";
    li.textContent = `${teamLabelForCsvRoster(t)} (id ${tid ?? "?"})`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (tid != null) addExtraByeTeamById(tid);
    });
    ul.appendChild(li);
  });
}

function refreshByeSuggestionHighlight() {
  const ul = el("byeTeamSuggestions");
  if (!ul || ul.hidden) return;
  ul.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("active", i === byeSearchHighlight);
  });
}

function addExtraByeTeamById(id) {
  const tid = typeof id === "number" ? id : parseInt(String(id), 10);
  if (Number.isNaN(tid)) return;
  if (state.byeTeamIds.has(tid)) return;
  const row = window.__teams?.find((t) => numericTeamId(t) === tid);
  if (!row) return;
  if (isRetractedOrWithdrawnTeam(row)) return;
  state.extraByeTeamIds.add(tid);
  const inp = el("byeTeamSearch");
  if (inp) inp.value = "";
  const ul = el("byeTeamSuggestions");
  if (ul) {
    ul.hidden = true;
    ul.innerHTML = "";
  }
  byeSearchHighlight = 0;
  renderExtraByeTeamChips();
}

function addFirstMatchingByeTeam() {
  const input = el("byeTeamSearch");
  if (!input) return;
  const q = input.value.trim();
  const list = teamsMatchingByeSearch(input.value);
  if (!list.length) {
    if (q) log("No team matches that search — try another name or id.", true);
    return;
  }
  const i = byeSearchHighlight >= 0 && byeSearchHighlight < list.length ? byeSearchHighlight : 0;
  const tid = numericTeamId(list[i]);
  if (tid != null) addExtraByeTeamById(tid);
}

function renderApiByeHistoryList() {
  const ul = el("apiByeHistoryList");
  const empty = el("apiByeHistoryEmpty");
  const summary = el("apiByeHistorySummary");
  if (!ul || !empty) return;
  const teams = (window.__teams || []).filter((t) => !isRetractedOrWithdrawnTeam(t));
  const teamById = new Map();
  for (const t of teams) {
    const tid = numericTeamId(t);
    if (tid != null) teamById.set(tid, t);
  }
  const pairings = window.__lastPairings || [];
  const byeHist0 = buildByeHistory(pairings, state.byeTeamIds, teamById);
  const teamHadBye = new Set(byeHist0.teamHadBye);
  const instHadBye = new Set(byeHist0.instHadBye);
  const pbrAug = pairingsByRoundForAbsentAugment();
  augmentByeHistoryWithAbsentFromLoadedRounds(
    teamHadBye,
    instHadBye,
    teams,
    pbrAug,
    state.byeTeamIds,
    teamById
  );
  for (const t of window.__teams || []) {
    if (!isRetractedOrWithdrawnTeam(t)) continue;
    const rid = numericTeamId(t);
    if (rid != null) teamHadBye.delete(rid);
  }
  state.apiByeTeamIdsFromHistory = new Set(teamHadBye);
  const ids = [...teamHadBye].sort((a, b) => a - b);
  ul.innerHTML = "";
  if (!ids.length) {
    empty.hidden = false;
    ul.hidden = true;
    if (summary) summary.textContent = "";
  } else {
    empty.hidden = true;
    ul.hidden = false;
    if (summary) {
      const roundKeys = Object.keys(pbrAug || {})
        .map((k) => parseInt(k, 10))
        .filter((r) => !Number.isNaN(r) && (pbrAug[r]?.length ?? 0) > 0)
        .sort((a, b) => a - b);
      const absentNote =
        roundKeys.length > 0
          ? ` (bye debates, and/or missing from at least one loaded round’s pairings: rounds ${roundKeys.join(", ")})`
          : " (bye debates in loaded history)";
      summary.textContent = `${ids.length} team(s) count as having had a prior bye${absentNote}.`;
    }
    for (const id of ids) {
      const t = teamById.get(id);
      const li = document.createElement("li");
      li.textContent = t ? `${teamLabelForCsvRoster(t)} (id ${id})` : `Team id ${id}`;
      ul.appendChild(li);
    }
  }
}

function renderExtraByeTeamChips() {
  const ul = el("extraByeTeamList");
  const note = el("extraByeHistoryNote");
  if (!ul) return;
  ul.innerHTML = "";
  const teams = window.__teams || [];
  const teamById = new Map();
  for (const t of teams) {
    const tid = numericTeamId(t);
    if (tid != null) teamById.set(tid, t);
  }
  const ids = [...state.extraByeTeamIds].sort((a, b) => a - b);
  if (note) note.hidden = ids.length === 0;
  for (const id of ids) {
    const t = teamById.get(id);
    const li = document.createElement("li");
    li.className = "bye-chip";
    const label = t ? teamLabelForCsvRoster(t) : `id ${id}`;
    li.appendChild(document.createTextNode(`${label} (${id})`));
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "small bye-chip-remove";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      state.extraByeTeamIds.delete(id);
      renderExtraByeTeamChips();
      if (el("byeTeamSearch")?.value.trim()) showByeSuggestionsFromInput();
    });
    li.appendChild(rm);
    ul.appendChild(li);
  }
}

function renderByeSection() {
  renderApiByeHistoryList();
  renderExtraByeTeamChips();
}

function initByeSectionControls() {
  const input = el("byeTeamSearch");
  const ul = el("byeTeamSuggestions");
  const btn = el("byeTeamAddBtn");
  if (!input || !ul || !btn) return;

  ul.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });

  input.addEventListener("focus", () => showByeSuggestionsFromInput());
  input.addEventListener("input", () => {
    byeSearchHighlight = 0;
    showByeSuggestionsFromInput();
  });
  input.addEventListener("blur", () => hideByeSuggestionsSoon());
  input.addEventListener("keydown", (e) => {
    const list = teamsMatchingByeSearch(input.value);
    if (e.key === "Escape") {
      ul.hidden = true;
      e.preventDefault();
      return;
    }
    if (!list.length) return;
    if (e.key === "ArrowDown") {
      byeSearchHighlight = Math.min(list.length - 1, byeSearchHighlight + 1);
      refreshByeSuggestionHighlight();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      byeSearchHighlight = Math.max(0, byeSearchHighlight - 1);
      refreshByeSuggestionHighlight();
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      addFirstMatchingByeTeam();
    }
  });

  btn.addEventListener("click", () => addFirstMatchingByeTeam());
}

/** One user action: teams + standings + prior-round pairings (all API calls in sequence). */
async function onLoadTournamentData() {
  const base = getBaseUrl();
  const token = getToken();
  const slug = getSlug();
  const round = getRound();
  if (!token) {
    log("Enter API token.", true);
    return;
  }
  if (!slug) {
    log("Enter tournament slug.", true);
    return;
  }
  if (round < 1 || round > 5) log("Warning: round is usually 1–5.", true);

  state.lastSlug = slug;
  const standingsRound = Math.max(0, round - 1);

  log("━━ Action: Load tournament from Tabbycat ━━");

  log(`  → teams  GET ${apiPath(slug, "/teams")}`);
  const teams = await listTeams(base, token, slug);
  window.__teams = teams;
  state.standings = null;
  window.__standings = null;
  state.speaksTotalByTeamId = null;
  state.rosterSort = { key: null, asc: true };
  state.extraByeTeamIds = new Set();
  state.apiByeTeamIdsFromHistory = new Set();
  state.venueDates = new Map();
  state.venueDateAutoKeys = new Set();
  state.wadlVenueDatesLastRound = null;
  window.__lastPairings = [];
  window.__pairingsByRound = {};
  window.__pairingsLoadedMaxRound = 0;
  resetMergedAndRosterScheduling();
  rebuildByeTeamIds(teams);
  const autoN = findByePlaceholderTeams(teams).length;
  const manualN = parseIdListText(el("schedulingExemptTeamIds")?.value ?? "").size;
  if (autoN === 0 && manualN === 0) log("  (no scheduling-exempt teams — add IDs below if you use flex/bye placeholders)");
  else {
    const ids = [...state.byeTeamIds].sort((a, b) => a - b);
    log(`  Scheduling-exempt (${ids.length} id(s), no CSV row needed): ${ids.join(", ")}`);
  }
  log(`  ✓ ${teams.length} teams`);

  window.__tabbycatVenues = [];
  window.__tabbycatVenuesForSlug = "";
  try {
    log(`  → venues  GET ${apiPath(slug, "/venues")}`);
    const venues = await listVenues(base, token, slug);
    window.__tabbycatVenues = venues;
    window.__tabbycatVenuesForSlug = String(slug).trim();
    log(
      `  ✓ ${venues.length} Tabbycat room(s) for this slug — CSV venue column matches room name/display (ignoring case); multiple rooms per site use time-based assignment.`
    );
  } catch (e) {
    log(`  ⚠ venues: ${e.message}`, true);
    window.__tabbycatVenuesForSlug = "";
  }

  const q = standingsRound > 0 ? `?round=${standingsRound}` : "";
  log(`  → standings  GET ${apiPath(slug, "/teams/standings")}${q}`);
  const standings = await listTeamStandings(base, token, slug, {
    round: standingsRound > 0 ? standingsRound : undefined,
    metrics: ["points"],
  });
  state.standings = standings;
  window.__standings = standings;
  log(`  ✓ ${standings.length} standings row(s)`);

  let speaksMap = new Map();
  if (standingsRound > 0) {
    log(`  → standings rounds  GET ${apiPath(slug, "/teams/standings/rounds")}`);
    const roundRows = await listTeamStandingsRounds(base, token, slug);
    speaksMap = speaksTotalsFromStandingsRounds(roundRows, standingsRound);
    window.__teamStandingsRounds = roundRows;
    log(`  ✓ ${roundRows.length} row(s) from teams/standings/rounds → speaks totals through round ${standingsRound}`);
  } else {
    window.__teamStandingsRounds = [];
    log(`  → standings rounds  (skipped — round to post is 1)`);
  }
  // Backfill from standings.speaks_sum for any team missing a rounds-based total (covers
  // permission / endpoint-disabled cases where …/teams/standings/rounds came back empty).
  const beforeFill = speaksMap.size;
  speaksMap = speaksTotalsFromStandings(standings, speaksMap);
  const filled = speaksMap.size - beforeFill;
  if (filled > 0) {
    log(`  ✓ filled ${filled} team(s) total speaks from standings speaks_sum metric (fallback).`);
  }
  state.speaksTotalByTeamId = speaksMap;

  if (standingsRound === 0) {
    window.__lastPairings = [];
    window.__pairingsByRound = {};
    window.__pairingsLoadedMaxRound = 0;
    log("  → history  (none — round to post is 1)");
  } else {
    const allPairings = [];
    /** @type {Record<number, object[]>} */
    const pairingsByRound = {};
    for (let r = 1; r <= standingsRound; r++) {
      log(`  → history  GET ${apiPath(slug, `/rounds/${r}/pairings`)}`);
      const pp = await listPairingsForRound(base, token, slug, r);
      pairingsByRound[r] = pp;
      allPairings.push(...pp);
      log(`     round ${r}: ${pp.length} debate(s)`);
    }
    window.__lastPairings = allPairings;
    window.__pairingsByRound = pairingsByRound;
    window.__pairingsLoadedMaxRound = standingsRound;
    log(`  ✓ ${allPairings.length} past debate(s) total`);
  }

  log("━━ Done — next: Action 2 (CSV), then 3 & 4 ━━");
  renderTeamRoster();
  renderByeSection();
}

async function onApplySchedulingCsv() {
  const teams = window.__teams;
  if (!teams?.length) {
    log("Run Action 1 (load tournament) first.", true);
    return;
  }
  const standings = state.standings || [];
  if (!state.standings) {
    log("Warning: standings missing — run Action 1 again.", true);
  }

  rebuildByeTeamIds(teams);

  const pasted = el("csvPaste").value.trim();
  let csvText = pasted;
  if (!csvText) {
    const csvFile = el("csvFile").files[0];
    if (!csvFile) {
      log("Paste CSV or choose a file.", true);
      return;
    }
    csvText = await csvFile.text();
  }
  const { headers } = parseCsv(csvText);
  try {
    assertNoPointsColumns(headers);
  } catch (e) {
    log(e.message, true);
    return;
  }

  let mergeResult;
  try {
    mergeResult = mergeScheduling(teams, standings, csvText, state.byeTeamIds, {
      speaksByTeamId: state.speaksTotalByTeamId || undefined,
    });
  } catch (e) {
    log(e.message, true);
    return;
  }
  const { merged, missing, unmatchedNames, ambiguousNames, csvRowCount, scheduledTeamCount } =
    mergeResult;
  state.missing = missing.filter((m) => {
    if (m?.id == null || state.byeTeamIds.has(m.id)) return false;
    const tr = teams.find((x) => numericTeamId(x) === m.id);
    if (tr && isRetractedOrWithdrawnTeam(tr)) return false;
    return true;
  });
  window.__merged = merged;

  log(`━━ Action 2: Apply scheduling CSV ━━`);
  log(`  ${csvRowCount} CSV row(s) → ${scheduledTeamCount} team id(s) with venue/timeslot.`);
  if (unmatchedNames?.length) {
    log(`Unmatched name(s): ${unmatchedNames.join("; ")}`, true);
  }
  if (ambiguousNames?.length) {
    ambiguousNames.forEach((a) =>
      log(`Ambiguous “${a.name}” → ids ${a.ids.join(", ")}`, true)
    );
  }
  const byReason = (r) => missing.filter((m) => m.reason === r).length;
  if (byReason("no_venue")) log(`${byReason("no_venue")} team(s): empty venue in CSV.`, true);
  if (byReason("no_csv_row")) log(`${byReason("no_csv_row")} team(s): no matching CSV row.`, true);
  if (byReason("no_timeslot")) log(`${byReason("no_timeslot")} team(s): empty timeslot.`, true);
  if (missing.length) {
    el("missingBox").textContent = missing
      .map((m) => {
        const extra = m.reason ? ` (${m.reason})` : "";
        return `${m.id} ${m.rosterLabel || m.short_name || m.long_name}${extra}`;
      })
      .join("\n");
  } else {
    el("missingBox").textContent = "(none)";
    log("All teams have venue + timeslot.");
  }
  renderTeamRoster();
}

function renderTeamRoster() {
  const host = el("teamRoster");
  const teamsAll = window.__teams || [];
  if (!teamsAll.length) {
    host.innerHTML = '<p class="hint">Run Action 1 to load teams.</p>';
    return;
  }

  const teams = teamsAll.filter((t) => !isRetractedOrWithdrawnTeam(t));
  const omitN = teamsAll.length - teams.length;
  if (!teams.length) {
    host.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent =
      omitN > 0
        ? "Every loaded team is omitted from scheduling (names contain [RETRACTED] or [WITHDRAWN])."
        : "No teams to show.";
    host.appendChild(p);
    return;
  }

  if (!ROSTER_SORT_COLS.some((c) => c.key === state.rosterSort.key)) {
    state.rosterSort = { key: null, asc: true };
  }

  const mergedById = new Map();
  if (window.__merged?.length) {
    for (const m of window.__merged) mergedById.set(m.id, m);
  }

  const rows = teams.map((t) => {
    const tid = numericTeamId(t);
    const sm = state.speaksTotalByTeamId;
    const speaksSum = sm && tid != null && sm.has(tid) ? sm.get(tid) : null;
    const mm = tid != null ? mergedById.get(tid) : null;
    const hasSched = mm && mm.venueKey && mm.timeslot;
    const venueCell = hasSched ? mm.venueLabel || mm.venueKey : "—";
    const slotCell = hasSched ? mm.timeslot : "—";
    return {
      team: t,
      id: tid ?? t.id,
      name: teamLabelForCsvRoster(t),
      speaks: speaksSum,
      venue: venueCell,
      timeslot: slotCell,
    };
  });

  const sk = state.rosterSort.key;
  const asc = state.rosterSort.asc;
  if (sk) {
    const col = ROSTER_SORT_COLS.find((c) => c.key === sk);
    const kind = col?.kind ?? "string";
    rows.sort((ra, rb) => {
      if (kind === "number") return cmpRosterNullableNum(ra[sk], rb[sk], asc);
      return cmpRosterString(ra[sk], rb[sk], asc);
    });
  }

  const table = document.createElement("table");
  table.className = "roster-table";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const col of ROSTER_SORT_COLS) {
    const th = document.createElement("th");
    th.textContent = col.label;
    th.className = "sortable";
    th.title = "Click to sort; again to reverse";
    th.scope = "col";
    if (sk === col.key) {
      th.classList.add(asc ? "sort-asc" : "sort-desc");
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
    } else {
      th.setAttribute("aria-sort", "none");
    }
    th.addEventListener("click", () => {
      if (state.rosterSort.key === col.key) state.rosterSort.asc = !state.rosterSort.asc;
      else {
        state.rosterSort.key = col.key;
        state.rosterSort.asc = true;
      }
      renderTeamRoster();
    });
    trh.appendChild(th);
  }
  thead.appendChild(trh);

  const tb = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const t = r.team;
    {
      const tidRow = numericTeamId(t);
      if (tidRow != null && state.byeTeamIds.has(tidRow)) tr.classList.add("row-bye");
    }
    tr.appendChild(td("td", String(r.id)));
    tr.appendChild(td("td", r.name));
    tr.appendChild(td("td", r.speaks != null ? String(r.speaks) : "—"));
    tr.appendChild(td("td", r.venue));
    tr.appendChild(td("td", r.timeslot));
    tb.appendChild(tr);
  }

  table.appendChild(thead);
  table.appendChild(tb);
  host.innerHTML = "";
  if (omitN > 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `${omitN} team(s) omitted from roster and scheduling (name contains [RETRACTED] or [WITHDRAWN]).`;
    host.appendChild(p);
  }
  host.appendChild(table);
}

async function onGenerate() {
  const merged = window.__merged;
  if (!merged?.length) {
    log("Run Action 2 first (apply scheduling CSV).", true);
    return;
  }

  if (!(window.__teams || []).length) {
    log("Run Action 1 first.", true);
    return;
  }
  rebuildByeTeamIds(window.__teams);
  const teamsCached = (window.__teams || []).filter((t) => !isRetractedOrWithdrawnTeam(t));
  const blockingMissing = (state.missing || []).filter(
    (m) => m?.id != null && !state.byeTeamIds.has(m.id)
  );
  if (blockingMissing.length) {
    log("Cannot generate: fix CSV so no teams are missing scheduling.", true);
    return;
  }

  const pairings = window.__lastPairings || [];
  if (!pairings.length && getRound() > 1) {
    log("No debate history in memory — run Action 1 again (or continue if you accept weaker rematch/side data).", true);
  }
  const teamById = new Map();
  for (const t of teamsCached) {
    const tid = numericTeamId(t);
    if (tid != null) teamById.set(tid, t);
  }

  const rematch = buildRematchSet(pairings, state.byeTeamIds);
  const sideHist = buildSideHistory(pairings, state.byeTeamIds);
  const byeHistRaw = buildByeHistory(pairings, state.byeTeamIds, teamById);
  const teamHadBye = new Set(byeHistRaw.teamHadBye);
  const instHadBye = new Set(byeHistRaw.instHadBye);
  augmentByeHistoryWithAbsentFromLoadedRounds(
    teamHadBye,
    instHadBye,
    teamsCached,
    pairingsByRoundForAbsentAugment(),
    state.byeTeamIds,
    teamById
  );
  for (const t of window.__teams || []) {
    if (!isRetractedOrWithdrawnTeam(t)) continue;
    const rid = numericTeamId(t);
    if (rid != null) teamHadBye.delete(rid);
  }
  const manualByeIds = new Set(state.extraByeTeamIds);
  for (const id of manualByeIds) {
    teamHadBye.add(id);
    const t = teamById.get(id);
    if (t) {
      const sk = deriveSchoolKeyFromTeam(t) || t.institution || null;
      if (sk) instHadBye.add(sk);
    }
  }
  const byeHist = { teamHadBye, instHadBye };

  const byePlaceholders = findByePlaceholderTeams(teamsCached);
  const ph0 = byePlaceholders[0];
  const phId = ph0 ? numericTeamId(ph0) : null;
  const byePlaceholder =
    ph0 && phId != null ? { id: phId, url: ph0.url } : null;

  const ctx = {
    mergedTeams: merged,
    rematch,
    sideHist,
    byeHist,
    byePlaceholder,
    instKey,
  };

  log("━━ Action 3: Generate draw (local) ━━");
  if (manualByeIds.size) {
    log(`  Prior bye history: ${manualByeIds.size} extra team(s) from bye section (merged with Tabbycat history).`);
  }
  const { debates, warnings } = generateDraw(ctx);
  state.warnings = warnings;
  debates.forEach((d, i) => {
    d._idx = i;
    d.posted = false;
    syncDebatePairingMetadata(d);
  });
  const roomVenues = venuesForRoomPicker();
  const resolver = buildVenueResolver(roomVenues);
  const roomWarnings = assignTabbycatVenuesToDebates(debates, resolver);
  state.debates = debates;

  warnings.forEach((w) => log(w, true));
  roomWarnings.forEach((w) => log(w, true));
  if (!roomVenues.length) {
    log(
      "No Tabbycat rooms for the current tournament slug — run Action 1 with the same slug as in the field above (rooms are scoped to that competition only).",
      true
    );
  }
  log(`Generated ${debates.length} debate(s).`);
  renderTable();
}

/** venueKey -> { displayLabel, slots: Map(timeslot -> debates[]) } */
function groupDebates(debates) {
  const byVenue = new Map();
  for (const d of debates) {
    const vk = d.venueKey ?? "";
    if (!byVenue.has(vk)) {
      byVenue.set(vk, { displayLabel: d.venueLabel || vk, slots: new Map() });
    }
    const entry = byVenue.get(vk);
    if (d.venueLabel && d.venueLabel.length >= (entry.displayLabel || "").length) {
      entry.displayLabel = d.venueLabel;
    }
    const tsM = entry.slots;
    const tsKey = normalizeDebateTimeslotKey(d.timeslot);
    if (!tsM.has(tsKey)) tsM.set(tsKey, []);
    tsM.get(tsKey).push(d);
  }
  return byVenue;
}

function normalizeDebateTimeslotKey(ts) {
  if (ts === null || ts === undefined) return "";
  return sanitizeCsvCell(String(ts));
}

/** Fill `state.venueDates` from WADL staff-draw calendar for rounds 1–5; respects manual overrides. */
function applyWadlVenueDatesForDraw(round) {
  if (!state.debates?.length) return;
  if (round < 1 || round > 5) return;

  const prev = state.wadlVenueDatesLastRound;
  if (prev !== round) {
    for (const vk of [...state.venueDateAutoKeys]) {
      const ymd = wadlScheduledDateYmd(round, vk);
      if (ymd) state.venueDates.set(vk, ymd);
      else {
        state.venueDates.delete(vk);
        state.venueDateAutoKeys.delete(vk);
      }
    }
    state.wadlVenueDatesLastRound = round;
  }

  const byVenue = groupDebates(state.debates);
  for (const vk of byVenue.keys()) {
    const ymd = wadlScheduledDateYmd(round, vk);
    if (!ymd) continue;
    if (!state.venueDates.has(vk) || state.venueDateAutoKeys.has(vk)) {
      state.venueDates.set(vk, ymd);
      state.venueDateAutoKeys.add(vk);
    }
  }
}

/** Stable chronological-ish order: 5.15 before 6.15, 6:15 before 7:15. */
function sortedTimeslotEntries(tsMap) {
  const toNum = (s) => {
    const x = String(s ?? "").replace(/,/g, ".").replace(/:/g, ".");
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : null;
  };
  return [...tsMap.entries()].sort(([a], [b]) => {
    const sa = String(a ?? "");
    const sb = String(b ?? "");
    const na = toNum(sa);
    const nb = toNum(sb);
    if (na != null && nb != null && na !== nb) return na - nb;
    return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
  });
}

function formatTimeslotHeading(ts) {
  if (ts === null || ts === undefined) return "(no time)";
  const s = sanitizeCsvCell(String(ts));
  return s || "(no time)";
}

function setIncludedForVenue(venueKey, value) {
  for (const d of state.debates) {
    if (d.venueKey === venueKey) d.included = value;
  }
  renderTable();
}

function setIncludedForSlot(venueKey, timeslot, value) {
  for (const d of state.debates) {
    if (d.venueKey === venueKey && normalizeDebateTimeslotKey(d.timeslot) === timeslot) d.included = value;
  }
  renderTable();
}

function sideTeamFromDebate(d, side) {
  return side === "aff" ? d.aff : d.neg;
}

function sideValueFromDebate(d, side) {
  return sideSelectValue(sideTeamFromDebate(d, side));
}

function teamFromPickValue(selectValue, pickList) {
  const pick = pickList.find((p) => p.value === selectValue);
  return pick ? pick.team : null;
}

function validateDebateSides(nextAff, nextNeg) {
  if (nextAff?.id === nextNeg?.id && !nextAff?.isPlaceholder) return "Aff and neg cannot be the same team.";
  const a = Boolean(nextAff?.isPlaceholder);
  const b = Boolean(nextNeg?.isPlaceholder);
  if (a && b) return "Cannot set both sides to BYE.";
  return "";
}

function commitDebateSides(d, nextAff, nextNeg) {
  const a = Boolean(nextAff?.isPlaceholder);
  const b = Boolean(nextNeg?.isPlaceholder);
  d.aff = nextAff;
  d.neg = nextNeg;
  d.kind = a !== b ? "bye" : "debate";
  d.manuallyEdited = true;
  if (d.kind === "bye") {
    d.auxScheduleNotes = [];
    d.powerMeta = null;
    d._generatedTeamKey = "";
    d.note = "Bye — one side is the BYE placeholder (edited in UI).";
  }
  syncDebatePairingMetadata(d);
}

function applyTeamDragDrop(targetDebate, targetSide, pickList) {
  if (!teamDragPayload || targetDebate.posted) return;
  const src = teamDragPayload;
  const srcDebate = state.debates.find((x) => (x._idx ?? -1) === src.debateIdx);
  if (!srcDebate || srcDebate.posted) return;
  if (src.debateIdx === (targetDebate._idx ?? -1) && src.side === targetSide) return;

  const sourceValue = src.value;
  const targetValue = sideValueFromDebate(targetDebate, targetSide);
  const sourceTeam = teamFromPickValue(sourceValue, pickList);
  const targetTeam = teamFromPickValue(targetValue, pickList);
  if (!sourceTeam || !targetTeam) return;

  const targetNextAff = targetSide === "aff" ? sourceTeam : targetDebate.aff;
  const targetNextNeg = targetSide === "neg" ? sourceTeam : targetDebate.neg;
  const sourceNextAff = src.side === "aff" ? targetTeam : srcDebate.aff;
  const sourceNextNeg = src.side === "neg" ? targetTeam : srcDebate.neg;

  const errTarget = validateDebateSides(targetNextAff, targetNextNeg);
  if (errTarget) {
    log(errTarget, true);
    renderTable();
    return;
  }
  const errSource = validateDebateSides(sourceNextAff, sourceNextNeg);
  if (errSource) {
    log(errSource, true);
    renderTable();
    return;
  }

  commitDebateSides(targetDebate, targetNextAff, targetNextNeg);
  commitDebateSides(srcDebate, sourceNextAff, sourceNextNeg);
  renderTable();
}

function makeSideTeamChip(d, side, pickList) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "draw-team-chip";
  const t = sideTeamFromDebate(d, side);
  chip.textContent = t?.csvLabel || t?.short_name || t?.long_name || "—";
  chip.title = d.posted
    ? "Posted debate — team locked."
    : "Drag this chip onto another Aff/Neg slot to replace/swap.";
  chip.disabled = Boolean(d.posted);
  chip.draggable = !d.posted;
  if (t?.isPlaceholder) chip.classList.add("is-bye");

  if (!d.posted) {
    chip.addEventListener("dragstart", (e) => {
      teamDragPayload = { debateIdx: d._idx ?? -1, side, value: sideValueFromDebate(d, side) };
      try {
        e.dataTransfer.setData("text/plain", `${teamDragPayload.debateIdx}:${side}`);
      } catch {
        // no-op
      }
      e.dataTransfer.effectAllowed = "move";
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => {
      teamDragPayload = null;
      chip.classList.remove("dragging");
    });
  }

  return chip;
}

function debateSideSelectCell(d, side, pickList) {
  const tdS = document.createElement("td");
  tdS.className = "draw-side-td";
  if (!d.posted) {
    tdS.addEventListener("dragover", (e) => {
      e.preventDefault();
      tdS.classList.add("drop-target");
    });
    tdS.addEventListener("dragleave", () => tdS.classList.remove("drop-target"));
    tdS.addEventListener("drop", (e) => {
      e.preventDefault();
      tdS.classList.remove("drop-target");
      applyTeamDragDrop(d, side, pickList);
    });
  }

  const chip = makeSideTeamChip(d, side, pickList);
  tdS.appendChild(chip);

  const sel = document.createElement("select");
  sel.className = "draw-side-select";
  sel.disabled = Boolean(d.posted);
  for (const p of pickList) {
    const opt = document.createElement("option");
    opt.value = p.value;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  const cur = sideSelectValue(side === "aff" ? d.aff : d.neg);
  sel.value = cur;
  if (![...sel.options].some((o) => o.value === sel.value)) {
    const sideObj = side === "aff" ? d.aff : d.neg;
    const opt = document.createElement("option");
    opt.value = cur;
    opt.textContent = (sideObj?.csvLabel ?? sideObj?.short_name ?? cur) || "?";
    sel.appendChild(opt);
    sel.value = cur;
  }
  sel.addEventListener("change", () => applyDebateSideChange(d, side, sel.value, pickList));
  tdS.appendChild(sel);
  const meta = document.createElement("div");
  meta.className = "draw-team-meta";
  const t = side === "aff" ? d.aff : d.neg;
  if (t?.isPlaceholder) meta.textContent = "—";
  else if (t) {
    const sp = t.speaks != null && Number.isFinite(Number(t.speaks)) ? String(t.speaks) : "?";
    const pt = t.points != null && Number.isFinite(Number(t.points)) ? String(t.points) : "?";
    meta.textContent = `${sp} total speaks (draw uses speaks only; ${pt} wins shown for info)`;
  }
  tdS.appendChild(meta);
  return tdS;
}

function drawNoteCell(d) {
  const td = document.createElement("td");
  td.className = "draw-note-td";
  if (d.kind !== "debate") {
    td.textContent = d.note || "";
    return td;
  }
  const clashes = d.pairingClashes || [];
  if (!clashes.length) {
    const span = document.createElement("span");
    span.className = "note-clean";
    span.textContent = "No soft conflicts flagged (rematch / power / inst / sides).";
    span.title =
      "No rematch in loaded Tabbycat history, no bracket or floater deviation recorded, no same-institution key, and side history does not force a suboptimal aff/neg orientation.";
    td.appendChild(span);
    return td;
  }
  const wrap = document.createElement("div");
  wrap.className = "clash-pill-wrap";
  for (const c of clashes) {
    const span = document.createElement("span");
    span.className = `clash-pill clash-kind-${c.kind}`;
    span.textContent = c.short;
    span.title = c.detail;
    wrap.appendChild(span);
  }
  td.appendChild(wrap);
  return td;
}

/** Venues from Action 1 only when slug still matches (GET …/tournaments/{slug}/venues). */
function venuesForRoomPicker() {
  const slug = getSlug().trim();
  const loaded = window.__tabbycatVenuesForSlug;
  if (!slug || !loaded || loaded !== slug) return [];
  return window.__tabbycatVenues || [];
}

function venueRoomSearchHaystack(v) {
  const parts = [
    venuePickerLabel(v),
    venueDisplayLabel(v),
    v.name,
    v.id != null ? String(v.id) : "",
  ];
  return parts
    .filter((x) => x != null && String(x).trim() !== "" && String(x) !== "—")
    .map((x) => String(x).toLowerCase());
}

function venuesMatchingRoomSearch(raw) {
  const q = String(raw || "").trim().toLowerCase();
  const venues = venuesForRoomPicker();
  if (!venues.length || !q) return [];
  const scored = [];
  for (const v of venues) {
    const idStr = v.id != null ? String(v.id) : "";
    const hay = venueRoomSearchHaystack(v);
    const pk = venuePickerLabel(v).toLowerCase();
    let score = 0;
    if (idStr === q) score = 99;
    else if (idStr.startsWith(q)) score = 78;
    if (pk === q) score = 100;
    else if (pk.startsWith(q)) score = Math.max(score, 88);
    else if (hay.some((h) => h === q)) score = Math.max(score, 95);
    else if (hay.some((h) => h.startsWith(q))) score = Math.max(score, 82);
    else if (hay.some((h) => h.includes(q))) score = Math.max(score, 50);
    else if (idStr.includes(q)) score = Math.max(score, 45);
    if (score <= 0) continue;
    scored.push({ v, score });
  }
  scored.sort((a, b) => b.score - a.score || (Number(a.v.id) || 0) - (Number(b.v.id) || 0));
  return scored.slice(0, 15).map((x) => x.v);
}

function hideAllRoomAcListsExcept(keepUl) {
  const root = el("drawTable");
  if (!root) return;
  root.querySelectorAll("ul.ac-suggestions").forEach((u) => {
    if (u !== keepUl) {
      u.hidden = true;
      u.innerHTML = "";
    }
  });
}

function showRoomSuggestionsFromInput(input, ul) {
  if (roomAllocBlurTimer) {
    clearTimeout(roomAllocBlurTimer);
    roomAllocBlurTimer = null;
  }
  const list = venuesMatchingRoomSearch(input.value);
  roomAllocHighlight = list.length ? 0 : -1;
  ul.innerHTML = "";
  if (!list.length) {
    ul.hidden = true;
    return;
  }
  ul.hidden = false;
  list.forEach((v, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.className = i === roomAllocHighlight ? "active" : "";
    li.textContent = venuePickerLabel(v);
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      applyRoomChoice(input.__roomDebate, input, ul, v);
    });
    ul.appendChild(li);
  });
}

function refreshRoomAllocHighlight(ul) {
  if (ul.hidden) return;
  ul.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("active", i === roomAllocHighlight);
  });
}

function applyRoomChoice(d, input, ul, v) {
  if (roomAllocBlurTimer) {
    clearTimeout(roomAllocBlurTimer);
    roomAllocBlurTimer = null;
  }
  d.venueUrl = venueSelfUrl(v);
  d.tabbycatVenueDisplay = venueDisplayLabel(v);
  delete d.tabbycatVenueNote;
  input.value = venuePickerLabel(v);
  ul.hidden = true;
  ul.innerHTML = "";
  renderTable();
}

function hideRoomAllocSuggestionsSoon(ul, input, d) {
  if (roomAllocBlurTimer) clearTimeout(roomAllocBlurTimer);
  roomAllocBlurTimer = setTimeout(() => {
    roomAllocBlurTimer = null;
    ul.hidden = true;
    ul.innerHTML = "";
    commitDebateRoomInput(d, input);
  }, 180);
}

function bindRoomAllocControls(input, ul, d) {
  input.__roomDebate = d;

  ul.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });

  input.addEventListener("focus", () => {
    if (roomAllocBlurTimer) {
      clearTimeout(roomAllocBlurTimer);
      roomAllocBlurTimer = null;
    }
    hideAllRoomAcListsExcept(ul);
    showRoomSuggestionsFromInput(input, ul);
  });

  input.addEventListener("input", () => {
    roomAllocHighlight = 0;
    showRoomSuggestionsFromInput(input, ul);
  });

  input.addEventListener("blur", () => hideRoomAllocSuggestionsSoon(ul, input, d));

  input.addEventListener("keydown", (e) => {
    const list = venuesMatchingRoomSearch(input.value);
    if (e.key === "Escape") {
      ul.hidden = true;
      ul.innerHTML = "";
      e.preventDefault();
      return;
    }
    if (!list.length) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitDebateRoomInput(d, input);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      roomAllocHighlight = Math.min(list.length - 1, roomAllocHighlight + 1);
      refreshRoomAllocHighlight(ul);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      roomAllocHighlight = Math.max(0, roomAllocHighlight - 1);
      refreshRoomAllocHighlight(ul);
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx =
        roomAllocHighlight >= 0 && roomAllocHighlight < list.length ? roomAllocHighlight : 0;
      applyRoomChoice(d, input, ul, list[idx]);
    }
  });
}

function debateRoomInputValue(d) {
  if (!d.venueUrl) return d.tabbycatVenueDisplay || "";
  const v = venuesForRoomPicker().find((x) => venueSelfUrl(x) === d.venueUrl);
  if (v) return venuePickerLabel(v);
  return d.tabbycatVenueDisplay || "";
}

function renderTable() {
  const host = el("drawTable");
  const debates = state.debates;
  if (!debates.length) {
    host.innerHTML = "<p>No draw yet.</p>";
    return;
  }

  applyWadlVenueDatesForDraw(getRound());

  const pickList = mergedTeamPickList();

  const byVenue = groupDebates(debates);
  const frag = document.createDocumentFragment();

  for (const [venueKey, { displayLabel, slots: tsMap }] of byVenue) {
    const vwrap = document.createElement("div");
    vwrap.className = "venue-block";
    const vname = displayLabel || venueKey || "(venue)";
    const vhead = document.createElement("h3");
    const vcb = document.createElement("input");
    vcb.type = "checkbox";
    vcb.checked = [...tsMap.values()].flat().every((d) => d.included);
    vcb.title = "Include all debates in this venue group";
    vcb.addEventListener("change", () => setIncludedForVenue(venueKey, vcb.checked));
    vhead.appendChild(vcb);
    vhead.appendChild(document.createTextNode(` ${vname}`));
    vwrap.appendChild(vhead);

    const dateRow = document.createElement("div");
    dateRow.className = "venue-date-row";
    const dateLabel = document.createElement("label");
    dateLabel.className = "venue-date-label";
    dateLabel.appendChild(document.createTextNode("Debate date: "));
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = state.venueDates.get(venueKey) || "";
    dateInput.title =
      "All debates in this venue adopt this date. Each timeslot (5.15pm / 6.15pm / 7.15pm) contributes its own clock time — combined they form the scheduled_at sent on POST.";
    dateInput.addEventListener("change", () => {
      const v = dateInput.value;
      if (v) state.venueDates.set(venueKey, v);
      else state.venueDates.delete(venueKey);
      state.venueDateAutoKeys.delete(venueKey);
      renderTable();
    });
    dateLabel.appendChild(dateInput);
    dateRow.appendChild(dateLabel);
    const dateHint = document.createElement("span");
    dateHint.className = "venue-date-hint";
    const hasDate = Boolean(state.venueDates.get(venueKey));
    const auto = state.venueDateAutoKeys.has(venueKey);
    dateHint.textContent = hasDate
      ? auto
        ? "→ each debate posts with scheduled_at set from this date + its timeslot. (WADL calendar for this round — change date to stop following round changes.)"
        : "→ each debate posts with scheduled_at set from this date + its timeslot."
      : "(leave blank to post debates without a scheduled start time)";
    dateRow.appendChild(dateHint);
    vwrap.appendChild(dateRow);

    for (const [ts, dlist] of sortedTimeslotEntries(tsMap)) {
      const swrap = document.createElement("div");
      swrap.className = "slot-block";
      const head = document.createElement("div");
      head.className = "slot-heading";
      const scb = document.createElement("input");
      scb.type = "checkbox";
      scb.checked = dlist.every((d) => d.included);
      scb.title = "Include all debates in this timeslot";
      scb.addEventListener("change", () => setIncludedForSlot(venueKey, ts, scb.checked));
      head.appendChild(scb);
      const title = document.createElement("span");
      title.className = "slot-title";
      title.textContent = `Timeslot: ${formatTimeslotHeading(ts)}`;
      head.appendChild(title);
      const schedIso = buildScheduledAt(state.venueDates.get(venueKey) || "", ts);
      if (schedIso) {
        const schedTag = document.createElement("span");
        schedTag.className = "slot-scheduled";
        schedTag.textContent = ` → ${formatScheduledAtLocal(schedIso)}`;
        schedTag.title = `scheduled_at sent on POST: ${schedIso}`;
        head.appendChild(schedTag);
      } else if (state.venueDates.get(venueKey) && ts) {
        const warnTag = document.createElement("span");
        warnTag.className = "slot-scheduled-warn";
        warnTag.textContent = " (timeslot not recognised as a clock time — no scheduled_at on POST)";
        warnTag.title = `Could not parse “${ts}” as a time — valid examples: 5.15 / 5:15 / 5.15pm / 17:15.`;
        head.appendChild(warnTag);
      }
      swrap.appendChild(head);

      const table = document.createElement("table");
      table.className = "draw-table";
      table.innerHTML =
        "<thead><tr><th>✓</th><th>Type</th><th>Room (Tabbycat)</th><th>Affirmative</th><th></th><th>Negative</th><th>Notes (pairing)</th><th>Posted</th></tr></thead>";
      const tb = document.createElement("tbody");
      let prevBracketSection = null;
      for (const d of dlist) {
        if (d.kind === "debate") syncDebatePairingMetadata(d);
        const sec = d.bracketSectionId ?? "";
        if (sec && sec !== prevBracketSection) {
          const hr = document.createElement("tr");
          hr.className = "bracket-subhead";
          const htd = document.createElement("td");
          htd.colSpan = 8;
          htd.className = "bracket-subhead-cell";
          htd.textContent = d.bracketSectionLabel || sec;
          if (d.bracketSectionHover) htd.title = d.bracketSectionHover;
          hr.appendChild(htd);
          tb.appendChild(hr);
          prevBracketSection = sec;
        }
        const tr = document.createElement("tr");
        if (!d.included) tr.classList.add("row-off");
        if (d.kind === "debate") {
          if (d.pairingRematch) tr.classList.add("draw-row-rematch");
          else if (d.pairingPowerIssue) tr.classList.add("draw-row-power");
          else if (d.pairingSameInst) tr.classList.add("draw-row-same-inst");
        }
        const td0 = document.createElement("td");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = d.included;
        cb.addEventListener("change", () => {
          d.included = cb.checked;
          renderTable();
        });
        td0.appendChild(cb);
        tr.appendChild(td0);
        tr.appendChild(td("td", d.kind));
        tr.appendChild(tabbycatRoomCell(d));
        tr.appendChild(debateSideSelectCell(d, "aff", pickList));
        const tdSwap = document.createElement("td");
        tdSwap.className = "td-swap";
        if (!d.posted) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "small btn-swap";
          btn.textContent = "⇄";
          btn.title = "Swap affirmative / negative";
          btn.addEventListener("click", () => swapDebateSides(d));
          tdSwap.appendChild(btn);
        }
        tr.appendChild(tdSwap);
        tr.appendChild(debateSideSelectCell(d, "neg", pickList));
        tr.appendChild(drawNoteCell(d));
        tr.appendChild(td("td", d.posted ? "yes" : "no"));
        tb.appendChild(tr);
      }
      table.appendChild(tb);
      swrap.appendChild(table);
      vwrap.appendChild(swrap);
    }
    frag.appendChild(vwrap);
  }

  host.innerHTML = "";
  host.appendChild(frag);
}

function td(tag, text) {
  const c = document.createElement(tag);
  c.textContent = text;
  return c;
}

function commitDebateRoomInput(d, input) {
  const trimmed = sanitizeCsvCell(input.value);
  const canonical = sanitizeCsvCell(debateRoomInputValue(d));
  if (trimmed === canonical) return;

  if (!trimmed) {
    delete d.venueUrl;
    delete d.tabbycatVenueDisplay;
    delete d.tabbycatVenueNote;
    renderTable();
    return;
  }

  const venues = venuesForRoomPicker();
  if (!venues.length) {
    log(
      "Room list is empty for this slug — run Action 1 with the same tournament slug (only that competition’s rooms are used).",
      true
    );
    renderTable();
    return;
  }

  const pick = resolveVenueFromPickerInput(trimmed, venues);
  if (pick) {
    d.venueUrl = venueSelfUrl(pick);
    d.tabbycatVenueDisplay = venueDisplayLabel(pick);
    delete d.tabbycatVenueNote;
    renderTable();
    return;
  }
  log(`Room “${trimmed}” did not match a unique venue for this tournament — pick from the list below or use “Name (#id)”.`, true);
  renderTable();
}

function tabbycatRoomCell(d) {
  const cell = document.createElement("td");
  cell.className = "draw-room-td";

  if (d.posted) {
    cell.textContent = d.tabbycatVenueDisplay || "—";
    if (d.venueUrl) cell.title = d.venueUrl;
    if (d.tabbycatVenueNote) {
      const tag = document.createElement("span");
      tag.className = "room-reuse-warn";
      tag.textContent = " ⚠";
      tag.title = d.tabbycatVenueNote;
      cell.appendChild(tag);
    }
    return cell;
  }

  const wrap = document.createElement("div");
  wrap.className = "room-input-wrap";

  const field = document.createElement("div");
  field.className = "bye-search-field";

  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "Search room…";
  input.value = debateRoomInputValue(d);
  input.title =
    "Rooms from Action 1 for the current tournament slug only. Type to filter; click a suggestion or press Enter. Clear to post without a venue.";

  const ul = document.createElement("ul");
  ul.className = "ac-suggestions";
  ul.hidden = true;
  ul.setAttribute("role", "listbox");

  bindRoomAllocControls(input, ul, d);

  field.appendChild(input);
  field.appendChild(ul);
  wrap.appendChild(field);

  if (d.tabbycatVenueNote) {
    const tag = document.createElement("span");
    tag.className = "room-reuse-warn";
    tag.textContent = " ⚠";
    tag.title = d.tabbycatVenueNote;
    wrap.appendChild(tag);
  }

  cell.appendChild(wrap);
  return cell;
}

function parseExcludedIds() {
  state.excludedTeamIds = parseIdListText(el("excludeTeams").value);
}

const BYE_SELECT_VALUE = "__bye_placeholder__";

function byePlaceholderSideTeam() {
  const teams = window.__teams;
  if (!teams?.length) return null;
  const ph = findByePlaceholderTeams(teams)[0];
  if (!ph) return null;
  return {
    id: ph.id,
    url: ph.url,
    short_name: "BYE",
    long_name: "BYE",
    csvLabel: "BYE",
    isPlaceholder: true,
  };
}

function mergedTeamPickList() {
  const list = (window.__merged || []).map((m) => {
    const sp = m.speaks != null && Number.isFinite(Number(m.speaks)) ? String(m.speaks) : "?";
    const base = m.csvLabel || m.short_name || `Team ${m.id}`;
    return {
      value: String(m.id),
      team: m,
      label: `${base} — ${sp} spk`,
    };
  });
  const ph = byePlaceholderSideTeam();
  if (ph) {
    list.unshift({
      value: BYE_SELECT_VALUE,
      team: ph,
      label: "BYE (placeholder)",
    });
  }
  return list;
}

function sideSelectValue(side) {
  if (!side) return "";
  if (side.isPlaceholder) return BYE_SELECT_VALUE;
  return String(side.id);
}

function applyDebateSideChange(d, side, selectValue, pickList) {
  if (d.posted) return;
  const nextTeam = teamFromPickValue(selectValue, pickList);
  if (!nextTeam) return;
  const nextAff = side === "aff" ? nextTeam : d.aff;
  const nextNeg = side === "neg" ? nextTeam : d.neg;
  const err = validateDebateSides(nextAff, nextNeg);
  if (err) {
    log(err, true);
    renderTable();
    return;
  }
  commitDebateSides(d, nextAff, nextNeg);
  renderTable();
}

function swapDebateSides(d) {
  if (d.posted) return;
  commitDebateSides(d, d.neg, d.aff);
  renderTable();
}

async function onPostSelected() {
  parseExcludedIds();
  const base = getBaseUrl();
  const token = getToken();
  const slug = getSlug();
  const round = getRound();
  const toPost = state.debates.filter(
    (d) => d.included && !d.posted && !involvesExcluded(d)
  );
  if (!toPost.length) {
    log("Nothing to post (check selection / already posted / excluded teams).", true);
    return;
  }
  const dupRooms = stripDuplicateRoomUrlsInPostOrder(toPost);
  if (dupRooms > 0) {
    log(
      `${dupRooms} debate(s) shared the same Tabbycat room as an earlier selected row — room cleared on those extras (one debate per room per round). Assign spare rooms in Tabbycat if needed.`
    );
  }
  const withScheduled = toPost.filter((d) => scheduledAtForDebate(d)).length;
  const withoutScheduled = toPost.length - withScheduled;
  if (withScheduled > 0) {
    log(`  ${withScheduled} of ${toPost.length} debate(s) will POST with scheduled_at (venue date + timeslot).`);
  }
  if (withoutScheduled > 0) {
    log(
      `  ${withoutScheduled} debate(s) will POST without scheduled_at (no venue date picked, or timeslot unparseable).`
    );
  }
  log(`━━ Action: Post ${toPost.length} debate(s) to round ${round} on Tabbycat ━━`);
  let ok = 0;
  let fail = 0;
  for (const d of toPost) {
    try {
      const { retriedWithoutVenue } = await tryCreatePairingWithVenueFallback(base, token, slug, round, d);
      d.posted = true;
      ok++;
      const roomBit = d.venueUrl && d.tabbycatVenueDisplay ? ` — room: ${d.tabbycatVenueDisplay}` : "";
      const retryBit = retriedWithoutVenue ? " [posted without room after venue rejected]" : "";
      const schedIso = scheduledAtForDebate(d);
      const schedBit = schedIso ? ` — scheduled: ${formatScheduledAtLocal(schedIso)}` : "";
      log(
        `OK: ${d.poolLabel} — ${d.aff?.csvLabel ?? d.aff?.short_name} vs ${d.neg?.csvLabel ?? d.neg?.short_name}${roomBit}${schedBit}${retryBit}`
      );
    } catch (e) {
      fail++;
      log(`FAIL: ${e.message}`, true);
    }
  }
  if (fail > 0) {
    log(`Posted ${ok} of ${toPost.length} (${fail} failed). See FAIL lines above.`, true);
  } else {
    log(`✓ Finished: ${ok} debate(s) posted.`);
  }
  renderTable();
}

async function onDestroyDraw() {
  const round = getRound();
  const slug = getSlug();
  const ok = window.prompt(
    `Type the round number ${round} to DELETE ALL pairings for this round on ${slug}:`
  );
  if (ok !== String(round)) {
    log("Destroy cancelled.", true);
    return;
  }
  const base = getBaseUrl();
  const token = getToken();
  try {
    log(`━━ Action: Clear entire draw for round ${round} ━━`);
    const clearInfo = await deleteAllPairings(base, token, slug, round);
    log(`✓ All pairings removed for round ${round}.`);
    if (clearInfo?.via === "per-debate") {
      log(
        `  Note: bulk DELETE on …/pairings failed or was rejected; cleared ${clearInfo.count} debate(s) one-by-one instead.`
      );
    }
    state.debates.forEach((d) => {
      d.posted = false;
    });
    renderTable();
  } catch (e) {
    log(e.message, true);
  }
}

function onExportCsv() {
  if (!state.debates.length) return;
  log("━━ Action: Download draw as CSV ━━");
  for (const d of state.debates) {
    d._scheduledAt = scheduledAtForDebate(d) || "";
  }
  downloadText(`draw-${getSlug()}-r${getRound()}.csv`, debatesToCsv(state.debates));
  log("✓ File download started.");
}

function onPresetSlug(s) {
  el("slug").value = s;
}

function bindClick(id, handler) {
  const n = el(id);
  if (n) n.addEventListener("click", handler);
  else console.error(`Tabbycat helper: missing element #${id}`);
}

function init() {
  bindClick("btnLoadTournament", () =>
    onLoadTournamentData().catch((e) => log(e.message, true))
  );
  bindClick("btnApplyCsv", () => onApplySchedulingCsv().catch((e) => log(e.message, true)));
  bindClick("btnGen", () => onGenerate().catch((e) => log(e.message, true)));
  bindClick("btnPost", () => onPostSelected().catch((e) => log(e.message, true)));
  bindClick("btnDestroy", () => onDestroyDraw().catch((e) => log(e.message, true)));
  bindClick("btnExport", onExportCsv);

  const exemptInp = el("schedulingExemptTeamIds");
  if (exemptInp) {
    exemptInp.addEventListener("change", () => {
      const teams = window.__teams;
      if (!teams?.length) return;
      rebuildByeTeamIds(teams);
      renderTeamRoster();
    });
  }
  bindClick("btnPresetNov", () => onPresetSlug("sdcnov26"));
  bindClick("btnPresetJnr", () => onPresetSlug("sdcjnr26"));
  bindClick("btnPresetSnr", () => onPresetSlug("sdcsnr26"));

  document.querySelectorAll('input[name="basePreset"]').forEach((r) => {
    r.addEventListener("change", () => {
      const bm = el("baseManual");
      if (bm) bm.disabled = r.value !== "custom";
    });
  });
  const bm = el("baseManual");
  const checked = document.querySelector('input[name="basePreset"]:checked');
  if (bm) bm.disabled = checked ? checked.value !== "custom" : true;

  bindClick("btnClearLog", () => {
    const logEl = el("log");
    if (logEl) logEl.innerHTML = "";
  });

  const roundInp = el("round");
  if (roundInp) {
    roundInp.addEventListener("change", () => {
      if (state.debates?.length) renderTable();
    });
  }

  try {
    initByeSectionControls();
    renderByeSection();
  } catch (e) {
    console.error("Bye section init failed (load tournament still works):", e);
  }
}

init();
