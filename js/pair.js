import { deriveSchoolKeyFromTeam } from "./merge.js";

/**
 * Power-pairing draw (speaks-based, Tabbycat-style):
 * - Raw brackets = rounded total speaks (wins/points are not used for bracketing or rank).
 * - Odd brackets: pull up from the next lower bracket (default: strongest team in the bracket below).
 * - If matching would force a rematch, pull two more teams up from below when possible (history escape).
 * Soft costs: 1 Rematch  2 Fold/high–low slack  3 Same institution  4 Side imbalance
 */

/** @type {const} */
const PRIORITY = { rematch: 1, power: 2, inst: 3, side: 4 };

const COST_REMATCH = 100_000;
const COST_POWER_SLACK_UNIT = 3_000;
const COST_FLOATER_BASE = 2_800;
const COST_FLOATER_PER_SPEAK = 12;
const COST_SAME_INSTITUTION = 90;
const COST_SPEAK_TIE = 1e-6;

/** Pull-up source: true = take from top of lower bracket (strongest there); false = bottom. */
const PULL_UP_FROM_TOP_OF_LOWER = true;

function speaksNum(t) {
  const s = Number(t?.speaks);
  return Number.isFinite(s) ? s : 0;
}

function edgeKeyForIds(idA, idB) {
  const a = Math.min(idA, idB);
  const b = Math.max(idA, idB);
  return `${a}-${b}`;
}

export function teamPairKey(a, b) {
  if (!a?.id || !b?.id) return "";
  return edgeKeyForIds(a.id, b.id);
}

function teamEdgeKey(a, b) {
  return teamPairKey(a, b);
}

export function displayTeamLabel(t) {
  if (!t) return "?";
  return t.csvLabel || t.short_name || t.long_name || `Team ${t.id}`;
}

/**
 * @param {{ type: 'inBracket', n: number, ia: number, ib: number } | { type: 'floater' } | null} bracketCtx
 */
function pairConflictCost(a, b, rematch, instKey, bracketCtx) {
  if (!a || !b) return 1e15;
  let c = Math.abs((a.speaks || 0) - (b.speaks || 0)) * COST_SPEAK_TIE;
  if (rematch.has(teamEdgeKey(a, b))) c += COST_REMATCH;
  const ka = instKey(a);
  if (ka && ka === instKey(b)) c += COST_SAME_INSTITUTION;
  if (bracketCtx?.type === "inBracket") {
    const { n, ia, ib } = bracketCtx;
    const slack = Math.abs(ia + ib - (n - 1));
    c += slack * COST_POWER_SLACK_UNIT;
  } else if (bracketCtx?.type === "floater") {
    c += COST_FLOATER_BASE + Math.abs(speaksNum(a) - speaksNum(b)) * COST_FLOATER_PER_SPEAK;
  }
  return c;
}

/** Cost for exhaustive / swap search inside one speaks bracket. */
function scorePairInBracket(a, b, rematch, instKey, n, idxMap) {
  const ia = idxMap.get(a.id);
  const ib = idxMap.get(b.id);
  if (ia === undefined || ib === undefined) return 1e15;
  return pairConflictCost(a, b, rematch, instKey, { type: "inBracket", n, ia, ib });
}

function tryImprovePairs(pairs, rematch, instKey, n, idxMap) {
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 320) {
    improved = false;
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const [a1, b1] = pairs[i];
        const [a2, b2] = pairs[j];
        const s0 =
          scorePairInBracket(a1, b1, rematch, instKey, n, idxMap) +
          scorePairInBracket(a2, b2, rematch, instKey, n, idxMap);
        const s1 =
          scorePairInBracket(a1, a2, rematch, instKey, n, idxMap) +
          scorePairInBracket(b1, b2, rematch, instKey, n, idxMap);
        const s2 =
          scorePairInBracket(a1, b2, rematch, instKey, n, idxMap) +
          scorePairInBracket(a2, b1, rematch, instKey, n, idxMap);
        if (s1 < s0) {
          pairs[i] = [a1, a2];
          pairs[j] = [b1, b2];
          improved = true;
        } else if (s2 < s0) {
          pairs[i] = [a1, b2];
          pairs[j] = [a2, b1];
          improved = true;
        }
      }
    }
  }
}

function minCostPerfectMatching(teamsSorted, rematch, instKey, idxMap, n) {
  if (n === 0) return { pairs: [], cost: 0 };
  if (n % 2 === 1) return null;
  const first = teamsSorted[0];
  let best = null;
  let bestCost = Infinity;
  for (let i = 1; i < n; i++) {
    const second = teamsSorted[i];
    const ia = idxMap.get(first.id);
    const ib = idxMap.get(second.id);
    const c = pairConflictCost(first, second, rematch, instKey, { type: "inBracket", n, ia, ib });
    const rest = teamsSorted.slice(1, i).concat(teamsSorted.slice(i + 1));
    const sub = minCostPerfectMatching(rest, rematch, instKey, idxMap, n - 2);
    if (!sub) continue;
    const total = c + sub.cost;
    if (total < bestCost) {
      bestCost = total;
      best = { pairs: [[first, second], ...sub.pairs], cost: total };
    }
  }
  return best;
}

/** Exhaustive min-cost matching; 12 teams → 11!! ≈ 10k recursive calls. */
const EXHAUSTIVE_MATCH_MAX_TEAMS = 12;

/**
 * @returns {{ pairs: [object, object][], sortedTeams: object[], n: number, speaksBandKey: number|null, idxMap: Map<number, number> }}
 */
