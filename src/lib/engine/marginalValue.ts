import { SLOT_ELIGIBILITY } from "@/lib/espn/constants";
import type { LeagueSettings, Player, Position } from "@/lib/domain/types";
import { expandSlots } from "./lineup";
import { maxValueAssignment } from "./assignment";
import type { ReplacementLevels } from "./replacement";

/**
 * How many more points your starting lineup would score if you took this
 * player.
 *
 * The board's older measure grades the player: how much better is he than a
 * freely available one at his position. That sounds like the same question and
 * is not, because it takes no notice of whether you can actually start him. It
 * will happily rank a sixth running back above a receiver you would put in your
 * lineup this week, and it did.
 *
 * This asks about the roster instead. Work out the best legal lineup as things
 * stand, counting any slot you have not filled as filled by a freely available
 * player -- which is honestly what you would be starting. Then work it out
 * again with the candidate added. The difference is what he is worth, in
 * points.
 *
 * Three problems solve themselves. A player who cannot crack the lineup scores
 * near zero without needing a penalty. Positions compare directly, because
 * every number is points added to one particular lineup. And the value can
 * never come out negative, since adding a player cannot make your best lineup
 * worse -- which is where the older measure kept going wrong.
 */

/** Points a freely available player would give you in a slot. */
function replacementForSlot(slot: string, levels: ReplacementLevels): number {
  const eligible = (SLOT_ELIGIBILITY[slot] ?? []) as Position[];
  let best = 0;
  for (const pos of eligible) best = Math.max(best, levels[pos] ?? 0);
  return best;
}

function eligibleFor(player: Player, slot: string): boolean {
  if (player.eligibleSlots.length) return player.eligibleSlots.includes(slot);
  return (SLOT_ELIGIBILITY[slot] ?? []).includes(player.position);
}

/**
 * Best lineup this roster can field, with unfilled slots valued at what a
 * freely available player would give you there.
 */
export function bestLineupPoints(
  roster: Array<{ player: Player; points: number }>,
  slots: string[],
  levels: ReplacementLevels,
): number {
  const floors = slots.map((slot) => replacementForSlot(slot, levels));
  if (!roster.length) return floors.reduce((a, b) => a + b, 0);

  // Only the amount a real player beats the freely available option by is up
  // for grabs, so the assignment maximises exactly the thing we care about and
  // never puts someone in a slot he would make worse.
  // Padded so there are never fewer candidates than slots: the assignment needs
  // a square-or-wider matrix, and a short roster is the normal case early in a
  // draft. A padding column is worth nothing, which correctly means the slot
  // stays on its freely-available floor.
  const columns = Math.max(slots.length, roster.length);
  const value = slots.map((slot, i) =>
    Array.from({ length: columns }, (_, j) => {
      const entry = roster[j];
      if (!entry) return 0;
      return eligibleFor(entry.player, slot) ? Math.max(0, entry.points - floors[i]) : 0;
    }),
  );

  const assignment = maxValueAssignment(value);
  let gain = 0;
  for (let i = 0; i < slots.length; i++) {
    const col = assignment[i];
    if (col >= 0 && value[i][col] > 0) gain += value[i][col];
  }
  return floors.reduce((a, b) => a + b, 0) + gain;
}

export interface MarginalValueContext {
  settings: LeagueSettings;
  levels: ReplacementLevels;
  /** Current roster with the projection each player is being valued at. */
  roster: Array<{ player: Player; points: number }>;
  /** Picks left after this one, used to price depth. */
  picksRemaining: number;
}

/**
 * Points a bench player is worth as cover.
 *
 * Starters miss time -- injuries and a bye each season -- and somebody has to
 * play those weeks. That is real value and the lineup calculation cannot see
 * it, because it only ever looks at a healthy week. So it is added explicitly,
 * in points, and it shrinks for every backup already held: the first is cover,
 * the fourth is a roster spot.
 */
function depthValue(
  player: Player,
  points: number,
  ctx: MarginalValueContext,
): number {
  const sameSlot = ctx.roster.filter((r) => r.player.position === player.position).length;
  const levels = ctx.levels[player.position] ?? 0;
  const overFree = Math.max(0, points - levels);
  // About two weeks of a seventeen-week season, halving per backup already held.
  const weeks = 2 / Math.pow(2, Math.max(0, sameSlot - startersAt(player.position, ctx.settings)));
  return (overFree * weeks) / 17;
}

function startersAt(position: Position, settings: LeagueSettings): number {
  let n = 0;
  for (const { slot, count } of settings.lineupSlots) {
    const eligible = (SLOT_ELIGIBILITY[slot] ?? []) as Position[];
    if (eligible.length === 1 && eligible[0] === position) n += count;
  }
  return Math.max(1, n);
}

export function marginalValue(
  player: Player,
  points: number,
  ctx: MarginalValueContext,
): number {
  const slots = expandSlots(ctx.settings);
  const before = bestLineupPoints(ctx.roster, slots, ctx.levels);
  const after = bestLineupPoints([...ctx.roster, { player, points }], slots, ctx.levels);
  const starting = Math.max(0, after - before);
  return round2(starting + depthValue(player, points, ctx));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
