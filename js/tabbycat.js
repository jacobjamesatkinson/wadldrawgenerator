/**
 * Tabbycat API v1 client (browser fetch, Token auth).
 *
 * Array query params (`metrics`, `extra_metrics`, …): use repeated keys (`metrics=a&metrics=b`).
 * Some OpenAPI docs show comma-separated; Django/DRF typically accepts repeated keys reliably.
 *
 * Tabbycat v1 URLs are registered with trailing_slash=False; a path like …/pairings/ can 404 or confuse
 * proxies/CORS. We strip trailing slashes on the path segment (preserving ?query).
 */

function normalizeBaseUrl(base) {
  return String(base || "").replace(/\/+$/, "");
}

/** @param {string} path - absolute path, optional ?search */
function normalizeApiPath(path) {
  const raw = String(path || "").trim();
  if (!raw) return "/";
  const q = raw.indexOf("?");
  const pathPart = q >= 0 ? raw.slice(0, q) : raw;
  const search = q >= 0 ? raw.slice(q) : "";
  let p = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  p = p.replace(/\/+$/, "");
  if (!p) p = "/";
  return p + search;
}

/** Normalize path portion of an absolute URL when it shares origin with Tabbycat (paged `next` links). */
function normalizeSameOriginApiUrl(baseUrl, absoluteUrl) {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const bu = new URL(base);
    const ru = new URL(String(absoluteUrl));
    if (ru.origin !== bu.origin) return String(absoluteUrl);
    return `${bu.origin}${normalizeApiPath(ru.pathname + ru.search)}`;
  } catch {
    return String(absoluteUrl);
  }
}

function authHeaders(token) {
  const h = { Accept: "application/json", "Content-Type": "application/json" };
  if (token) h.Authorization = token.startsWith("Token ") ? token : `Token ${token}`;
  return h;
}

/** Wraps fetch so opaque browser failures become actionable messages (vs bare "NetworkError"). */
async function fetchOrThrow(url, init, context) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const name = err?.name || "";
    const msg = err?.message || String(err);
    throw new Error(
      `Network error (${name || "fetch"}: ${msg}) during ${context}. Check the Tabbycat base URL, token, and connectivity. Cross-origin calls need CORS or a same-origin proxy — see CORS.md.`
    );
  }
}

export async function apiGet(baseUrl, token, path, params = {}) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error("Missing Tabbycat base URL (check server preset or custom URL).");
  const pathNorm = normalizeApiPath(path);
  const u = new URL(`${base}${pathNorm}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) {
      v.filter((x) => x !== undefined && x !== null && x !== "").forEach((x) => u.searchParams.append(k, String(x)));
    } else u.searchParams.set(k, String(v));
  });
  const r = await fetchOrThrow(u.toString(), { headers: authHeaders(token) }, `GET ${pathNorm}`);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${t.slice(0, 500)}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

export async function apiDelete(baseUrl, token, path) {
  const pathNorm = normalizeApiPath(path);
  const u = `${normalizeBaseUrl(baseUrl)}${pathNorm}`;
  const r = await fetchOrThrow(u, { method: "DELETE", headers: authHeaders(token) }, `DELETE ${pathNorm}`);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${t.slice(0, 500)}`);
  }
  return null;
}