function slidePairBracket(bracket, rematch, instKey) {
  const t = bracket.slice().sort((a, b) => speaksNum(b) - speaksNum(a) || a.id - b.id);
  const n = t.length;
  const idxMap = new Map(t.map((team, i) => [team.id, i]));
  const speaksBandKey = t[0] != null ? Math.round(speaksNum(t[0])) : null;
  if (n < 2) return { pairs: [], sortedTeams: t, n, speaksBandKey, idxMap };

  let pairs;
  if (n % 2 === 0 && n <= EXHAUSTIVE_MATCH_MAX_TEAMS) {
    const optimal = minCostPerfectMatching(t, rematch, instKey, idxMap, n);
    pairs = optimal?.pairs?.length ? optimal.pairs : null;
  }
  if (!pairs) {
    pairs = [];
    for (let i = 0; i < n / 2; i++) pairs.push([t[i], t[n - 1 - i]]);
    tryImprovePairs(pairs, rematch, instKey, n, idxMap);
  }
  return { pairs, sortedTeams: t, n, speaksBandKey, idxMap };
}

function floaterPairCost(a, b, rematch, instKey) {
  return pairConflictCost(a, b, rematch, instKey, { type: "floater" });
}

function pairFloaters(floaters, rematch, instKey, notes, poolLabel) {
  const pairs = [];
  const f = floaters.slice();
  while (f.length >= 2) {
    const a = f.shift();
    let bestI = 0;
    let bestCost = Infinity;
    for (let i = 0; i < f.length; i++) {
      const c = floaterPairCost(a, f[i], rematch, instKey);
      if (c < bestCost || (c === bestCost && f[i].id < f[bestI].id)) {
        bestCost = c;
        bestI = i;
      }
    }
    const b = f.splice(bestI, 1)[0];
    if (rematch.has(teamEdgeKey(a, b))) {
      notes.push(
        `${poolLabel}: floater closure required a rematch — no other partner remained in the floater set.`
      );
    }
    pairs.push([a, b]);
  }
  return { pairs, rest: f };
}

/** Aff=a, neg=b orientation cost (lower = better side balance). */
export function sideAssignmentCost(aff, neg, sideHist) {
  const ca = sideHist.get(aff.id) || { aff: 0, neg: 0 };
  const cb = sideHist.get(neg.id) || { aff: 0, neg: 0 };
  const bal = (c) => (c.aff || 0) - (c.neg || 0);
  return Math.abs(bal(ca) + 1) + Math.abs(bal(cb) - 1);
}

export function pickSides(a, b, sideHist) {
  const opt1 = { aff: a, neg: b, cost: sideAssignmentCost(a, b, sideHist) };
  const opt2 = { aff: b, neg: a, cost: sideAssignmentCost(b, a, sideHist) };
  const opts = [opt1, opt2].sort((x, y) => x.cost - y.cost);
  const chosen = opts[0];
  const altCost = opts[1].cost;
  const sideClash =
    chosen.cost > 0
      ? {
          kind: "side",
          priority: PRIORITY.side,
          short: `Sides +${chosen.cost}`,
          detail: `Side balance (lowest priority soft rule): with ${displayTeamLabel(chosen.aff)} on Aff and ${displayTeamLabel(chosen.neg)} on Neg, prior Tabbycat history implies imbalance cost ${chosen.cost} (aff/neg counts before this round: ${displayTeamLabel(a)} ${(sideHist.get(a.id)?.aff ?? 0)}A/${(sideHist.get(a.id)?.neg ?? 0)}N, ${displayTeamLabel(b)} ${(sideHist.get(b.id)?.aff ?? 0)}A/${(sideHist.get(b.id)?.neg ?? 0)}N). Swapping sides would cost ${altCost}.`,
        }
      : null;
  return { aff: chosen.aff, neg: chosen.neg, cost: chosen.cost, sideClash };
}

function weightedRandomByeTeamBySpeaks(candidates) {
  if (candidates.length <= 1) {
    const team = candidates[0] || null;
    return {
      team,
      candidateCount: candidates.length,
      bottomCutoff: team ? speaksNum(team) : 0,
      weight: team ? 1 : 0,
      totalWeight: team ? 1 : 0,
      isBottomHalf: true,
    };
  }

  const sorted = candidates.slice().sort((a, b) => speaksNum(a) - speaksNum(b));
  const bottomCount = Math.ceil(sorted.length / 2);
  const bottomCutoff = speaksNum(sorted[bottomCount - 1]);
  const maxSpeaks = Math.max(...sorted.map(speaksNum));
  const topRange = Math.max(0, maxSpeaks - bottomCutoff);
  const weights = sorted.map((t) => {
    const speaks = speaksNum(t);
    if (speaks <= bottomCutoff || topRange === 0) return 1;

    // Linear gradient: middle teams remain plausible, top speakers are least likely.
    const topShare = (speaks - bottomCutoff) / topRange;
    return 1 - 0.8 * topShare;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < sorted.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      return {
        team: sorted[i],
        candidateCount: sorted.length,
        bottomCutoff,
        weight: weights[i],
        totalWeight: total,
        isBottomHalf: speaksNum(sorted[i]) <= bottomCutoff,
      };
    }
  }
  const last = sorted[sorted.length - 1];
  return {
    team: last,
    candidateCount: sorted.length,
    bottomCutoff,
    weight: weights[weights.length - 1],
    totalWeight: total,
    isBottomHalf: speaksNum(last) <= bottomCutoff,
  };
}

function formatSpeaksValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

function formatPercent(n) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "?";
}

function byeAllocationNoteLines(pick, poolLabel) {
  const t = pick.team;
  const chance = pick.totalWeight > 0 ? pick.weight / pick.totalWeight : NaN;
  const priorTeamLine = pick.usedPriorTeamFallback
    ? "- Prior bye: repeat unavoidable"
    : `- Prior bye: avoided (${pick.teamEligibleCount}/${pick.candidateCount} eligible)`;
  const instLine = pick.usedInstitutionFallback
    ? "- Institution bye: unavoidable"
    : `- Institution bye: avoided (${pick.institutionEligibleCount}/${pick.teamEligibleCount} eligible)`;
  const tier = pick.isBottomHalf ? "bottom 50%" : "reduced-weight higher speaks";
  return [
    `Bye: ${displayTeamLabel(t)} (${poolLabel})`,
    priorTeamLine,
    instLine,
    `- Speaks: ${formatSpeaksValue(speaksNum(t))}; ${tier}; chance ~${formatPercent(chance)}`,
    "- Team number/id: ignored",
  ];
}

