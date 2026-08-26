import type { LeagueSettings, Team } from "@/lib/domain/types";
import { optimizeLineup } from "./lineup";
import type { Projection } from "./projections";

/**
 * Monte Carlo matchup and season simulation.
 *
 * Projected points decide who is favored; they do not tell you by how much, and
 * that is the number that should drive decisions. A 4-point favorite wins about
 * 58% of the time, not "always" -- and knowing the difference is what separates
 * chasing a ceiling from protecting a lead.
 *
 * Two modeling choices matter here:
 *
 * 1. **Lognormal outcomes.** Fantasy scoring is floored at zero and right
 *    skewed: a receiver's downside is 2 points and his upside is 30. A normal
 *    distribution would put mass below zero and understate the tail that
 *    actually decides close matchups.
 *
 * 2. **Correlated players.** Outcomes on the same NFL team are not independent.
 *    A quarterback throwing for 350 yards means his receivers ate; a shootout
 *    means your defense did not. Simulating players independently makes every
 *    lineup look far more predictable than it is, which systematically
 *    understates the variance of stacked rosters.
 */

/** Mulberry32: seeded so the same question always gets the same answer. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, returning one standard normal per call. */
function normal(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * How strongly a player's week tracks his team's overall game environment.
 * Passing games move together; a defense moves against its own offense's
 * shootouts.
 */
function correlationFor(position: string): number {
  switch (position) {
    case "QB":
      return 0.45;
    case "WR":
    case "TE":
      return 0.35;
    case "RB":
      return 0.15;
    case "K":
      return 0.2;
    case "DST":
      return -0.2;
    default:
      return 0.2;
  }
}

export interface SimulationResult {
  iterations: number;
  /** Probability the first lineup outscores the second. */
  winProbability: number;
  meanFor: number;
  meanAgainst: number;
  /** Median margin; positive means favored. */
  medianMargin: number;
  /** 10th and 90th percentile of your own score. */
  floor: number;
  ceiling: number;
  /** Probability of scoring below the opponent's median. Blowout-loss risk. */
  blowoutRisk: number;
}

/**
 * Simulates one head-to-head matchup from two sets of starter projections.
 */
export function simulateMatchup(
  mine: Projection[],
  theirs: Projection[],
  iterations = 10_000,
  seed = 1,
): SimulationResult {
  const rand = rng(seed);
  const myScores: number[] = [];
  const theirScores: number[] = [];
  let wins = 0;

  // Precompute lognormal parameters once rather than per iteration.
  const myParams = mine.map(lognormalParams);
  const theirParams = theirs.map(lognormalParams);

  for (let i = 0; i < iterations; i++) {
    // One shared game-environment draw per NFL team, reused by both rosters --
    // this is what makes playing against your own player's teammate matter.
    const environment = new Map<string, number>();
    const envFor = (proTeam: string) => {
      let z = environment.get(proTeam);
      if (z === undefined) {
        z = normal(rand);
        environment.set(proTeam, z);
      }
      return z;
    };

    const mineTotal = drawTotal(myParams, envFor, rand);
    const theirsTotal = drawTotal(theirParams, envFor, rand);

    myScores.push(mineTotal);
    theirScores.push(theirsTotal);
    if (mineTotal > theirsTotal) wins++;
  }

  myScores.sort((a, b) => a - b);
  theirScores.sort((a, b) => a - b);
  const theirMedian = percentile(theirScores, 0.5);

  return {
    iterations,
    winProbability: round3(wins / iterations),
    meanFor: round1(mean(myScores)),
    meanAgainst: round1(mean(theirScores)),
    medianMargin: round1(percentile(myScores, 0.5) - theirMedian),
    floor: round1(percentile(myScores, 0.1)),
    ceiling: round1(percentile(myScores, 0.9)),
    blowoutRisk: round3(myScores.filter((s) => s < theirMedian - 20).length / iterations),
  };
}

interface LognormalParams {
  proTeam: string;
  position: string;
  /** Zero-mean players (bye, ruled out) short-circuit to a constant zero. */
  isZero: boolean;
  muLn: number;
  sigmaLn: number;
}

function lognormalParams(p: Projection): LognormalParams {
  const mean = p.points;
  const sd = Math.max(0.5, p.volatility);
  if (mean <= 0.05) {
    return { proTeam: p.player.proTeam, position: p.player.position, isZero: true, muLn: 0, sigmaLn: 0 };
  }
  const sigmaLn = Math.sqrt(Math.log(1 + (sd * sd) / (mean * mean)));
  return {
    proTeam: p.player.proTeam,
    position: p.player.position,
    isZero: false,
    muLn: Math.log(mean) - (sigmaLn * sigmaLn) / 2,
    sigmaLn,
  };
}

function drawTotal(
  params: LognormalParams[],
  envFor: (proTeam: string) => number,
  rand: () => number,
): number {
  let total = 0;
  for (const p of params) {
    if (p.isZero) continue;
    const rho = correlationFor(p.position);
    // Gaussian copula: blend the shared team factor with an idiosyncratic draw,
    // keeping unit variance so the marginal distribution is unchanged.
    const z = rho * envFor(p.proTeam) + Math.sqrt(1 - rho * rho) * normal(rand);
    total += Math.exp(p.muLn + p.sigmaLn * z);
  }
  return total;
}

export interface TeamStrength {
  teamId: number;
  name: string;
  /** Expected weekly points from an optimally set lineup. */
  mean: number;
  /** Weekly standard deviation. */
  sd: number;
}

/**
 * Expected weekly scoring for every team, from each one's *optimal* lineup.
 *
 * Deliberately optimal rather than as-set: a rival who leaves points on their
 * bench this week will not next week, and planning around their mistakes is not
 * a strategy.
 */
export function teamStrengths(
  teams: Team[],
  settings: LeagueSettings,
  week: number,
): TeamStrength[] {
  return teams.map((team) => {
    const lineup = optimizeLineup(team, settings, { week, ignoreBye: true });
    const starters = lineup.optimal
      .map((a) => a.projection)
      .filter((p): p is Projection => p !== null);
    const mean = starters.reduce((s, p) => s + p.points, 0);
    // Independent-ish aggregation with a correlation uplift; summing variances
    // alone would understate how much a whole lineup can move together.
    const variance = starters.reduce((s, p) => s + p.volatility ** 2, 0);
    return {
      teamId: team.id,
      name: team.name,
      mean: round1(mean),
      sd: round1(Math.sqrt(variance) * 1.15),
    };
  });
}

export interface PlayoffOdds {
  teamId: number;
  name: string;
  /** Probability of making the playoff field. */
  playoffProbability: number;
  /** Expected final regular-season wins. */
  expectedWins: number;
  /** Probability of finishing first in the regular season. */
  firstSeedProbability: number;
}

/**
 * Simulates the rest of the regular season to produce playoff odds.
 *
 * Uses the real remaining schedule where it is available, which matters:
 * strength of schedule is the difference between a 7-5 team that is safe and
 * one that is not.
 */
export function simulatePlayoffOdds(
  teams: Team[],
  strengths: TeamStrength[],
  remainingSchedule: Array<{ week: number; homeId: number; awayId: number }>,
  playoffTeamCount: number,
  iterations = 3_000,
  seed = 7,
): PlayoffOdds[] | null {
  // With no games left to simulate, every run produces the same standings and
  // the "probabilities" collapse to 100% and 0%. That is not a forecast, it is
  // the current table wearing a percent sign, and presenting it as odds is
  // worse than presenting nothing. The caller is expected to explain the gap.
  if (remainingSchedule.length === 0) return null;

  const rand = rng(seed);
  const strengthById = new Map(strengths.map((s) => [s.teamId, s]));
  const madePlayoffs = new Map<number, number>();
  const firstSeed = new Map<number, number>();
  const totalWins = new Map<number, number>();

  for (const team of teams) {
    madePlayoffs.set(team.id, 0);
    firstSeed.set(team.id, 0);
    totalWins.set(team.id, 0);
  }

  for (let i = 0; i < iterations; i++) {
    const wins = new Map<number, number>();
    const points = new Map<number, number>();
    for (const team of teams) {
      wins.set(team.id, team.wins);
      points.set(team.id, team.pointsFor);
    }

    for (const game of remainingSchedule) {
      const home = strengthById.get(game.homeId);
      const away = strengthById.get(game.awayId);
      if (!home || !away) continue;
      const homeScore = Math.max(0, home.mean + home.sd * normal(rand));
      const awayScore = Math.max(0, away.mean + away.sd * normal(rand));
      points.set(game.homeId, (points.get(game.homeId) ?? 0) + homeScore);
      points.set(game.awayId, (points.get(game.awayId) ?? 0) + awayScore);
      const winner = homeScore >= awayScore ? game.homeId : game.awayId;
      wins.set(winner, (wins.get(winner) ?? 0) + 1);
    }

    // Standard tiebreak: wins, then total points for.
    const standings = [...teams]
      .map((t) => ({ id: t.id, w: wins.get(t.id) ?? 0, pf: points.get(t.id) ?? 0 }))
      .sort((a, b) => b.w - a.w || b.pf - a.pf);

    standings.slice(0, playoffTeamCount).forEach((s) => {
      madePlayoffs.set(s.id, (madePlayoffs.get(s.id) ?? 0) + 1);
    });
    if (standings[0]) firstSeed.set(standings[0].id, (firstSeed.get(standings[0].id) ?? 0) + 1);
    for (const s of standings) totalWins.set(s.id, (totalWins.get(s.id) ?? 0) + s.w);
  }

  return teams
    .map((team) => ({
      teamId: team.id,
      name: team.name,
      playoffProbability: round3((madePlayoffs.get(team.id) ?? 0) / iterations),
      expectedWins: round1((totalWins.get(team.id) ?? 0) / iterations),
      firstSeedProbability: round3((firstSeed.get(team.id) ?? 0) / iterations),
    }))
    .sort((a, b) => b.playoffProbability - a.playoffProbability);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}

/** Expects a pre-sorted ascending array. */
function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[index];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
