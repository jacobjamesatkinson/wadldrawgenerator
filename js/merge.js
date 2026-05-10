/**
 * Parse scheduling CSV and merge onto API team rows. Never applies points from CSV.
 */

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function parseCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => {
      row[h] = cells[j] ?? "";
    });
    rows.push(row);
  }
  return { headers, rows };
}

/** Standings columns that must not override the API (score is allowed but ignored). */
const FORBIDDEN_POINT_KEYS = new Set([
  "points",
  "wins",
  "speaks",
  "speaks_sum",
  "speaks_avg",
  "metric",
]);

function isByeLikeTeamName(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;
  if (s === "bye") return true;
  const n = normName(raw);
  if (n === "bye" || n === "bye team") return true;
  if (n.startsWith("bye ") || n.endsWith(" bye")) return true;
  if (n.includes(" bye ") || n.includes(" bye-") || n.startsWith("bye-")) return true;
  return false;
}

/** True if team name fields contain anonymised / withdrawn markers (scheduling + bye logic skip these entirely). */
export function isRetractedOrWithdrawnTeam(team) {
  if (!team) return false;
  const parts = [
    team.short_name,
    team.short_reference,
    team.reference,
    team.long_name,
    team.code_name,
  ];
  for (const raw of parts) {
    const s = String(raw || "").toLowerCase();
    if (s.includes("[retracted]") || s.includes("[withdrawn]")) return true;
  }
  return false;
}

/** Tabbycat phantom / flex teams: BYE and bye-like names (no venue×timeslot pool). */
export function findByePlaceholderTeams(teams) {
  return teams.filter((t) => !isRetractedOrWithdrawnTeam(t)).filter((t) => {
    return (
      isByeLikeTeamName(t.code_name) ||
      isByeLikeTeamName(t.short_name) ||
      isByeLikeTeamName(t.short_reference) ||
      isByeLikeTeamName(t.reference) ||
      isByeLikeTeamName(t.long_name)
    );
  });
}

export function assertNoPointsColumns(headers) {
  const bad = headers.filter((h) => FORBIDDEN_POINT_KEYS.has(h));
  if (bad.length)
    throw new Error(
      `CSV must not contain standings columns (remove: ${bad.join(", ")}). Points come only from the API.`
    );
}

function normName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Remove BOM, zero-width chars, NBSP — common in Excel/Sheets exports. Those can make a “timeslot”
 * cell look empty in the draw (truthy string of invisible chars) while later rows look fine.
 */