function pickByeTeam(candidates, byeHist, instKey) {
  if (!candidates.length) return null;
  const noBye = candidates.filter((t) => !byeHist.teamHadBye.has(t.id));
  const teamEligible = noBye.length ? noBye : candidates.slice();
  const instEligible = teamEligible.filter((t) => {
    const ik = instKey(t);
    return !ik || !byeHist.instHadBye.has(ik);
  });
  const pool = instEligible.length ? instEligible : teamEligible;
  const weighted = weightedRandomByeTeamBySpeaks(pool);
  return {
    ...weighted,
    candidateCount: candidates.length,
    teamEligibleCount: teamEligible.length,
    institutionEligibleCount: instEligible.length,
    weightedCandidateCount: pool.length,
    usedPriorTeamFallback: noBye.length === 0,
    usedInstitutionFallback: instEligible.length === 0,
  };
}

function forcedFloaterByeNoteLines(team, poolLabel) {
  return [
    `Bye: ${displayTeamLabel(team)} (${poolLabel})`,
    "- Selection: forced leftover floater",
    "- Prior bye: no alternative",
    "- Institution bye: no alternative",
    "- Team number/id: ignored",
  ];
}

function pairsHaveRematch(pairs, rematch) {
  for (const [a, b] of pairs) {
    if (rematch.has(teamEdgeKey(a, b))) return true;
  }
  return false;
}

/** Raw brackets: rounded total speaks (like Tabbycat’s wins buckets, but speaks). */
function buildRawSpeaksBrackets(pool) {
  const m = groupBy(pool, (t) => Math.round(speaksNum(t)));
  const keys = [...m.keys()].sort((a, b) => b - a);
  return keys.map((k) => ({
    key: k,
    teams: (m.get(k) || []).slice().sort((a, b) => speaksNum(b) - speaksNum(a) || a.id - b.id),
  }));
}

/**
 * Odd bracket → pull one team up from the nearest lower non-empty speaks bracket.
 * If none, drop the odd team into the floater list.
 */
function resolveOddBracketsPullUp(brackets, floaterEntries, pullUpFromTop) {
  const ins = (arr, t) => {
    arr.push(t);
    arr.sort((a, b) => speaksNum(b) - speaksNum(a) || a.id - b.id);
  };
  for (let guard = 0; guard < 2000; guard++) {
    const oddI = brackets.findIndex((b) => b.teams.length % 2 === 1);
    if (oddI < 0) return;
    let donorI = -1;
    for (let j = oddI + 1; j < brackets.length; j++) {
      if (brackets[j].teams.length > 0) {
        donorI = j;
        break;
      }
    }
    if (donorI < 0) {
      const t = brackets[oddI].teams.pop();
      if (t) floaterEntries.push({ team: t, fromBracket: brackets[oddI].key, pull: "↓" });
      continue;
    }
    const donor = brackets[donorI].teams;
    const t = pullUpFromTop ? donor.shift() : donor.pop();
    ins(brackets[oddI].teams, t);
  }
}

function pullTwoFromFloaterReserve(floaters) {
  if (floaters.length < 2) return null;
  return [floaters.shift().team, floaters.shift().team];
}

/** Weaker speaks band = higher index (keys descend with index). */
function pullTwoFromLowerBracket(allBrackets, afterIdx, fromTop) {
  for (let j = afterIdx + 1; j < allBrackets.length; j++) {
    const arr = allBrackets[j].teams;
    if (arr.length < 2) continue;
    if (fromTop) return [arr.shift(), arr.shift()];
    return [arr.pop(), arr.pop()];
  }
  return null;
}

/**
 * Bottom bracket only: steal two teams by removing one already-built debate from the strongest
 * adjacent band above (largest bracketIdx still < weakerBracketIdx). Re-pairing those two into
 * the bottom pool breaks dense rematch cliques when there is no weaker band to pull from.
 */
function pullTwoDownFromStrongerBracket(normPairs, weakerBracketIdx) {
  let bestBi = -1;
  let bestI = -1;
  for (let i = 0; i < normPairs.length; i++) {
    const p = normPairs[i];
    if (!p.__inBracket || p.bracketIdx === undefined) continue;
    if (p.bracketIdx >= weakerBracketIdx) continue;
    if (p.bracketIdx > bestBi) {
      bestBi = p.bracketIdx;
      bestI = i;
    }
  }
  if (bestI < 0) return null;
  const p = normPairs[bestI];
  normPairs.splice(bestI, 1);
  return [p.a, p.b];
}

function findLastNonEmptyBracketIndex(brackets) {
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (brackets[i].teams.length > 0) return i;
  }
  return -1;
}

/**
 * Odd-out teams sit in floaters until the bottom non-empty band pairs; then they fold with that band
 * so the bottom pool is not tiny and rematch-avoidance has enough partners.
 */
function mergeFloatersIntoBracketRow(row, floaters) {
  if (!floaters.length) return;
  for (const f of floaters) row.teams.push(f.team);
  row.teams.sort((a, b) => speaksNum(b) - speaksNum(a) || a.id - b.id);
  floaters.length = 0;
}

function bracketSectionMetaFromTeams(sortedTeams, anchorKey, bracketIndex) {
  if (!sortedTeams.length) {
    return { sectionId: `spk-empty-${bracketIndex}`, label: "—", hover: "" };
  }
  const rs = sortedTeams.map((t) => Math.round(speaksNum(t)));
  const min = Math.min(...rs);
  const max = Math.max(...rs);
  const mixed = min !== max;
  const sectionId = mixed ? `spk-mix-${bracketIndex}-${anchorKey}` : `spk-${bracketIndex}-${anchorKey}`;
  return {
    sectionId,
    label: mixed
      ? `Bracket — mixed ${min}–${max} speaks (pull-ups)`
      : `Bracket — ${anchorKey} speaks (tie band)`,
    hover: mixed
      ? "Odd brackets were resolved by pulling teams up from lower speaks bands (Tabbycat-style pull-up). Order and pairing inside the bracket use total speaks only — wins/points are not used."
      : `Raw bracket = teams at ~${anchorKey} total speaks (rounded). Fold (high–low) pairing uses speaks rank only; wins/points are ignored for bracketing.`,
  };
}

