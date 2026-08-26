import type { DraftPick, Position } from "@/lib/domain/types";

/**
 * League draft tendencies, learned from past drafts.
 *
 * National ADP describes how the average of millions of drafters behaves. It
 * does not describe the eleven people in your league, and the gap between those
 * two is the most reliable edge available before a draft starts. A league that
 * habitually takes quarterbacks two rounds early is a league where you should
 * never take one early -- the value falls to you at every other position.
 *
 * Everything here is measured, with sample sizes reported, because a tendency
 * drawn from one draft is a coincidence.
 */

export interface PositionTendency {
  position: Position;
  /** Mean overall pick this league spends on the position. */
  leagueMeanPick: number;
  /** Mean national ADP of the same players, from the same season. Often null. */
  nationalMeanAdp: number | null;
  /**
   * Positive means this league drafts the position *earlier* than the market.
   * Measured in picks. Null whenever same-season ADP was unavailable, which is
   * the common case for past seasons.
   */
  reachPicks: number | null;
  /** Share of this league's early picks (rounds 1-3) spent here, 0-1. */
  earlyShare: number;
  /** Share the market spends on the position over the same number of picks. */
  marketEarlyShare: number | null;
  /**
   * earlyShare minus marketEarlyShare. The year-robust bias measure: position
   * mix by round is stable across seasons in a way individual ADP is not.
   */
  earlyBias: number | null;
  /** Number of picks this is based on. */
  sample: number;
  /** How many went in each of the first six rounds. */
  byRound: number[];
  detail: string;
}

export interface ManagerTendency {
  teamId: number;
  name: string;
  /** Positions taken in rounds 1-3, most recent draft first. */
  earlyPattern: Position[];
  /** Short characterization, e.g. "RB-heavy early". */
  label: string;
  sample: number;
}

export interface DraftTendencies {
  seasonsAnalyzed: number[];
  totalPicks: number;
  /** Share of drafted players whose position could be resolved, 0-1. */
  coverage: number;
  /** True when same-season ADP was available, enabling `reachPicks`. */
  adpComparable: boolean;
  positions: PositionTendency[];
  managers: ManagerTendency[];
  /** Ranked, actionable takeaways. */
  insights: string[];
}

export interface HistoricalDraft {
  seasonId: number;
  picks: DraftPick[];
}

export interface PlayerReference {
  position: Position;
  /** National ADP, valid only for `adpSeason`. */
  averageDraftPosition?: number;
  /**
   * The season this ADP describes.
   *
   * Required, because ADP is not comparable across years: a back who broke out
   * last season carries an ADP near 200 for the year before and near 15 for the
   * year after. Comparing a 2024 pick against a 2026 ADP measures the player's
   * career arc, not the league's behaviour. When this does not match the season
   * of the pick, the ADP is ignored rather than silently misused.
   */
  adpSeason?: number;
}

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