export async function apiPost(baseUrl, token, path, body) {
  const pathNorm = normalizeApiPath(path);
  const u = `${normalizeBaseUrl(baseUrl)}${pathNorm}`;
  const r = await fetchOrThrow(
    u,
    {
      method: "POST",
      headers: authHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    `POST ${pathNorm}`
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${t.slice(0, 500)}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

async function fetchAllPages(baseUrl, token, path, params = {}) {
  const items = [];
  let nextUrl = null;
  const first = await apiGet(baseUrl, token, path, { ...params, limit: 200 });
  if (!first) return items;
  let data = first;
  for (;;) {
    const chunk = data.results ?? (Array.isArray(data) ? data : []);
    if (Array.isArray(chunk)) items.push(...chunk);
    nextUrl = data.next;
    if (!nextUrl) break;
    const pageUrl = normalizeSameOriginApiUrl(baseUrl, nextUrl);
    const r = await fetchOrThrow(pageUrl, { headers: authHeaders(token) }, "GET (paged)");
    if (!r.ok) throw new Error(`${r.status} paging: ${await r.text()}`);
    data = await r.json();
  }
  return items;
}

export function tournamentPath(slug, sub) {
  return `/api/v1/tournaments/${encodeURIComponent(slug)}${sub}`;
}

export async function listTeams(baseUrl, token, slug) {
  return fetchAllPages(baseUrl, token, tournamentPath(slug, "/teams"));
}

export async function listTeamStandings(baseUrl, token, slug, opts = {}) {
  // OpenAPI declares metrics/extra_metrics with explode=false — Tabbycat expects a single
  // comma-separated value (repeated ?metrics=…&metrics=… is silently dropped, leaving
  // speaks_sum absent so the roster's total-speaks column stays blank).
  const params = {
    metrics: (opts.metrics ?? ["points"]).join(","),
    extra_metrics: (opts.extra_metrics ?? ["speaks_sum", "speaks_avg"]).join(","),
  };
  if (opts.round != null) params.round = opts.round;
  return fetchAllPages(baseUrl, token, tournamentPath(slug, "/teams/standings"), params);
}

export async function listVenueCategories(baseUrl, token, slug) {
  return fetchAllPages(baseUrl, token, tournamentPath(slug, "/venue-categories"));
}

export async function listVenues(baseUrl, token, slug) {
  return fetchAllPages(baseUrl, token, tournamentPath(slug, "/venues"));
}

export async function listInstitutions(baseUrl, token, slug) {
  return fetchAllPages(baseUrl, token, tournamentPath(slug, "/institutions"));
}

export async function listRounds(baseUrl, token, slug) {
  return fetchAllPages(baseUrl, token, tournamentPath(slug, "/rounds"));
}

export async function listAdjudicators(baseUrl, token, slug) {
  return fetchAllPages(baseUrl, token, tournamentPath(slug, "/adjudicators"));
}

export async function listPairingsForRound(baseUrl, token, slug, roundSeq) {
  return fetchAllPages(
    baseUrl,
    token,
    tournamentPath(slug, `/rounds/${roundSeq}/pairings`)
  );
}

function pairingSelfUrl(item) {
  return item?.url || item?._links?.url || null;
}

/** Path under base URL for a Tabbycat hyperlinked resource (absolute or relative). */
function pathFromTabbycatResourceUrl(baseUrl, resourceUrl) {
  const s = String(resourceUrl || "").trim();
  if (!s) throw new Error("Pairing in list response has no url (expected url or _links.url).");
  if (s.startsWith("http://") || s.startsWith("https://")) {
    const base = normalizeBaseUrl(baseUrl);
    let bu;
    let ru;
    try {
      bu = new URL(base);
      ru = new URL(s);
    } catch {
      throw new Error(`Invalid pairing URL: ${s.slice(0, 120)}`);
    }
    if (ru.origin !== bu.origin) {
      throw new Error(`Pairing URL host (${ru.hostname}) does not match Tabbycat base (${bu.hostname}).`);
    }
    return normalizeApiPath(ru.pathname + ru.search);
  }
  return normalizeApiPath(s.startsWith("/") ? s : `/${s}`);
}

function shouldTryPerDebatePairingDelete(bulkError) {
  const msg = String(bulkError?.message || bulkError);
  const m = msg.match(/^(\d{3})\b/);
  const status = m ? parseInt(m[1], 10) : null;
  if (status === 401 || status === 403) return false;
  if (status != null && status >= 400 && status < 500) {
    return [404, 405, 409, 429].includes(status);
  }
  if (status != null && status >= 500) return true;
  return /Network error/i.test(msg);
}

/**
 * Remove all debates for a round. Tries bulk DELETE on …/pairings; on failure (5xx, some 4xx, or network)
 * lists debates and DELETEs each detail URL (Tabbycat-compatible fallback).
 * @returns {Promise<{ via: "bulk" } | { via: "per-debate", count: number } | null>}
 */
export async function deleteAllPairings(baseUrl, token, slug, roundSeq) {
  const collectionPath = tournamentPath(slug, `/rounds/${roundSeq}/pairings`);
  let bulkErr = null;
  try {
    await apiDelete(baseUrl, token, collectionPath);
    return { via: "bulk" };
  } catch (e) {
    bulkErr = e;
    if (!shouldTryPerDebatePairingDelete(e)) throw e;
  }
  const items = await listPairingsForRound(baseUrl, token, slug, roundSeq);
  if (!items.length) return null;
  let done = 0;
  for (const item of items) {
    const self = pairingSelfUrl(item);
    let detailPath;
    try {
      detailPath = pathFromTabbycatResourceUrl(baseUrl, self);
    } catch (e) {
      throw new Error(
        `Could not clear the draw: bulk DELETE failed (${String(bulkErr?.message || bulkErr).slice(0, 240)}). ${e.message}`
      );
    }
    try {
      await apiDelete(baseUrl, token, detailPath);
      done++;
    } catch (e) {
      throw new Error(
        `Could not clear the draw: bulk DELETE failed (${String(bulkErr?.message || bulkErr).slice(
          0,
          200
        )}). Fallback removed ${done}/${items.length} debate(s), then: ${String(e?.message || e).slice(0, 400)}`
      );
    }
  }
  return { via: "per-debate", count: items.length };
}

export async function createPairing(baseUrl, token, slug, roundSeq, body) {
  return apiPost(
    baseUrl,
    token,
    tournamentPath(slug, `/rounds/${roundSeq}/pairings`),
    body
  );
}

/** Extract numeric id from Tabbycat API URL ending in /teams/123 */
export function idFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/(\d+)\/?$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Round sequence from hyperlinked round URL (…/rounds/{seq}). */
export function roundSeqFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/rounds\/(\d+)\/?$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Tabbycat GET …/teams/standings/rounds — per-team per-debate scores (confirmed ballots).
 * @returns {Promise<object[]>} rows like { team: url, rounds: [{ round, points, score, has_ghost }] }
 */
export async function listTeamStandingsRounds(baseUrl, token, slug) {
  return fetchAllPages(
    baseUrl,
    token,
    tournamentPath(slug, "/teams/standings/rounds"),
    { limit: 200 }
  );
}

/**
 * Total team speaks = sum of `score` from standings/rounds rows with round seq ≤ maxRoundSeq.
 * @param {object[]} rows - from listTeamStandingsRounds
 * @param {number} maxRoundSeq - last completed preliminary round to include (same cut as standings `round` param)
 */
export function speaksTotalsFromStandingsRounds(rows, maxRoundSeq) {
  const map = new Map();
  if (!rows?.length || maxRoundSeq == null || maxRoundSeq < 1) return map;
  for (const row of rows) {
    const tid = idFromUrl(row.team);
    if (tid == null) continue;
    let sum = 0;
    for (const r of row.rounds || []) {
      const seq = roundSeqFromUrl(r.round);
      if (seq != null && seq <= maxRoundSeq) sum += Number(r.score) || 0;
    }
    map.set(tid, sum);
  }
  return map;
}

/**
 * Fallback: if …/teams/standings/rounds returns no data (rare — e.g. missing permission
 * or cut-over Tabbycat version), sum from the standings list's speaks_sum metric instead.
 * Rows with an existing non-null value in `base` are not overwritten.
 */
export function speaksTotalsFromStandings(rows, base) {
  const map = base instanceof Map ? new Map(base) : new Map();
  if (!rows?.length) return map;
  for (const row of rows) {
    const tid = idFromUrl(row.team);
    if (tid == null) continue;
    if (map.has(tid) && Number.isFinite(map.get(tid)) && map.get(tid) !== 0) continue;
    const m = row.metrics?.find((x) => x.metric === "speaks_sum");
    if (!m) continue;
    const v = Number(m.value);
    if (Number.isFinite(v)) map.set(tid, v);
  }
  return map;
}

export function metricValue(standingsRow, name) {
  const m = standingsRow.metrics?.find((x) => x.metric === name);
  return m ? Number(m.value) : 0;
}