/**
 * Fold + minimum-cost matching; if the best matching still has a rematch, add two teams and retry:
 * first from the odd-out floater reserve (if any), else from the next weaker speaks band (Tabbycat-style).
 * Floater odd-outs are merged into the bottom band *before* any bracket pairs so upper brackets do not
 * empty that reserve and the bottom pool stays large.
 * Last (weakest) bracket: if rematch persists with no floater/lower donor, remove one debate from the
 * nearest *stronger* band and fold those two teams into this bracket (pull-down).
 */
function pairBracketWithRematchEscape(
  bracketRow,
  bracketIdx,
  allBrackets,
  rematch,
  instKey,
  warnings,
  poolLabel,
  floaters,
  isLastBracket,
  normPairsAcc
) {
  const anchorKey = bracketRow.key;
  let teams = bracketRow.teams.slice().sort((a, b) => speaksNum(b) - speaksNum(a) || a.id - b.id);
  const results = [];
  let pulls = 0;

  for (let attempt = 0; attempt < 50; attempt++) {
    if (teams.length < 2) return results;
    const { pairs, n, idxMap, sortedTeams, speaksBandKey } = slidePairBracket(teams, rematch, instKey);
    if (!pairs.length) return results;

    if (!pairsHaveRematch(pairs, rematch)) {
      const meta = bracketSectionMetaFromTeams(sortedTeams, anchorKey, bracketIdx);
      for (const [a, b] of pairs) {
        const ia = idxMap.get(a.id);
        const ib = idxMap.get(b.id);
        results.push({
          __inBracket: true,
          a,
          b,
          n,
          ia,
          ib,
          speaksBandKey,
          speaksBandLabel: meta.label,
          sectionMeta: meta,
          bracketIdx,
          pullsForRematch: pulls,
        });
      }
      return results;
    }

    let duo = pullTwoFromFloaterReserve(floaters);
    let duoSrc = duo ? "floater" : null;
    if (!duo) {
      duo = pullTwoFromLowerBracket(allBrackets, bracketIdx, PULL_UP_FROM_TOP_OF_LOWER);
      duoSrc = duo ? "lower" : null;
    }
    if (!duo && isLastBracket && normPairsAcc?.length) {
      duo = pullTwoDownFromStrongerBracket(normPairsAcc, bracketIdx);
      duoSrc = duo ? "down" : null;
    }
    if (!duo) break;
    teams = [...teams, duo[0], duo[1]].sort((a, b) => speaksNum(b) - speaksNum(a) || a.id - b.id);
    pulls += 2;
    const w =
      duoSrc === "floater"
        ? `${poolLabel}: pulled two teams from the odd-out reserve to break a rematch (history escape).`
        : duoSrc === "down"
          ? `${poolLabel}: pulled one debate (two teams) down from the next higher speaks bracket into the bottom bracket to break history clashes.`
          : `${poolLabel}: pulled two teams up from a lower speaks bracket to break a rematch (history escape).`;
    warnings.push(w);
  }

  const { pairs, n, idxMap, sortedTeams, speaksBandKey } = slidePairBracket(teams, rematch, instKey);
  if (!pairs?.length) return results;
  if (pairsHaveRematch(pairs, rematch)) {
    warnings.push(
      isLastBracket
        ? `${poolLabel}: bottom speaks bracket still has a rematch after pull-up / pull-down escapes — every pairing in that pool may repeat history, and no higher-bracket debate was left to borrow.`
        : `${poolLabel}: a speaks bracket still contains a rematch after pull-ups — typically only when those teams have already met every other team in that bracket.`
    );
  }
  const meta = bracketSectionMetaFromTeams(sortedTeams, anchorKey, bracketIdx);
  for (const [a, b] of pairs) {
    const ia = idxMap.get(a.id);
    const ib = idxMap.get(b.id);
    results.push({
      __inBracket: true,
      a,
      b,
      n,
      ia,
      ib,
      speaksBandKey,
      speaksBandLabel: meta.label,
      sectionMeta: meta,
      bracketIdx: bracketIdx,
      pullsForRematch: pulls,
    });
  }
  return results;
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/** Stable pool id from CSV venue label + timeslot (no Tabbycat venue data). */
export function poolKey(team) {
  return JSON.stringify([team.venueKey || "", team.timeslot || ""]);
}

export function formatPoolLabel(venueLabel, timeslot) {
  const v = venueLabel || "(venue)";
  const t = timeslot || "?";
  return `${v} — ${t}`;
}

function idFromUrl(url) {
  const m = String(url || "").match(/\/teams\/(\d+)\/?$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Tabbycat can return `team` as a URL string or a hyperlinked object. */
function teamFieldToUrl(teamField) {
  if (teamField == null || teamField === "") return null;
  if (typeof teamField === "string") return teamField;
  if (typeof teamField === "object") return teamField.url || teamField._links?.url || null;
  return null;
}

function teamIdFromPairingDt(dt) {
  return idFromUrl(teamFieldToUrl(dt?.team));
}

/**
 * Tabbycat `side`: string `aff`/`neg`/`bye`, or integer (DebateSide: aff=0, neg=1, bye=-1) when tournament uses numeric side labels.
 * @see Tabbycat `SideChoiceField.to_representation`
 */
function isByeSideValue(side) {
  if (side === "bye") return true;
  if (typeof side === "string" && side.toLowerCase() === "bye") return true;
  let n = NaN;
  if (typeof side === "number") n = side;
  else if (typeof side === "string" && /^-?\d+$/.test(side)) n = parseInt(side, 10);
  return Number.isFinite(n) && n === -1;
}

/** Map API side to aff/neg buckets for two-team (and BP string sides). Unknown → null (skipped). */
function sideHistBucket(side) {
  if (isByeSideValue(side)) return null;
  const s = typeof side === "string" ? side.toLowerCase() : side;
  if (s === "aff" || s === "og" || s === 0 || s === "0") return "aff";
  if (s === "neg" || s === "oo" || s === 1 || s === "1") return "neg";
  if (s === "cg" || s === 2 || s === "2") return "aff";
  if (s === "co" || s === 3 || s === "3") return "neg";
  return null;
}

function pairingSlotCountsAsScheduled(dt, byeTeamIds) {
  if (isByeSideValue(dt?.side)) return false;
  const id = teamIdFromPairingDt(dt);
  return id != null && !byeTeamIds.has(id);
}

/** Round sequence from a pairing row’s `round` link (when present on merged lists). */
export function debateRoundSeqFromPairing(debate) {
  const r = debate?.round;
  if (typeof r === "number" && Number.isFinite(r)) return r;
  const url = typeof r === "string" ? r : r?.url || r?._links?.url;
  const m = String(url || "").match(/\/rounds\/(\d+)\/?$/);
  return m ? parseInt(m[1], 10) : null;
}

export function pairingsForTabbycatRound(pairingsList, roundSeq) {
  if (roundSeq == null || roundSeq < 1 || !pairingsList?.length) return [];
  return pairingsList.filter((d) => debateRoundSeqFromPairing(d) === roundSeq);
}

/** Bucket flat pairing lists by `debate.round` when Action 1’s per-round map is unavailable. */
export function groupPairingsByRoundSeq(pairingsList) {
  /** @type {Record<number, object[]>} */
  const out = {};
  for (const d of pairingsList || []) {
    const r = debateRoundSeqFromPairing(d);
    if (r == null || r < 1) continue;
    if (!out[r]) out[r] = [];
    out[r].push(d);
  }
  return out;
}

/** Build rematch set: "id1-id2" with id1 < id2 */
export function buildRematchSet(pairingsList, byeTeamIds) {
  const edges = new Set();
  for (const debate of pairingsList) {
    const teams = debate.teams || [];
    const real = teams
      .filter((dt) => !isByeSideValue(dt.side) && teamFieldToUrl(dt.team))
      .map((dt) => teamIdFromPairingDt(dt))
      .filter((id) => id != null && !byeTeamIds.has(id));
    for (let i = 0; i < real.length; i++) {
      for (let j = i + 1; j < real.length; j++) {
        const x = Math.min(real[i], real[j]);
        const y = Math.max(real[i], real[j]);
        edges.add(`${x}-${y}`);
      }
    }
  }
  return edges;
}

/** @returns { teamId -> { aff, neg } counts } */
export function buildSideHistory(pairingsList, byeTeamIds) {
  const counts = new Map();
  function add(id, bucket) {
    if (id == null || byeTeamIds.has(id) || !bucket) return;
    if (!counts.has(id)) counts.set(id, { aff: 0, neg: 0 });
    const c = counts.get(id);
    if (bucket === "aff") c.aff++;
    else if (bucket === "neg") c.neg++;
  }
  for (const debate of pairingsList) {
    for (const dt of debate.teams || []) {
      const id = teamIdFromPairingDt(dt);
      add(id, sideHistBucket(dt.side));
    }
  }
  return counts;
}

/** Teams that had a bye (real team in debate with bye placeholder or side bye, or sole team in a debate with no opponent) */
export function buildByeHistory(pairingsList, byeTeamIds, teamById) {
  const teamHadBye = new Set();
  const instHadBye = new Set();
  function markTeamHadBye(id) {
    if (id == null || byeTeamIds.has(id)) return;
    teamHadBye.add(id);
    const t = teamById?.get(id);
    const sk = t ? deriveSchoolKeyFromTeam(t) : null;
    if (sk) instHadBye.add(sk);
    else if (t?.institution) instHadBye.add(t.institution);
  }
  for (const debate of pairingsList) {
    const dts = debate.teams || [];
    const hasByeSide = dts.some((dt) => isByeSideValue(dt.side));
    const byePh = dts.some((dt) => {
      const id = teamIdFromPairingDt(dt);
      return id != null && byeTeamIds.has(id);
    });
    if (!hasByeSide && !byePh) continue;
    for (const dt of dts) {
      markTeamHadBye(teamIdFromPairingDt(dt));
    }
  }
  for (const debate of pairingsList) {
    const dts = debate.teams || [];
    const realIds = new Set();
    for (const dt of dts) {
      if (!pairingSlotCountsAsScheduled(dt, byeTeamIds)) continue;
      realIds.add(teamIdFromPairingDt(dt));
    }
    if (realIds.size !== 1) continue;
    markTeamHadBye([...realIds][0]);
  }
  return { teamHadBye, instHadBye };
}

export function buildByeRoundHistory(pairingsByRound, importedTeams, byeTeamIds) {
  const byTeam = new Map();
  function mark(id, roundSeq) {
    if (id == null || byeTeamIds.has(id) || roundSeq == null) return;
    if (!byTeam.has(id)) byTeam.set(id, new Set());
    byTeam.get(id).add(roundSeq);
  }

  if (!pairingsByRound || typeof pairingsByRound !== "object") return byTeam;
  const rounds = Object.keys(pairingsByRound)
    .map((k) => parseInt(k, 10))
    .filter((r) => !Number.isNaN(r) && r >= 1)
    .sort((a, b) => a - b);

  for (const r of rounds) {
    const pr = pairingsByRound[r];
    if (!pr?.length) continue;

    for (const debate of pr) {
      const dts = debate.teams || [];
      const hasByeSide = dts.some((dt) => isByeSideValue(dt.side));
      const byePh = dts.some((dt) => {
        const id = teamIdFromPairingDt(dt);
        return id != null && byeTeamIds.has(id);
      });
      if (!hasByeSide && !byePh) continue;
      for (const dt of dts) mark(teamIdFromPairingDt(dt), r);
    }

    for (const debate of pr) {
      const realIds = new Set();
      for (const dt of debate.teams || []) {
        if (!pairingSlotCountsAsScheduled(dt, byeTeamIds)) continue;
        realIds.add(teamIdFromPairingDt(dt));
      }
      if (realIds.size === 1) mark([...realIds][0], r);
    }

    const scheduled = collectScheduledTeamIdsInPairings(pr, byeTeamIds);
    for (const t of importedTeams || []) {
      const id = numericIdFromTeamApiRow(t);
      if (id == null || byeTeamIds.has(id) || scheduled.has(id)) continue;
      mark(id, r);
    }
  }

  return byTeam;
}

function numericIdFromTeamApiRow(t) {
  if (!t) return null;
  if (t.id !== undefined && t.id !== null && `${t.id}`.trim() !== "") {
    const n = typeof t.id === "number" ? t.id : parseInt(String(t.id), 10);
    return Number.isNaN(n) ? null : n;
  }
  return idFromUrl(teamFieldToUrl(t.url));
}

/**
 * Tabbycat team ids that appear on aff/neg in at least one debate (excludes bye sides and scheduling-exempt ids).
 */
export function collectScheduledTeamIdsInPairings(pairingsList, byeTeamIds) {
  const seen = new Set();
  for (const debate of pairingsList || []) {
    for (const dt of debate.teams || []) {
      if (!pairingSlotCountsAsScheduled(dt, byeTeamIds)) continue;
      seen.add(teamIdFromPairingDt(dt));
    }
  }
  return seen;
}

/**
 * For each loaded round that has at least one pairing, any imported real team absent from that round’s
 * aff/neg slots is treated as having had a bye (union across rounds). Rounds with zero debates are skipped.
 * Mutates `teamHadBye` and `instHadBye`. Complements {@link buildByeHistory}; does not replace it.
 *
 * @param {Record<number, object[]>|null|undefined} pairingsByRound - e.g. `window.__pairingsByRound` from Action 1
 */
export function augmentByeHistoryWithAbsentFromLoadedRounds(
  teamHadBye,
  instHadBye,
  importedTeams,
  pairingsByRound,
  byeTeamIds,
  teamById
) {
  if (!pairingsByRound || typeof pairingsByRound !== "object") return;
  const rounds = Object.keys(pairingsByRound)
    .map((k) => parseInt(k, 10))
    .filter((r) => !Number.isNaN(r) && r >= 1)
    .sort((a, b) => a - b);
  for (const r of rounds) {
    const pr = pairingsByRound[r];
    if (!pr?.length) continue;
    const scheduled = collectScheduledTeamIdsInPairings(pr, byeTeamIds);
    for (const t of importedTeams || []) {
      const id = numericIdFromTeamApiRow(t);
      if (id == null || byeTeamIds.has(id)) continue;
      if (scheduled.has(id)) continue;
      teamHadBye.add(id);
      const row = teamById?.get(id);
      const sk = row ? deriveSchoolKeyFromTeam(row) : null;
      if (sk) instHadBye.add(sk);
      else if (row?.institution) instHadBye.add(row.institution);
    }
  }
}

/**
 * @param {object} aff
 * @param {object} neg
 * @param {Set<string>} rematch
 * @param {function} instKey
 * @returns {{ rematch: boolean, sameInstitution: boolean, noteLines: string[], severity: number, clashes: object[] }}
 */
export function analyzeDebatePairing(aff, neg, rematch, instKey) {
  if (!aff?.id || !neg?.id || aff.isPlaceholder || neg.isPlaceholder) {
    return { rematch: false, sameInstitution: false, noteLines: [], severity: 0, clashes: [] };
  }
  const a = aff;
  const b = neg;
  const key = teamEdgeKey(a, b);
  const isRem = rematch.has(key);
  const ka = instKey(a);
  const kb = instKey(b);
  const same = Boolean(ka && kb && ka === kb);
  const clashes = [];
  if (isRem) {
    clashes.push({
      kind: "rematch",
      priority: PRIORITY.rematch,
      short: "Rematch",
      detail: `${displayTeamLabel(a)} (id ${a.id}) and ${displayTeamLabel(b)} (id ${b.id}) already met in Tabbycat history. You should almost never see this: the generator pulls teams up across speaks brackets to avoid rematches until every other opponent in the bracket is exhausted.`,
    });
  }
  if (same) {
    clashes.push({
      kind: "inst",
      priority: PRIORITY.inst,
      short: "Same inst",
      detail: `Same institution key "${ka}" for ${displayTeamLabel(a)} and ${displayTeamLabel(b)} (merged school key from team name, or Tabbycat institution).`,
    });
  }
  const lines = clashes.map((c) => `${c.short}: ${c.detail}`);
  const severity = isRem ? 2 : same ? 1 : 0;
  return { rematch: isRem, sameInstitution: same, noteLines: lines, severity, clashes };
}

function clashInBracketPair(a, b, n, ia, ib, speaksBandLabel) {
  const target = n - 1;
  const sum = ia + ib;
  const slack = Math.abs(sum - target);
  if (slack === 0) return null;
  return {
    kind: "power",
    priority: PRIORITY.power,
    short: `Power: high–low +${slack}`,
    detail: `Fold (high–low) pairing within ${speaksBandLabel}: ${n} teams ranked 0…${n - 1} by total speaks only (0 = strongest). Ideal fold pairs ranks summing to ${target}; this pair is ${ia}+${ib}=${sum} (slack ${slack}). Deviation trades off against rematch and institution penalties.`,
  };
}

function clashFloaterPair(a, b) {
  const sa = speaksNum(a);
  const sb = speaksNum(b);
  const hi = sa >= sb ? a : b;
  const lo = sa >= sb ? b : a;
  const d = Math.abs(sa - sb);
  const short =
    d < 1e-6 ? "Floater (same spk)" : `Floater ${Math.round(Math.max(sa, sb))}↔${Math.round(Math.min(sa, sb))} spk`;
  return {
    kind: "power",
    priority: PRIORITY.power,
    short,
    detail: `Floater pool: ${displayTeamLabel(hi)} (${speaksNum(hi)} speaks) meets ${displayTeamLabel(lo)} (${speaksNum(lo)} speaks) after odd-bracket resolution. ${d >= 1e-6 ? "Teams come from different speaks bands or leftover pull-up chains." : "Same speaks band but outside the main fold brackets for this round."}`,
  };
}

function mergeClashLists(...lists) {
  const all = lists.flat().filter(Boolean);
  all.sort((x, y) => (x.priority || 9) - (y.priority || 9) || String(x.short).localeCompare(String(y.short)));
  return all;
}

/**
 * Build full clash list for a generated debate (before UI sync).
 */
export function buildDebateClashes({ aff, neg, rematch, instKey, powerClash, sideClash }) {
  const dyn = analyzeDebatePairing(aff, neg, rematch, instKey);
  const merged = mergeClashLists(powerClash ? [powerClash] : [], dyn.clashes, sideClash ? [sideClash] : []);
  const note = merged.map((c) => `${c.short}: ${c.detail}`).join("\n\n");
  return {
    clashes: merged,
    note,
    pairingRematch: dyn.rematch,
    pairingSameInst: dyn.sameInstitution,
    pairingPowerIssue: Boolean(powerClash),
  };
}

/**
 * Recompute clashes after UI edits (same team pair + powerMeta → keep bracket/floater story).
 */
export function computeLivePairingClashes(aff, neg, rematch, instKey, sideHist, powerMeta, generatedTeamKey) {
  const key = teamPairKey(aff, neg);
  const dyn = analyzeDebatePairing(aff, neg, rematch, instKey);
  let powerClash = null;
  if (generatedTeamKey && key === generatedTeamKey && powerMeta) {
    if (powerMeta.type === "inBracket") {
      const ra = powerMeta.idRank[aff.id];
      const rb = powerMeta.idRank[neg.id];
      if (ra !== undefined && rb !== undefined) {
        powerClash = clashInBracketPair(
          aff,
          neg,
          powerMeta.n,
          ra,
          rb,
          powerMeta.speaksBandLabel || "this speaks bracket"
        );
      }
    } else if (powerMeta.type === "floater") {
      powerClash = clashFloaterPair(aff, neg);
    }
  }
  const costDirect = sideAssignmentCost(aff, neg, sideHist);
  const costSwap = sideAssignmentCost(neg, aff, sideHist);
  const sideClash =
    costDirect > 0
      ? {
          kind: "side",
          priority: PRIORITY.side,
          short: `Sides +${costDirect}`,
          detail: `Side balance (lowest priority): current Aff/Neg vs prior Tabbycat rounds scores ${costDirect}; swapping sides would score ${costSwap}. ${displayTeamLabel(aff)}: ${sideHist.get(aff.id)?.aff ?? 0}A/${sideHist.get(aff.id)?.neg ?? 0}N; ${displayTeamLabel(neg)}: ${sideHist.get(neg.id)?.aff ?? 0}A/${sideHist.get(neg.id)?.neg ?? 0}N before this round.`,
        }
      : null;
  return buildDebateClashes({ aff, neg, rematch, instKey, powerClash, sideClash });
}

/**
 * @param {object} ctx
 * @param {object[]} ctx.mergedTeams
 * @param {Set} ctx.rematch
 * @param {Map} ctx.sideHist
 * @param {object} ctx.byeHist { teamHadBye, instHadBye }
 * @param {object} ctx.byePlaceholder { id, url }
 * @param {function} ctx.instKey (team) => string|null
 */
export function generateDraw(ctx) {
  const { mergedTeams, rematch, sideHist, byeHist, byePlaceholder, instKey } = ctx;
  const debates = [];
  const warnings = [];

  if (!byePlaceholder?.url) {
    warnings.push(
      "No team named BYE found in Tabbycat — cannot create bye debates. Add a BYE team or adjust detection."
    );
  }

  const pools = groupBy(mergedTeams, poolKey);
  for (const [key, raw] of pools) {
    let venueKey;
    let ts;
    try {
      [venueKey, ts] = JSON.parse(key);
    } catch {
      warnings.push(`Skip invalid pool key: ${key}`);
      continue;
    }
    if (!ts) {
      warnings.push(`Skip pool with empty timeslot: ${key}`);
      continue;
    }
    let pool = raw.filter((t) => t.venueKey && t.timeslot);
    if (!pool.length) continue;
    const venueLabel = raw.find((t) => t.venueLabel)?.venueLabel || venueKey;

    pool = pool.slice().sort((a, b) => speaksNum(b) - speaksNum(a) || a.id - b.id);

    const poolLabel = formatPoolLabel(venueLabel, ts);

    const phTeam = byePlaceholder?.url
      ? {
          id: byePlaceholder.id,
          url: byePlaceholder.url,
          short_name: "BYE",
          long_name: "BYE",
          isPlaceholder: true,
        }
      : null;

    if (pool.length % 2 === 1) {
      if (!phTeam) {
        warnings.push(
          `Pool ${formatPoolLabel(venueLabel, ts)} has odd teams but no BYE placeholder — skipped`
        );
        continue;
      }
      const byePick = pickByeTeam(pool, byeHist, instKey);
      const byeTeam = byePick?.team;
      if (!byeTeam) {
        warnings.push(`Pool ${formatPoolLabel(venueLabel, ts)} has odd teams but no bye candidate was available`);
        continue;
      }
      const byeNoteLines = byeAllocationNoteLines(byePick, poolLabel);
      pool = pool.filter((t) => t.id !== byeTeam.id);
      const affFirst =
        (sideHist.get(byeTeam.id)?.neg ?? 0) >= (sideHist.get(byeTeam.id)?.aff ?? 0);
      debates.push({
        kind: "bye",
        poolKey: key,
        poolLabel: formatPoolLabel(venueLabel, ts),
        venueKey,
        venueLabel,
        timeslot: ts,
        aff: affFirst ? byeTeam : phTeam,
        neg: affFirst ? phTeam : byeTeam,
        note: byeNoteLines.join("\n"),
        byeAllocationLogLines: byeNoteLines,
        bracketSectionId: "bye",
        bracketSectionLabel: "Bye (odd pool)",
        bracketSectionHover: "One team in this venue×timeslot had no opponent; paired with BYE placeholder.",
        included: true,
      });
    }

    const speakBrackets = buildRawSpeaksBrackets(pool);
    const floaters = [];
    resolveOddBracketsPullUp(speakBrackets, floaters, PULL_UP_FROM_TOP_OF_LOWER);

    const lastBracketIdx = findLastNonEmptyBracketIndex(speakBrackets);
    if (lastBracketIdx >= 0) mergeFloatersIntoBracketRow(speakBrackets[lastBracketIdx], floaters);

    const normPairs = [];
    for (let bi = 0; bi < speakBrackets.length; bi++) {
      const row = speakBrackets[bi];
      if (row.teams.length === 0) continue;
      const isLastBracket = bi === lastBracketIdx;
      normPairs.push(
        ...pairBracketWithRematchEscape(
          row,
          bi,
          speakBrackets,
          rematch,
          instKey,
          warnings,
          poolLabel,
          floaters,
          isLastBracket,
          normPairs
        )
      );
    }

    floaters.sort((x, y) => speaksNum(y.team) - speaksNum(x.team) || x.team.id - y.team.id);
    const { pairs: fpairs, rest } = pairFloaters(
      floaters.map((f) => f.team),
      rematch,
      instKey,
      warnings,
      poolLabel
    );
    for (let i = 0; i < fpairs.length; i++) {
      const [a, b] = fpairs[i];
      normPairs.push({ __floater: true, a, b });
    }
    if (rest.length === 1) {
      if (!phTeam) {
        warnings.push(
          `Odd floater in pool ${formatPoolLabel(venueLabel, ts)} — cannot assign bye without BYE team`
        );
      } else {
        warnings.push(`Odd floater in pool ${formatPoolLabel(venueLabel, ts)} — assigning bye`);
        const t = rest[0];
        const byeNoteLines = forcedFloaterByeNoteLines(t, poolLabel);
        const affFirst = (sideHist.get(t.id)?.neg ?? 0) >= (sideHist.get(t.id)?.aff ?? 0);
        debates.push({
          kind: "bye",
          poolKey: key,
          poolLabel: formatPoolLabel(venueLabel, ts),
          venueKey,
          venueLabel,
          timeslot: ts,
          aff: affFirst ? t : phTeam,
          neg: affFirst ? phTeam : t,
          note: byeNoteLines.join("\n"),
          byeAllocationLogLines: byeNoteLines,
          bracketSectionId: "bye-floater",
          bracketSectionLabel: "Bye (leftover floater)",
          bracketSectionHover: "Single team remained after floater pairing; assigned bye.",
          included: true,
        });
      }
    }

    for (const p of normPairs) {
      let a;
      let b;
      /** @type {string[]} */
      const auxScheduleNotes = [];
      /** @type {string} */
      let bracketSectionId;
      let bracketSectionLabel;
      let bracketSectionHover;
      /** @type {object|null} */
      let powerClash = null;

      if (p.__floater) {
        a = p.a;
        b = p.b;
        powerClash = clashFloaterPair(a, b);
        bracketSectionId = "floater";
        bracketSectionLabel = "Floater pool — cross speaks levels";
        bracketSectionHover =
          "Odd-bracket resolution left unmatched teams; they are paired here by minimum cost (rematch avoided first). Bracketing and rank elsewhere use total speaks only, not wins.";
      } else if (p.__inBracket) {
        [a, b] = [p.a, p.b];
        const sm = p.sectionMeta;
        bracketSectionId = sm?.sectionId ?? `spk-${p.bracketIdx ?? 0}`;
        bracketSectionLabel = sm?.label ?? p.speaksBandLabel ?? "Speaks bracket";
        bracketSectionHover =
          sm?.hover ??
          "Bracketing and fold pairing use total speaks only; wins are not used in the generator.";
        powerClash = clashInBracketPair(
          a,
          b,
          p.n,
          p.ia,
          p.ib,
          p.speaksBandLabel || sm.label
        );
      }

      const sides = pickSides(a, b, sideHist);
      const built = buildDebateClashes({
        aff: sides.aff,
        neg: sides.neg,
        rematch,
        instKey,
        powerClash,
        sideClash: sides.sideClash,
      });

      const idRank =
        p.__inBracket && p.a && p.b
          ? { [p.a.id]: p.ia, [p.b.id]: p.ib }
          : null;

      debates.push({
        kind: "debate",
        poolKey: key,
        poolLabel: formatPoolLabel(venueLabel, ts),
        venueKey,
        venueLabel,
        timeslot: ts,
        aff: sides.aff,
        neg: sides.neg,
        auxScheduleNotes,
        pairingClashes: built.clashes,
        note: built.note,
        pairingRematch: built.pairingRematch,
        pairingSameInst: built.pairingSameInst,
        pairingPowerIssue: built.pairingPowerIssue,
        _generatedTeamKey: teamPairKey(sides.aff, sides.neg),
        powerMeta: p.__floater
          ? { type: "floater" }
          : p.__inBracket && idRank
            ? {
                type: "inBracket",
                n: p.n,
                speaksBandLabel: p.speaksBandLabel || p.sectionMeta?.label || "speaks bracket",
                idRank,
              }
            : null,
        bracketSectionId,
        bracketSectionLabel,
        bracketSectionHover,
        included: true,
      });
    }
  }

  return { debates, warnings };
}