export function analyzeDraftTendencies(
  drafts: HistoricalDraft[],
  playerInfo: Map<number, PlayerReference>,
  teamNames: Map<number, string>,
  /**
   * Positions of the top players by current national ADP, in ADP order. Used to
   * build the market's expected position mix for the early rounds -- a
   * comparison that stays valid across seasons because *how many* quarterbacks
   * go in round one barely moves year to year, even as *which* ones does.
   */
  marketOrder: Position[] = [],
): DraftTendencies {
  const allPicks = drafts.flatMap((d) => d.picks.filter((p) => !p.keeper));
  const resolved = allPicks.filter((p) => playerInfo.has(p.playerId));

  // Same-season ADP only. Anything else measures the player, not the league.
  const seasonOf = new Map<number, number>();
  for (const draft of drafts) {
    for (const pick of draft.picks) seasonOf.set(pick.playerId, draft.seasonId);
  }
  const sameSeasonAdp = (playerId: number): number | undefined => {
    const info = playerInfo.get(playerId);
    if (!info || info.adpSeason === undefined) return undefined;
    if (info.adpSeason !== seasonOf.get(playerId)) return undefined;
    return Number.isFinite(info.averageDraftPosition) ? info.averageDraftPosition : undefined;
  };

  const earlyPicks = resolved.filter((p) => p.round <= 3);
  const marketEarly = marketOrder.slice(0, earlyPicks.length);

  let adpComparable = false;
  const positions: PositionTendency[] = [];
  for (const position of POSITIONS) {
    const picks = resolved.filter((p) => playerInfo.get(p.playerId)!.position === position);
    if (picks.length < 3) continue;

    const leagueMeanPick = mean(picks.map((p) => p.overallPick));
    const adps = picks
      .map((p) => sameSeasonAdp(p.playerId))
      .filter((a): a is number => typeof a === "number");
    const nationalMeanAdp = adps.length >= 3 ? mean(adps) : null;
    if (nationalMeanAdp !== null) adpComparable = true;
    const reachPicks = nationalMeanAdp === null ? null : round1(nationalMeanAdp - leagueMeanPick);

    const byRound = Array.from({ length: 6 }, (_, i) => picks.filter((p) => p.round === i + 1).length);

    const earlyShare = earlyPicks.length
      ? round2(picks.filter((p) => p.round <= 3).length / earlyPicks.length)
      : 0;
    const marketEarlyShare = marketEarly.length
      ? round2(marketEarly.filter((p) => p === position).length / marketEarly.length)
      : null;
    const earlyBias =
      marketEarlyShare === null ? null : round2(earlyShare - marketEarlyShare);

    positions.push({
      position,
      leagueMeanPick: round1(leagueMeanPick),
      nationalMeanAdp: nationalMeanAdp === null ? null : round1(nationalMeanAdp),
      reachPicks,
      earlyShare,
      marketEarlyShare,
      earlyBias,
      sample: picks.length,
      byRound,
      detail: describePosition(position, leagueMeanPick, reachPicks, earlyBias, picks.length, byRound),
    });
  }
  positions.sort(
    (a, b) => Math.abs(b.earlyBias ?? 0) - Math.abs(a.earlyBias ?? 0) ||
      Math.abs(b.reachPicks ?? 0) - Math.abs(a.reachPicks ?? 0),
  );

  const managers = analyzeManagers(drafts, playerInfo, teamNames);

  return {
    seasonsAnalyzed: drafts.map((d) => d.seasonId).sort(),
    totalPicks: allPicks.length,
    coverage: allPicks.length ? round2(resolved.length / allPicks.length) : 0,
    adpComparable,
    positions,
    managers,
    insights: buildInsights(positions, managers, drafts.length, adpComparable),
  };
}

function describePosition(
  position: Position,
  meanPick: number,
  reachPicks: number | null,
  earlyBias: number | null,
  sample: number,
  byRound: number[],
): string {
  const earlyCount = byRound.slice(0, 3).reduce((a, b) => a + b, 0);
  const base = `${sample} ${position}${sample === 1 ? "" : "s"} drafted, average pick ${meanPick.toFixed(0)}, ${earlyCount} in the first three rounds.`;

  // Early-round position mix is the year-robust signal; ADP reach is reported
  // only when it could be computed against the same season.
  if (earlyBias !== null && Math.abs(earlyBias) >= 0.06) {
    const pct = Math.abs(earlyBias * 100).toFixed(0);
    return earlyBias > 0
      ? `${base} ${pct}% more of this league's early picks go to ${position} than the market spends over the same span -- the position is systematically overpriced here.`
      : `${base} ${pct}% less of this league's early picks go to ${position} than the market spends over the same span, so ${position} value lasts longer than a generic cheat sheet suggests.`;
  }
  if (reachPicks !== null && Math.abs(reachPicks) >= 8) {
    return reachPicks > 0
      ? `${base} Taken about ${reachPicks.toFixed(0)} picks earlier than that season's ADP.`
      : `${base} Allowed to slide about ${Math.abs(reachPicks).toFixed(0)} picks past that season's ADP.`;
  }
  return `${base} Drafted broadly in line with the market.`;
}

