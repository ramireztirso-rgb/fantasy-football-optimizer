import type { LeagueSettings, Position } from "@/lib/domain/types";
import type { SeasonStatLine } from "@/lib/sources/nflverse";

/**
 * Scores a raw stat line under this league's own rules.
 *
 * Outside data arrives as production -- catches, yards, touchdowns, first
 * downs -- and every published ranking converts that to points under standard
 * or PPR before you see it. Those are different leagues. This one pays
 * receivers half a point per catch and running backs nothing, half a point per
 * first down to everyone who can gain one, and 5.5 for a skill-position
 * touchdown. A back priced by a half-PPR list is priced in a league that does
 * not exist.
 *
 * So the conversion happens here, from counting stats, using the rules the
 * league actually publishes -- including the per-position splits, which is why
 * every lookup passes a position.
 */

/** Which stat line field each ESPN stat id counts. */
const STAT_FIELDS: Record<number, keyof SeasonStatLine> = {
  3: "passingYards",
  4: "passingTds",
  20: "interceptions",
  24: "rushingYards",
  25: "rushingTds",
  42: "receivingYards",
  43: "receivingTds",
  53: "receptions",
  72: "fumblesLost",
  211: "passingFirstDowns",
  212: "rushingFirstDowns",
  213: "receivingFirstDowns",

  // Kicking. Stat 83 subtracting a point per made field goal looks wrong and is
  // not: leagues that pay by distance use 214 for the yardage and 83 as the
  // constant that calibrates it, so forty yards comes to 4.0 - 1 = 3.0.
  214: "fieldGoalYards",
  83: "fieldGoalsMade",
  79: "fieldGoalsMissedMedium",
  82: "fieldGoalsMissedLong",
  86: "extraPointsMade",
  88: "extraPointsMissed",
};

export interface ScoredStatLine {
  points: number;
  pointsPerGame: number;
  /** Points contributed by each stat id, for explaining a number. */
  breakdown: Array<{ statId: number; units: number; points: number }>;
}

/**
 * A line to score. Weekly and season lines both qualify -- only the counting
 * stats matter, and `games` exists solely to turn a total into a rate.
 */
export type ScorableLine = Omit<SeasonStatLine, "games"> & { games?: number };

export function scoreStatLine(
  line: ScorableLine,
  settings: LeagueSettings,
  position: Position,
): ScoredStatLine {
  const breakdown: ScoredStatLine["breakdown"] = [];
  let points = 0;

  for (const rule of settings.scoringRules) {
    const field = STAT_FIELDS[rule.statId];
    if (!field) continue;

    const units = line[field];
    if (typeof units !== "number" || units === 0) continue;

    // A position absent from an override map earns nothing for the stat, which
    // is the whole point: this is how the league expresses "backs get no PPR".
    const perUnit = rule.pointsByPosition ? (rule.pointsByPosition[position] ?? 0) : rule.points;
    if (!perUnit) continue;

    const earned = units * perUnit;
    points += earned;
    breakdown.push({ statId: rule.statId, units, points: round2(earned) });
  }

  breakdown.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const games = line.games ?? 1;
  return {
    points: round2(points),
    pointsPerGame: games > 0 ? round2(points / games) : 0,
    breakdown,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
