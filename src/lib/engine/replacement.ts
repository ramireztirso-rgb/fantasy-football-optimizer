import type { LeagueSettings, Player, Position } from "@/lib/domain/types";
import { SLOT_ELIGIBILITY } from "@/lib/espn/constants";
import type { Projection } from "./projections";

/**
 * Value Over Replacement Player.
 *
 * Raw projected points are close to useless for comparing across positions: in
 * a 12-team league the 12th-best QB is a shrug, while the 12th-best TE is a
 * genuine edge. VORP fixes that by measuring each player against the *worst
 * player you could start at their position without paying anything* -- which is
 * the real alternative to rostering them.
 */

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * How flex slots historically break down across eligible positions. Flex is
 * dominated by RB and WR in practice even though TE is eligible.
 */
const FLEX_SHARE: Partial<Record<Position, number>> = { RB: 0.45, WR: 0.45, TE: 0.1 };

export type ReplacementLevels = Record<Position, number>;

/**
 * How many players at each position the league as a whole starts every week.
 * This is the index into the sorted pool where "replacement" begins.
 */
export function starterDemand(settings: LeagueSettings): Record<Position, number> {
  const demand: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
  const size = settings.size || 10;

  for (const { slot, count } of settings.lineupSlots) {
    const eligible = (SLOT_ELIGIBILITY[slot] ?? []) as Position[];
    if (eligible.length === 1) {
      demand[eligible[0]] += count * size;
      continue;
    }
    // Multi-position slot: split by expected usage across the eligible set,
    // renormalized so an unusual flex (RB/WR only, or superflex) still sums to
    // the full slot count.
    const weights = eligible.map((p) => FLEX_SHARE[p] ?? 0.25);
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    eligible.forEach((pos, i) => {
      demand[pos] += count * size * (weights[i] / totalWeight);
    });
  }
  return demand;
}

/**
 * Replacement level per position: the projected points of the last startable
 * player at that position across the league.
 */
export function computeReplacementLevels(
  projections: Projection[],
  settings: LeagueSettings,
): ReplacementLevels {
  const demand = starterDemand(settings);
  const levels = {} as ReplacementLevels;

  for (const pos of POSITIONS) {
    const pool = projections
      .filter((p) => p.player.position === pos)
      .map((p) => p.points)
      .sort((a, b) => b - a);

    if (!pool.length) {
      levels[pos] = 0;
      continue;
    }
    // Index of the first player past the league's starting demand. Clamped so
    // a short pool falls back to its own tail rather than going out of bounds.
    const index = Math.min(Math.max(1, Math.round(demand[pos])), pool.length) - 1;
    levels[pos] = pool[index] ?? pool[pool.length - 1];
  }
  return levels;
}

/**
 * How many more starters a roster needs at each position, as a soft count.
 * Flex demand is spread across its eligible positions, so a team one flex short
 * shows partial need at RB, WR, and TE rather than a whole one at each.
 */
export function rosterNeed(
  roster: Player[],
  settings: LeagueSettings,
): Record<Position, number> {
  const demand = starterDemand(settings);
  const size = settings.size || 10;
  const need = {} as Record<Position, number>;
  const have = {} as Record<Position, number>;

  for (const pos of POSITIONS) have[pos] = 0;
  for (const p of roster) have[p.position] = (have[p.position] ?? 0) + 1;

  for (const pos of POSITIONS) {
    // starterDemand is league-wide; divide back down to one team.
    const perTeam = demand[pos] / size;
    need[pos] = Math.max(0, round2(perTeam - have[pos]));
  }
  return need;
}

export function vorp(projection: Projection, levels: ReplacementLevels): number {
  return round2(projection.points - (levels[projection.player.position] ?? 0));
}

export interface Tier {
  tier: number;
  /** Points between this tier and the next one down. */
  dropoff: number;
  /** How many players remain in this tier. */
  remaining: number;
}

/**
 * Groups a position's pool into tiers by finding scoring cliffs.
 *
 * The practical question in a draft is never "who is best" but "is there a
 * cliff right after this group". A tier break is declared where the gap to the
 * next player exceeds `sensitivity` standard deviations of the typical gap.
 */
export function assignTiers(
  projections: Projection[],
  sensitivity = 1.15,
): Map<number, Tier> {
  const sorted = [...projections].sort((a, b) => b.points - a.points);
  const result = new Map<number, Tier>();
  if (sorted.length < 2) {
    if (sorted[0]) result.set(sorted[0].player.id, { tier: 1, dropoff: 0, remaining: 1 });
    return result;
  }

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i - 1].points - sorted[i].points);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sdGap = Math.sqrt(
    gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / Math.max(1, gaps.length - 1),
  );
  const threshold = meanGap + sensitivity * sdGap;

  // First pass: assign tier numbers.
  let tier = 1;
  const tierOf: number[] = [1];
  for (let i = 1; i < sorted.length; i++) {
    if (gaps[i - 1] > threshold) tier += 1;
    tierOf.push(tier);
  }

  // Second pass: per-tier size, and the dropoff to the next tier.
  const counts = new Map<number, number>();
  for (const t of tierOf) counts.set(t, (counts.get(t) ?? 0) + 1);

  for (let i = 0; i < sorted.length; i++) {
    const myTier = tierOf[i];
    const remaining = countRemainingInTier(tierOf, i, myTier);
    // Dropoff is measured at the tier boundary, so everyone in a tier shares it.
    const boundary = lastIndexOfTier(tierOf, myTier);
    const dropoff =
      boundary + 1 < sorted.length ? sorted[boundary].points - sorted[boundary + 1].points : 0;
    result.set(sorted[i].player.id, {
      tier: myTier,
      dropoff: round2(dropoff),
      remaining,
    });
    void counts;
  }
  return result;
}

function countRemainingInTier(tierOf: number[], from: number, tier: number): number {
  let n = 0;
  for (let i = from; i < tierOf.length && tierOf[i] === tier; i++) n++;
  return n;
}

function lastIndexOfTier(tierOf: number[], tier: number): number {
  let last = -1;
  for (let i = 0; i < tierOf.length; i++) if (tierOf[i] === tier) last = i;
  return last;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
