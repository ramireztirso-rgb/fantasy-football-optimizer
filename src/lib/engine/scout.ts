import type { League, Player, Position, Team } from "@/lib/domain/types";
import { optimizeLineup, type LineupResult } from "./lineup";
import { projectPlayer, type Projection } from "./projections";
import { simulateMatchup, type SimulationResult } from "./simulate";
import type { Reason } from "./explain";

/**
 * Weekly opponent scouting.
 *
 * The point is not to describe the other roster, it is to change how you play
 * the week. Being a heavy favorite and being a heavy underdog call for opposite
 * lineup decisions -- the favorite wants the highest floor, the underdog wants
 * the widest ceiling -- and that call cannot be made from projected totals
 * alone. It needs the distribution, which is what the simulation provides.
 */

export interface PositionalEdge {
  position: Position;
  myPoints: number;
  theirPoints: number;
  edge: number;
}

export interface ScoutingReport {
  week: number;
  me: { teamId: number; name: string; record: string };
  opponent: { teamId: number; name: string; record: string } | null;
  simulation: SimulationResult | null;
  myLineup: LineupResult;
  theirLineup: LineupResult | null;
  edges: PositionalEdge[];
  /** Their most dangerous starters, by ceiling rather than projection. */
  threats: Array<{ player: Player; projection: Projection }>;
  /** Weak spots in their starting lineup you can plan around. */
  theirWeaknesses: Array<{ slot: string; player: Player; detail: string }>;
  /** How the odds should change your decisions this week. */
  strategy: Reason[];
}

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

export function buildScoutingReport(
  league: League,
  myTeamId: number,
  week: number,
  iterations = 10_000,
): ScoutingReport {
  const me = league.teams.find((t) => t.id === myTeamId);
  if (!me) throw new Error(`Team ${myTeamId} is not in this league.`);

  const matchup = league.matchups.find(
    (m) => m.week === week && (m.home.teamId === myTeamId || m.away?.teamId === myTeamId),
  );
  const opponentId =
    matchup === undefined
      ? undefined
      : matchup.home.teamId === myTeamId
        ? matchup.away?.teamId
        : matchup.home.teamId;
  const opponent = opponentId === undefined ? null : league.teams.find((t) => t.id === opponentId) ?? null;

  const myLineup = optimizeLineup(me, league.settings, { week });
  const theirLineup = opponent ? optimizeLineup(opponent, league.settings, { week }) : null;

  const myStarters = startersOf(myLineup);
  const theirStarters = theirLineup ? startersOf(theirLineup) : [];

  const simulation =
    theirStarters.length > 0 ? simulateMatchup(myStarters, theirStarters, iterations) : null;

  return {
    week,
    me: { teamId: me.id, name: me.name, record: recordOf(me) },
    opponent: opponent ? { teamId: opponent.id, name: opponent.name, record: recordOf(opponent) } : null,
    simulation,
    myLineup,
    theirLineup,
    edges: positionalEdges(myStarters, theirStarters),
    threats: [...theirStarters]
      .sort((a, b) => b.ceiling - a.ceiling)
      .slice(0, 3)
      .map((p) => ({ player: p.player, projection: p })),
    theirWeaknesses: weaknesses(theirLineup, week),
    strategy: strategyNotes(simulation, myLineup, week),
  };
}

function startersOf(lineup: LineupResult): Projection[] {
  return lineup.optimal.map((a) => a.projection).filter((p): p is Projection => p !== null);
}

function positionalEdges(mine: Projection[], theirs: Projection[]): PositionalEdge[] {
  const sum = (list: Projection[], pos: Position) =>
    list.filter((p) => p.player.position === pos).reduce((s, p) => s + p.points, 0);

  return POSITIONS.map((position) => {
    const myPoints = round1(sum(mine, position));
    const theirPoints = round1(sum(theirs, position));
    return { position, myPoints, theirPoints, edge: round1(myPoints - theirPoints) };
  })
    .filter((e) => e.myPoints > 0 || e.theirPoints > 0)
    .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}

