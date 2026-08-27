import type { LeagueSettings, Position } from "@/lib/domain/types";
import type { SeasonStatLine } from "@/lib/sources/nflverse";
import { scoreStatLine } from "./scoreFromStats";

/**
 * A projection built from a player's own production rather than a forecast.
 *
 * ESPN's season projection already applies this league's scoring, so
 * re-scoring the same volume adds nothing. What is missing is a *second
 * opinion on the volume itself*. This builds one from what the player actually
 * did, weighted toward recent seasons and regressed toward his position's
 * baseline in proportion to how little evidence there is.
 *
 * It is deliberately backward-looking, and that is a limitation rather than a
 * design goal: it knows nothing about a change of team, a new offensive
 * coordinator, a rookie who has never played, or a back who just lost his job.
 * ESPN's forecast knows all of those and this does not.
 *
 * So it is not a replacement. Its use is disagreement. When a player's own
 * three-year rate says 180 points and the forecast says 240, one of them is
 * pricing in a change that either will or will not happen, and that gap is
 * worth surfacing to a manager about to spend a second-round pick.
 */

/** How much each season back counts. A career is not a uniform average. */
const SEASON_WEIGHTS = [0.6, 0.28, 0.12];

/**
 * Half-weight sample size, in games.
 *
 * Calibrated rather than chosen. Every player-season since 2016 was projected
 * forward under each candidate setting and scored against what actually
 * happened, and four games wins at 2.389 points a game of average error.
 *
 * The previous value of sixteen was not merely suboptimal, it was harmful: at
 * 2.552 it predicted worse than applying no shrink whatsoever, which comes in
 * at 2.473. A player who has played is more informative about himself than the
 * population is, far sooner than the old setting allowed, and shrinking a
 * three-season veteran a quarter of the way toward the median is how Justin
 * Jefferson ended up among the players the model thought were over-rated.
 *
 * See `npm run calibrate`.
 */
const REGRESSION_GAMES = 4;

/** Games a healthy starter is assumed available for. */
const EXPECTED_GAMES = 16;

export interface AgeAdjustment {
  /** Age the player was during each historical season, keyed by season. */
  ageBySeason: Map<number, number>;
  /** Age he will be in the season being projected. */
  targetAge: number;
  /** Expected change in points a game between two ages. */
  between(fromAge: number, toAge: number): number;
}

export interface ComponentProjection {
  /** Season points under this league's rules, from the player's own rates. */
  points: number;
  pointsPerGame: number;
  /** Games of history behind it. */
  gamesOfHistory: number;
  /** Seasons that contributed, most recent first. */
  seasons: number[];
  /** 0-1: how far the estimate was pulled toward the positional baseline. */
  regression: number;
  /**
   * Points a game added or removed for the player getting a year older.
   * Zero when no age was available, which is not the same as zero effect.
   */
  ageAdjustment: number;
}

/**
 * Points per game for a replacement-level player at each position, measured
 * from the same data rather than assumed, so it moves with the league's rules.
 */
export function positionalBaselines(
  linesByPosition: Map<Position, SeasonStatLine[]>,
  settings: LeagueSettings,
): Partial<Record<Position, number>> {
  const baselines: Partial<Record<Position, number>> = {};

  for (const [position, lines] of linesByPosition) {
    const rates = lines
      .filter((l) => l.games >= 4)
      .map((l) => scoreStatLine(l, settings, position).pointsPerGame)
      .sort((a, b) => b - a);
    if (!rates.length) continue;
    // The median of everyone who played is a fair stand-in for "the guy you
    // could have had instead"; the mean is dragged around by stars.
    baselines[position] = rates[Math.floor(rates.length / 2)];
  }
  return baselines;
}