function analyzeManagers(
  drafts: HistoricalDraft[],
  playerInfo: Map<number, PlayerReference>,
  teamNames: Map<number, string>,
): ManagerTendency[] {
  const byTeam = new Map<number, { early: Position[]; drafts: Set<number> }>();

  for (const draft of drafts) {
    for (const pick of draft.picks) {
      if (pick.keeper || pick.round > 3) continue;
      const info = playerInfo.get(pick.playerId);
      if (!info) continue;
      const entry = byTeam.get(pick.teamId) ?? { early: [], drafts: new Set<number>() };
      entry.early.push(info.position);
      entry.drafts.add(draft.seasonId);
      byTeam.set(pick.teamId, entry);
    }
  }

  const out: ManagerTendency[] = [];
  for (const [teamId, entry] of byTeam) {
    if (entry.early.length < 3) continue;
    out.push({
      teamId,
      name: teamNames.get(teamId) ?? `Team ${teamId}`,
      earlyPattern: entry.early,
      label: labelPattern(entry.early),
      sample: entry.drafts.size,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function labelPattern(positions: Position[]): string {
  const counts = new Map<Position, number>();
  for (const p of positions) counts.set(p, (counts.get(p) ?? 0) + 1);
  const total = positions.length;

  const rb = (counts.get("RB") ?? 0) / total;
  const wr = (counts.get("WR") ?? 0) / total;
  const qb = (counts.get("QB") ?? 0) / total;
  const te = (counts.get("TE") ?? 0) / total;

  if (qb >= 0.3) return "Takes a QB early";
  if (te >= 0.3) return "Pays up for TE";
  if (rb >= 0.6) return "RB-heavy early";
  if (wr >= 0.6) return "WR-heavy early";
  return "Balanced early";
}

function buildInsights(
  positions: PositionTendency[],
  managers: ManagerTendency[],
  draftCount: number,
  adpComparable: boolean,
): string[] {
  const out: string[] = [];

  if (draftCount === 0) {
    return ["No completed drafts were available for this league, so there are no historical tendencies yet."];
  }
  if (draftCount === 1) {
    out.push(
      `Based on a single draft. Treat everything below as a hint rather than a pattern -- one draft cannot distinguish a tendency from a coincidence.`,
    );
  }

  if (!adpComparable) {
    out.push(
      `Same-season ADP was not available for these drafts, so the analysis below compares how this league spends its early picks by position against the market's own position mix. That comparison holds across seasons; a pick-by-pick ADP reach would not.`,
    );
  }

  for (const p of positions.slice(0, 3)) {
    if (p.earlyBias !== null && Math.abs(p.earlyBias) >= 0.06) {
      const pct = Math.abs(p.earlyBias * 100).toFixed(0);
      out.push(
        p.earlyBias > 0
          ? `This league spends ${pct}% more of its early picks on ${p.position} than the market does. Do not chase it -- let them overpay and take the value falling at other positions.`
          : `This league spends ${pct}% less of its early picks on ${p.position} than the market does, so ${p.position} value lasts longer here than a generic cheat sheet says.`,
      );
    } else if (p.reachPicks !== null && Math.abs(p.reachPicks) >= 8) {
      out.push(
        p.reachPicks > 0
          ? `${p.position} went about ${p.reachPicks.toFixed(0)} picks earlier than that season's ADP.`
          : `${p.position} slid about ${Math.abs(p.reachPicks).toFixed(0)} picks past that season's ADP.`,
      );
    }
  }

  const qbEarly = managers.filter((m) => m.label === "Takes a QB early").length;
  if (qbEarly >= 3) {
    out.push(
      `${qbEarly} managers habitually take a quarterback in the first three rounds. Expect the position to clear faster than ADP implies, and decide in advance whether you are getting in front of that or fading it entirely.`,
    );
  }

  const rbHeavy = managers.filter((m) => m.label === "RB-heavy early").length;
  if (rbHeavy >= Math.max(3, managers.length * 0.4)) {
    out.push(
      `${rbHeavy} managers open RB-heavy. Running back will be thin by round four, but receivers will be unusually good value in rounds two and three.`,
    );
  }

  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
