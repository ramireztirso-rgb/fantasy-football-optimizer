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
 *
 * The fourth problem does not solve itself, and getting it wrong is what makes
 * a board draft a defence in the fourth round. An empty slot must not be valued
 * at what a freely available player gives you, because that is not the choice
 * anyone is making. Nobody filling a defence slot in round four is deciding
 * between a good defence and a bad one -- they are deciding between a good
 * defence now and an almost-as-good defence in round fifteen, which costs
 * nothing, because those are still there in round fifteen. So an unfilled slot
 * is valued at the best player you can still expect to get for it later. For
 * defences that is nearly the same player, so taking one early adds almost
 * nothing and it drops down the board. For a back in the middle of a run the
 * later option is far worse, so he rises. That difference is opportunity cost,
 * and here it is not an adjustment bolted on afterwards -- it is the
 * definition of what a player is worth.
 */

/**
 * The best player at each position you can still expect to be there at your
 * next turn.
 *
 * "Expect" is doing real work: a player is only counted if he is more likely
 * than not to last, so the number answers "what can I safely wait for" rather
 * than "what is the best thing that could conceivably fall to me". Where
 * nothing at a position is likely to last, the honest answer is a freely
 * available player, which is the replacement level.
 */
export function levelsAvailableLater(
  available: Array<{ player: Player; points: number }>,
  replacement: ReplacementLevels,
  survives: (player: Player) => number,
  threshold = 0.5,
): ReplacementLevels {
  const levels = { ...replacement };
  for (const pos of Object.keys(replacement) as Position[]) {
    let best = replacement[pos] ?? 0;
    for (const entry of available) {
      if (entry.player.position !== pos) continue;
      if (entry.points <= best) continue;
      if (survives(entry.player) < threshold) continue;
      best = entry.points;
    }
    levels[pos] = best;
  }
  return levels;
}

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
 * Games a startable player misses in a season, measured rather than guessed.
 *
 * Top thirty backs and receivers, top twelve quarterbacks and thirteen tight
 * ends by points per game, 2016-2025, ranked per game precisely so that
 * missing time does not eject a player from the sample being asked about it.
 * These are floors: the eight-game qualifying bar hides season-ending
 * injuries. Kickers and defences are zero by design -- their absences are
 * streamed off the wire, never covered from the bench.
 */
const MISSED_GAMES: Partial<Record<Position, number>> = {
  QB: 1.3,
  RB: 2.0,
  WR: 1.6,
  TE: 2.1,
  K: 0,
  DST: 0,
};

/**
 * Points a bench player is worth as cover.
 *
 * Starters miss time and somebody has to play those weeks. That is real value
 * the lineup calculation cannot see, because it only ever looks at a healthy
 * week. So it is added explicitly, in points.
 *
 * The fill weeks are per position and per starter, not a flat constant. A
 * bench back covers two starting slots whose occupants each miss about two
 * games plus a bye -- around six fill weeks -- where a backup quarterback
 * covers one durable starter for nearer two. The old flat two weeks priced
 * those identically, and the visible symptom was rosters drafted with two
 * running backs for two starting slots: legal, and one hamstring from
 * starting a waiver claim in the playoffs.
 *
 * Halves for every backup already held. The first is cover; the fourth is a
 * roster spot.
 */
function depthValue(
  player: Player,
  points: number,
  ctx: MarginalValueContext,
): number {
  const sameSlot = ctx.roster.filter((r) => r.player.position === player.position).length;
  const levels = ctx.levels[player.position] ?? 0;
  const overFree = Math.max(0, points - levels);
  const starters = startersAt(player.position, ctx.settings);
  const fillWeeks = starters * ((MISSED_GAMES[player.position] ?? 1.5) + 1);
  const weeks = fillWeeks / Math.pow(2, Math.max(0, sameSlot - starters));
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