export function componentProjection(
  history: SeasonStatLine[],
  settings: LeagueSettings,
  position: Position,
  baseline: number,
  aging?: AgeAdjustment,
): ComponentProjection | null {
  const recent = [...history].sort((a, b) => b.season - a.season).slice(0, SEASON_WEIGHTS.length);
  if (!recent.length) return null;

  let weightedRate = 0;
  let weightUsed = 0;
  let gamesOfHistory = 0;

  recent.forEach((line, i) => {
    if (line.games <= 0) return;
    const scored = scoreStatLine(line, settings, position);
    // Weight by recency and by how much of the season the player was available
    // for: eight games is half the evidence of sixteen, whatever the rate says.
    const weight = SEASON_WEIGHTS[i] * Math.min(1, line.games / EXPECTED_GAMES);
    // Each season is carried forward to the age the player will actually be.
    // Without this the estimate quietly assumes he stays the age he was, which
    // is the one thing certain to be false, and the error compounds the further
    // back the season sits.
    const wasAged = aging?.ageBySeason.get(line.season);
    const carried =
      aging && wasAged !== undefined ? aging.between(wasAged, aging.targetAge) : 0;
    weightedRate += (scored.pointsPerGame + carried) * weight;
    weightUsed += weight;
    gamesOfHistory += line.games;
  });

  if (weightUsed <= 0) return null;
  const ownRate = weightedRate / weightUsed;

  // Reported separately so a reader can see how much of the projection is the
  // player and how much is the calendar.
  const unadjusted = recent.reduce((sum, line, i) => {
    if (line.games <= 0) return sum;
    const weight = SEASON_WEIGHTS[i] * Math.min(1, line.games / EXPECTED_GAMES);
    return sum + scoreStatLine(line, settings, position).pointsPerGame * weight;
  }, 0) / weightUsed;

  // Shrink toward the positional baseline. A player with four games of history
  // is mostly baseline; one with three full seasons is mostly himself.
  const regression = REGRESSION_GAMES / (REGRESSION_GAMES + gamesOfHistory);
  const rate = ownRate * (1 - regression) + baseline * regression;

  return {
    points: round2(rate * EXPECTED_GAMES),
    pointsPerGame: round2(rate),
    gamesOfHistory,
    seasons: recent.map((l) => l.season),
    regression: round2(regression),
    ageAdjustment: round2(ownRate - unadjusted),
  };
}

export interface ProjectionDisagreement {
  /** ESPN's forecast for the season, in this league's points. */
  forecast: number;
  /** What the player's own recent rates say. */
  fromOwnProduction: number;
  /** forecast minus own production, in points. */
  gap: number;
  /** The gap as a share of the player's own rate. */
  relativeGap: number;
  /** Plain-language reading, or null when the two broadly agree. */
  note: string | null;
}

/**
 * Compares a forecast against a player's own production.
 *
 * Deliberately does not adjudicate. A large gap on a young player usually
 * means the forecast is pricing in a role that has not shown up in the data
 * yet, and it is often right; the same gap on a thirty-year-old back usually
 * means it has not noticed something. The manager knows which they are looking
 * at and the model does not.
 */
export function compareToForecast(
  forecast: number,
  own: ComponentProjection,
  playerName: string,
): ProjectionDisagreement {
  const gap = round2(forecast - own.points);
  const relativeGap = own.points > 0 ? round2(gap / own.points) : 0;

  let note: string | null = null;
  if (own.regression > 0.5) {
    note = null; // Too little history for the comparison to mean anything.
  } else if (relativeGap >= 0.25) {
    note = `ESPN projects ${forecast.toFixed(0)} for ${playerName}, ${(relativeGap * 100).toFixed(0)}% above what his own last ${own.gamesOfHistory} games produce under these rules (${own.points.toFixed(0)}). The forecast is pricing in a step up that has not happened yet.`;
  } else if (relativeGap <= -0.2) {
    note = `ESPN projects ${forecast.toFixed(0)} for ${playerName}, ${(Math.abs(relativeGap) * 100).toFixed(0)}% below his own rate over the last ${own.gamesOfHistory} games (${own.points.toFixed(0)}). Either the forecast sees a lost role, or he is being underpriced.`;
  }

  return { forecast, fromOwnProduction: own.points, gap, relativeGap, note };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