export function sanitizeCsvCell(s) {
  return String(s || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

/** Numeric Tabbycat team id from API row (string-safe; falls back to url). */
function teamIdFromApiRow(t) {
  if (!t) return null;
  if (t.id !== undefined && t.id !== null && String(t.id).trim() !== "") {
    const n = typeof t.id === "number" ? t.id : parseInt(String(t.id), 10);
    if (!Number.isNaN(n)) return n;
  }
  if (!t.url) return null;
  const m = String(t.url).match(/\/teams\/(\d+)\/?$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Roster / CSV hint label: Tabbycat short_name (not code_name — different fields). */
export function teamLabelForCsvRoster(t) {
  const s = String(t.short_name || "").trim();
  if (s) return s;
  const sr = String(t.short_reference || "").trim();
  if (sr) return sr;
  const r = String(t.reference || "").trim();
  if (r) return r;
  const ln = String(t.long_name || "").trim();
  if (ln) return ln;
  const c = String(t.code_name || "").trim();
  if (c) return c;
  return "—";
}

/** Normalized keys to match CSV team_name (short_name first; code_name still accepted for alternate CSVs). */
function csvMatchKeysForTeam(t) {
  const out = [];
  const push = (x) => {
    const v = normName(x);
    if (v && !out.includes(v)) out.push(v);
  };
  push(t.short_name);
  push(t.short_reference);
  push(t.reference);
  push(t.long_name);
  push(t.code_name);
  return out;
}

/**
 * School / institution key from the text before the trailing team number, e.g.
 * "Perth Modern 1" → "perth modern", "Hale 1" → "hale". Used for same-school pairing and bye rules.
 */
export function deriveSchoolKeyFromTeam(team) {
  const fields = [
    team.short_name,
    team.short_reference,
    team.reference,
    team.long_name,
    team.code_name,
  ].filter(Boolean);
  for (const raw of fields) {
    if (!raw) continue;
    const s = String(raw).trim().replace(/\s+/g, " ");
    const m = s.match(/^(.+?)\s+(\d+)$/);
    if (m) return normName(m[1]);
  }
  const first = fields.find(Boolean);
  return first ? normName(String(first)) : null;
}

/**
 * Match CSV team_name to Tabbycat team: short_name first, then reference / long_name, then code_name.
 */
export function matchTeamByDisplayName(teams, rawName, byeTeamIds) {
  const n = normName(rawName);
  if (!n) return { team: null, ambiguous: [] };
  const eligible = teams.filter((t) => {
    const tid = teamIdFromApiRow(t);
    return tid == null || !byeTeamIds.has(tid);
  }).filter((t) => !isRetractedOrWithdrawnTeam(t));
  const candidates = eligible.filter((t) => csvMatchKeysForTeam(t).includes(n));
  if (candidates.length === 1) return { team: candidates[0], ambiguous: [] };
  if (candidates.length > 1) return { team: null, ambiguous: candidates };

  if (n.length >= 2) {
    const ends = eligible.filter((t) =>
      csvMatchKeysForTeam(t).some((k) => k && k.endsWith(n))
    );
    if (ends.length === 1) return { team: ends[0], ambiguous: [] };
    if (ends.length > 1) return { team: null, ambiguous: ends };

    const inc = eligible.filter((t) =>
      csvMatchKeysForTeam(t).some((k) => k && k.includes(n))
    );
    if (inc.length === 1) return { team: inc[0], ambiguous: [] };
    if (inc.length > 1) return { team: null, ambiguous: inc };
  }

  return { team: null, ambiguous: [] };
}

function col(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== "") {
      const t = sanitizeCsvCell(String(v));
      if (t !== "") return t;
    }
  }
  return "";
}

/** Returns true if the first row looks like a header (not a data row). */
export function csvLooksLikeHasHeader(headers) {
  const h = new Set(headers);
  const hasTeam =
    h.has("team_name") || h.has("team") || h.has("name") || h.has("team_id") || h.has("id");
  const hasVenue =
    h.has("venue") || h.has("site") || h.has("site_category") || h.has("sitecategory") || h.has("location");
  const hasSlot = h.has("timeslot") || h.has("time_slot") || h.has("slot");
  return hasTeam && hasVenue && hasSlot;
}

/**
 * @param {object[]} teams - from API
 * @param {object[]} standings - from API standings list
 * @param {string} csvText
 * @param {Set<number>} byeTeamIds - exempt from scheduling (bye placeholders + flex teams; no CSV row required)
 * @param {{ speaksByTeamId?: Map<number, number> }} [opts] - speaks totals from GET …/teams/standings/rounds (sum of score)
 */
export function mergeScheduling(teams, standings, csvText, byeTeamIds, opts = {}) {
  const speaksByTeamId = opts.speaksByTeamId;
  const schedTeams = teams.filter((t) => !isRetractedOrWithdrawnTeam(t));
  const { headers, rows } = parseCsv(csvText);
  assertNoPointsColumns(headers);

  if (headers.length && !csvLooksLikeHasHeader(headers)) {
    throw new Error(
      'CSV first row must be a header with columns like team_name,score,venue,timeslot (got: "' +
        headers.slice(0, 6).join('", "') +
        '"). Do not omit the header row.'
    );
  }

  const standByTeamUrl = new Map();
  for (const s of standings) {
    const tid = idFromTeamUrl(s.team);
    if (tid != null) standByTeamUrl.set(tid, s);
  }

  const scheduling = new Map();
  const unmatchedNames = [];
  const ambiguousNames = [];

  for (const row of rows) {
    const venueRaw = col(row, "venue", "site", "site_category", "sitecategory", "location");
    const ts = col(row, "timeslot", "time_slot", "slot");
    const venueLabel = venueRaw;
    const venueKey = normName(venueRaw);
    const sch = {
      venueKey,
      venueLabel,
      timeslot: ts || null,
    };

    const idStr = col(row, "team_id", "teamid", "id");
    const parsedId = parseInt(idStr, 10);
    const nameStr = col(row, "team_name", "team", "name");
    const nameLow = String(nameStr || "").toLowerCase();
    if (nameLow.includes("[retracted]") || nameLow.includes("[withdrawn]")) continue;

    let teamId = null;
    if (!Number.isNaN(parsedId) && idStr !== "" && schedTeams.some((t) => teamIdFromApiRow(t) === parsedId)) {
      teamId = parsedId;
    } else if (nameStr) {
      const n = normName(nameStr);
      if (n === "bye") {
        const byeTeams = schedTeams.filter((t) => {
          const tid = teamIdFromApiRow(t);
          return tid != null && byeTeamIds.has(tid);
        });
        if (byeTeams.length === 1) teamId = teamIdFromApiRow(byeTeams[0]);
        else if (byeTeams.length === 0) unmatchedNames.push(`${nameStr} (no scheduling-exempt / BYE team in tournament)`);
        else unmatchedNames.push(`${nameStr} (multiple exempt teams — use team_id)`);
      } else {
        const { team, ambiguous } = matchTeamByDisplayName(schedTeams, nameStr, byeTeamIds);
        if (team) teamId = teamIdFromApiRow(team);
        else if (ambiguous.length)
          ambiguousNames.push({ name: nameStr, ids: ambiguous.map((t) => teamIdFromApiRow(t)).filter(Boolean) });
        else unmatchedNames.push(nameStr);
      }
    } else {
      continue;
    }

    if (teamId == null) continue;
    if (byeTeamIds.has(teamId)) {
      scheduling.set(teamId, { venueKey: "", venueLabel: "", timeslot: null });
      continue;
    }
    scheduling.set(teamId, sch);
  }

  const merged = [];
  const missing = [];

  for (const t of schedTeams) {
    const tid = teamIdFromApiRow(t);
    if (tid == null) continue;
    if (byeTeamIds.has(tid)) continue;
    const st = standByTeamUrl.get(tid);
    const points = st ? metricFromStandings(st, "points") : 0;
    const speaks =
      speaksByTeamId && speaksByTeamId.has(tid)
        ? speaksByTeamId.get(tid)
        : st
          ? metricFromStandings(st, "speaks_sum")
          : 0;

    const sch = scheduling.get(tid);
    const rosterLabel = teamLabelForCsvRoster(t);
    if (!sch) {
      missing.push({
        id: tid,
        short_name: t.short_name,
        long_name: t.long_name,
        rosterLabel,
        reason: "no_csv_row",
      });
    } else if (!sch.venueKey) {
      missing.push({
        id: tid,
        short_name: t.short_name,
        long_name: t.long_name,
        rosterLabel,
        reason: "no_venue",
      });
    } else if (!sch.timeslot) {
      missing.push({
        id: tid,
        short_name: t.short_name,
        long_name: t.long_name,
        rosterLabel,
        reason: "no_timeslot",
      });
    }

    merged.push({
      id: tid,
      url: t.url,
      short_name: t.short_name,
      long_name: t.long_name,
      code_name: t.code_name,
      short_reference: t.short_reference,
      reference: t.reference,
      csvLabel: teamLabelForCsvRoster(t),
      institution: t.institution,
      schoolKey: deriveSchoolKeyFromTeam(t),
      points,
      speaks,
      venueKey: sch?.venueKey ?? "",
      venueLabel: sch?.venueLabel ?? "",
      timeslot: sch?.timeslot ?? null,
    });
  }

  return {
    merged,
    missing,
    scheduling,
    unmatchedNames,
    ambiguousNames,
    csvRowCount: rows.length,
    scheduledTeamCount: scheduling.size,
  };
}

function idFromTeamUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/teams\/(\d+)\/?$/);
  return m ? parseInt(m[1], 10) : null;
}

function metricFromStandings(row, name) {
  const m = row.metrics?.find((x) => x.metric === name);
  return m ? Number(m.value) : 0;
}