function weaknesses(
  lineup: LineupResult | null,
  week: number,
): Array<{ slot: string; player: Player; detail: string }> {
  if (!lineup) return [];
  const out: Array<{ slot: string; player: Player; detail: string }> = [];

  for (const assignment of lineup.optimal) {
    const proj = assignment.projection;
    if (!proj) continue;
    const p = proj.player;
    if (p.byeWeek === week) {
      out.push({
        slot: assignment.slot,
        player: p,
        detail: `${p.name} is on bye, and their best legal replacement still leaves the ${assignment.slot} slot thin.`,
      });
    } else if (p.injuryStatus && ["OUT", "DOUBTFUL", "INJURY_RESERVE"].includes(p.injuryStatus.toUpperCase())) {
      out.push({
        slot: assignment.slot,
        player: p,
        detail: `${p.name} is listed ${p.injuryStatus.replace(/_/g, " ").toLowerCase()} in their ${assignment.slot} slot.`,
      });
    } else if (proj.points < 6 && assignment.slot !== "K" && assignment.slot !== "DST") {
      out.push({
        slot: assignment.slot,
        player: p,
        detail: `Their ${assignment.slot} projects only ${proj.points.toFixed(1)} points -- a hole you do not need to out-play, only avoid matching.`,
      });
    }
  }
  return out.slice(0, 4);
}

/**
 * Converts win probability into an actual instruction.
 *
 * This is the part that changes behaviour: the same bench player is the right
 * start at 25% and the wrong start at 80%.
 */
function strategyNotes(
  simulation: SimulationResult | null,
  myLineup: LineupResult,
  week: number,
): Reason[] {
  const notes: Reason[] = [];
  if (!simulation) {
    notes.push({
      code: "no_opponent",
      label: "No matchup found",
      detail: `No week ${week} opponent is scheduled, so this week is being evaluated on your lineup alone.`,
      impact: 0,
      direction: "neutral",
    });
    return notes;
  }

  const wp = simulation.winProbability;

  if (wp >= 0.7) {
    notes.push({
      code: "favored",
      label: "Heavy favorite",
      detail: `You win this matchup in ${(wp * 100).toFixed(0)}% of ${simulation.iterations.toLocaleString()} simulations. Play for floor, not ceiling: start the steady option over the boom-or-bust one, because the only way you lose is a zero from someone you had to start.`,
      impact: 0,
      direction: "positive",
    });
  } else if (wp <= 0.3) {
    notes.push({
      code: "underdog",
      label: "Underdog",
      detail: `You win only ${(wp * 100).toFixed(0)}% of the time. Variance is your friend here -- start the highest-ceiling players you have even at the cost of expected points, because a median week loses this matchup anyway.`,
      impact: 0,
      direction: "negative",
    });
  } else {
    notes.push({
      code: "coinflip",
      label: "Close matchup",
      detail: `A ${(wp * 100).toFixed(0)}% win probability with a median margin of ${simulation.medianMargin > 0 ? "+" : ""}${simulation.medianMargin.toFixed(1)}. Every point matters; this is the week to take the optimizer's advice literally.`,
      impact: 0,
      direction: "neutral",
    });
  }

  if (myLineup.pointsLeftOnBench > 1) {
    notes.push({
      code: "bench_points",
      label: "Points on your bench",
      detail: `Your lineup as set is ${myLineup.pointsLeftOnBench.toFixed(1)} points short of optimal. In a matchup this close that is the difference by itself.`,
      impact: 0,
      direction: "negative",
    });
  }

  if (simulation.blowoutRisk > 0.15) {
    notes.push({
      code: "blowout_risk",
      label: "Blowout risk",
      detail: `${(simulation.blowoutRisk * 100).toFixed(0)}% chance you lose by more than 20. Your floor (${simulation.floor.toFixed(1)}) is low enough that a single bad game sinks the week -- worth checking whether any starter is a genuine zero risk.`,
      impact: 0,
      direction: "negative",
    });
  }

  notes.push({
    code: "distribution",
    label: "Your range",
    detail: `Expect ${simulation.meanFor.toFixed(1)} points on average, with a realistic range of ${simulation.floor.toFixed(1)} to ${simulation.ceiling.toFixed(1)}. Your opponent averages ${simulation.meanAgainst.toFixed(1)}.`,
    impact: 0,
    direction: "neutral",
  });

  return notes;
}

/** Projections for an arbitrary roster, used when scouting a rival. */
export function projectRoster(team: Team, week: number): Projection[] {
  return team.roster.map((r) => projectPlayer(r.player, { week }));
}

function recordOf(team: Team): string {
  return `${team.wins}-${team.losses}${team.ties ? `-${team.ties}` : ""}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
