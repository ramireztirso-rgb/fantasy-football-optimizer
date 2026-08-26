import type {
  DraftPick,
  DraftStatus,
  LeagueSettings,
  Player,
  Position,
  Team,
} from "@/lib/domain/types";
import { ReasonBuilder, type Reason } from "./explain";
import { rosterNeed } from "./replacement";

/**
 * Live draft intelligence.
 *
 * The ADP-only survival model in `draft.ts` answers "would the market take this
 * player by pick N". That is the right prior, but it is blind to the only thing
 * that actually decides your draft: what the specific eleven managers picking
 * before your next turn still need. A team that has already taken three running
 * backs is not taking a fourth, however good he is.
 *
 * This module reconstructs every roster from the pick feed, models each
 * intervening team's next pick, and converts that into a survival probability
 * conditioned on real league state rather than national averages.
 */

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

export interface DraftSeat {
  teamId: number;
  /** 1-indexed position in round one. */
  slot: number;
}

export interface TeamDraftState {
  teamId: number;
  name: string;
  picks: Array<{ pick: DraftPick; player: Player | undefined }>;
  /** Count of players taken at each position. */
  counts: Record<Position, number>;
  /** Remaining starter need at each position, 0 when filled. */
  need: Record<Position, number>;
}

export interface PositionalRun {
  position: Position;
  /** How many were taken in the observed window. */
  taken: number;
  /** How many the window would produce at the draft's baseline rate. */
  expected: number;
  /** taken / expected. Above 2 is a genuine run. */
  intensity: number;
}

export interface LiveDraftContext {
  /** True once ESPN has published a pick order and at least the settings. */
  connected: boolean;
  type: DraftStatus["settings"]["type"];
  inProgress: boolean;
  completed: boolean;
  mySeat: DraftSeat | null;
  /** Overall pick currently on the clock. */
  currentPick: number;
  /** My next pick, or null once my draft is done. */
  myNextPick: number | null;
  /** The one after that, which is what makes a "wait a round" call safe. */
  myFollowingPick: number | null;
  picksUntilMyTurn: number;
  /** Team ids picking between now and my next turn, in order. */
  interveningTeams: number[];
  teams: TeamDraftState[];
  runs: PositionalRun[];
  /** Player ids already taken. */
  draftedIds: Set<number>;
  myRoster: Player[];
  recentPicks: Array<{ pick: DraftPick; player: Player | undefined; teamName: string }>;
}

/** Overall pick numbers belonging to one seat in a snake draft. */
export function snakePicksForSlot(slot: number, size: number, rounds: number): number[] {
  const picks: number[] = [];
  for (let round = 1; round <= rounds; round++) {
    const withinRound = round % 2 === 1 ? slot : size - slot + 1;
    picks.push((round - 1) * size + withinRound);
  }
  return picks;
}

/** Which team owns a given overall pick, by seat order. */
export function teamAtPick(overallPick: number, pickOrder: number[]): number | undefined {
  const size = pickOrder.length;
  if (!size || overallPick < 1) return undefined;
  const round = Math.floor((overallPick - 1) / size) + 1;
  const indexInRound = (overallPick - 1) % size;
  const seatIndex = round % 2 === 1 ? indexInRound : size - 1 - indexInRound;
  return pickOrder[seatIndex];
}

export function buildLiveDraftContext(
  status: DraftStatus,
  settings: LeagueSettings,
  teams: Team[],
  pool: Player[],
  myTeamId: number | undefined,
): LiveDraftContext {
  const byId = new Map(pool.map((p) => [p.id, p]));
  const pickOrder = status.settings.pickOrder;
  const size = settings.size || pickOrder.length || teams.length;
  const rounds = status.settings.rounds;

  const draftedIds = new Set(status.picks.map((p) => p.playerId));
  const currentPick = status.picks.length + 1;

  const seatIndex = myTeamId === undefined ? -1 : pickOrder.indexOf(myTeamId);
  const mySeat: DraftSeat | null =
    seatIndex >= 0 && myTeamId !== undefined ? { teamId: myTeamId, slot: seatIndex + 1 } : null;

  // --- My remaining picks ---
  let myNextPick: number | null = null;
  let myFollowingPick: number | null = null;
  if (mySeat && status.settings.type === "SNAKE") {
    const mine = snakePicksForSlot(mySeat.slot, size, rounds).filter((p) => p >= currentPick);
    myNextPick = mine[0] ?? null;
    myFollowingPick = mine[1] ?? null;
  }

  const interveningTeams: number[] = [];
  if (myNextPick !== null) {
    for (let p = currentPick; p < myNextPick; p++) {
      const t = teamAtPick(p, pickOrder);
      if (t !== undefined) interveningTeams.push(t);
    }
  }

  // --- Per-team roster reconstruction ---
  const teamStates = new Map<number, TeamDraftState>();
  for (const team of teams) {
    teamStates.set(team.id, {
      teamId: team.id,
      name: team.name,
      picks: [],
      counts: emptyCounts(),
      need: rosterNeed([], settings),
    });
  }
  for (const pick of status.picks) {
    const state = teamStates.get(pick.teamId);
    if (!state) continue;
    const player = byId.get(pick.playerId);
    state.picks.push({ pick, player });
    if (player) state.counts[player.position] += 1;
  }
  for (const state of teamStates.values()) {
    const roster = state.picks.map((p) => p.player).filter((p): p is Player => Boolean(p));
    state.need = rosterNeed(roster, settings);
  }

  const myRoster =
    myTeamId === undefined
      ? []
      : (teamStates.get(myTeamId)?.picks ?? [])
          .map((p) => p.player)
          .filter((p): p is Player => Boolean(p));

  const teamNames = new Map(teams.map((t) => [t.id, t.name]));
  const recentPicks = status.picks
    .slice(-12)
    .reverse()
    .map((pick) => ({
      pick,
      player: byId.get(pick.playerId),
      teamName: teamNames.get(pick.teamId) ?? `Team ${pick.teamId}`,
    }));

  return {
    connected: pickOrder.length > 0 || status.picks.length > 0,
    type: status.settings.type,
    inProgress: status.inProgress,
    completed: status.completed,
    mySeat,
    currentPick,
    myNextPick,
    myFollowingPick,
    picksUntilMyTurn: myNextPick === null ? 0 : Math.max(0, myNextPick - currentPick),
    interveningTeams,
    teams: [...teamStates.values()],
    runs: detectRuns(status.picks, byId, settings),
    draftedIds,
    myRoster,
    recentPicks,
  };
}

/**
 * Detects positional runs in the recent pick window.
 *
 * A run is what turns a comfortable "I can wait a round" into a mistake, so it
 * is measured against the draft's own baseline rate rather than a fixed
 * threshold: three quarterbacks in eight picks is a run in a one-QB league and
 * unremarkable in a superflex.
 */
export function detectRuns(
  picks: DraftPick[],
  byId: Map<number, Player>,
  settings: LeagueSettings,
  window = 8,
): PositionalRun[] {
  if (picks.length < window) return [];
  const recent = picks.slice(-window);

  // Baseline: the share of all roster spots this league devotes to a position.
  const totalStarters = settings.lineupSlots.reduce((s, x) => s + x.count, 0) || 1;
  const share: Record<Position, number> = emptyRates();
  for (const { slot, count } of settings.lineupSlots) {
    const positions = slotPositions(slot);
    for (const pos of positions) share[pos] += count / positions.length / totalStarters;
  }

  const runs: PositionalRun[] = [];
  for (const pos of POSITIONS) {
    const taken = recent.filter((p) => byId.get(p.playerId)?.position === pos).length;
    const expected = Math.max(0.35, share[pos] * window);
    const intensity = taken / expected;
    if (taken >= 3 && intensity >= 1.8) {
      runs.push({ position: pos, taken, expected: round2(expected), intensity: round2(intensity) });
    }
  }
  return runs.sort((a, b) => b.intensity - a.intensity);
}

/**
 * Probability a player survives every pick between now and my next turn,
 * given what those specific teams still need.
 *
 * Each intervening team is modeled as picking from a softmax over its own board,
 * where board value is value-over-replacement scaled by how badly that team
 * needs the position. Independence across picks is an approximation -- it
 * ignores that one team taking a running back makes the next team likelier to
 * as well -- so the result is deliberately floored and capped rather than
 * treated as a calibrated probability.
 */
export function survivalGivenNeeds(
  player: Player,
  valueOf: (p: Player) => number,
  available: Player[],
  interveningTeams: number[],
  teamStates: Map<number, TeamDraftState>,
  considerTop = 25,
): number {
  if (!interveningTeams.length) return 1;

  // Only the top of the board realistically competes for the next few picks.
  const board = [...available].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, considerTop);
  if (!board.some((p) => p.id === player.id)) return 0.97;

  let survival = 1;
  for (const teamId of interveningTeams) {
    const state = teamStates.get(teamId);
    const weights = board.map((p) => teamBoardWeight(p, valueOf(p), state));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    const index = board.findIndex((p) => p.id === player.id);
    const pTaken = weights[index] / total;
    survival *= 1 - pTaken;
  }
  return clamp(survival, 0.01, 0.99);
}

/**
 * How attractive one player is to one team.
 *
 * Sharpened by an exponent so the model behaves like a drafter picking near the
 * top of their board rather than sampling uniformly from it, and multiplied by
 * a need factor so a team with its starters filled stops competing for that
 * position.
 */
function teamBoardWeight(player: Player, value: number, state: TeamDraftState | undefined): number {
  if (value <= 0) return 0;
  const base = value ** 2.2;
  if (!state) return base;

  const need = state.need[player.position] ?? 0;
  // A filled position is not dead -- managers take value and depth -- but it is
  // heavily discounted.
  const needMultiplier = need > 0 ? 1 + Math.min(need, 3) * 0.5 : 0.35;

  // Nobody drafts a kicker or defense until the very end.
  const roundsTaken = state.picks.length;
  const lateOnly = player.position === "K" || player.position === "DST";
  const positionTiming = lateOnly && roundsTaken < 12 ? 0.02 : 1;

  return base * needMultiplier * positionTiming;
}

/**
 * Explains what changed since the last time the board was looked at, and what
 * the manager should do differently as a result.
 */
export function courseCorrection(
  ctx: LiveDraftContext,
  previousTargets: number[],
  currentTop: Array<{ player: Player; score: number }>,
  byId: Map<number, Player>,
): Reason[] {
  const notes: Reason[] = [];

  // --- Targets that got sniped ---
  const lost = previousTargets.filter((id) => ctx.draftedIds.has(id));
  if (lost.length) {
    const names = lost
      .map((id) => byId.get(id)?.name)
      .filter(Boolean)
      .slice(0, 4);
    notes.push({
      code: "targets_gone",
      label: "Targets gone",
      detail: `${names.join(", ")} came off the board since your last turn. The board below is already re-ranked without them.`,
      impact: 0,
      direction: "negative",
    });
  }

  // --- Runs ---
  for (const run of ctx.runs.slice(0, 2)) {
    notes.push({
      code: `run_${run.position}`,
      label: `${run.position} run`,
      detail: `${run.taken} ${run.position}s in the last 8 picks, about ${run.intensity.toFixed(1)}x the normal rate for this league. Either get in front of it now or deliberately fade it and take the value falling to you at other positions.`,
      impact: 0,
      direction: "negative",
    });
  }

  // --- What the teams ahead of me actually need ---
  if (ctx.interveningTeams.length) {
    const demand = emptyCounts();
    for (const teamId of ctx.interveningTeams) {
      const state = ctx.teams.find((t) => t.teamId === teamId);
      if (!state) continue;
      for (const pos of POSITIONS) if ((state.need[pos] ?? 0) > 0) demand[pos] += 1;
    }
    const pressured = POSITIONS.filter((p) => p !== "K" && p !== "DST")
      .map((pos) => ({ pos, teams: demand[pos] }))
      .filter((d) => d.teams >= Math.max(2, ctx.interveningTeams.length * 0.5))
      .sort((a, b) => b.teams - a.teams)
      .slice(0, 2);

    if (pressured.length) {
      notes.push({
        code: "position_pressure",
        label: "Pressure before your turn",
        detail: `Of the ${ctx.interveningTeams.length} teams picking before you, ${pressured
          .map((p) => `${p.teams} still need ${p.pos}`)
          .join(" and ")}. Positions they have already filled will keep falling; the ones they need will not.`,
        impact: 0,
        direction: "negative",
      });
    }

    const safe = POSITIONS.filter((p) => p !== "K" && p !== "DST").filter(
      (pos) => demand[pos] <= 1,
    );
    if (safe.length && ctx.picksUntilMyTurn > 4) {
      notes.push({
        code: "safe_to_wait",
        label: "Safe to wait",
        detail: `Almost nobody picking before your turn needs ${safe.join(" or ")}. Value there should still be on the board at pick ${ctx.myNextPick}, so spend this pick somewhere contested.`,
        impact: 0,
        direction: "positive",
      });
    }
  }

  // --- Where my own roster is thin, relative to the round ---
  if (ctx.myRoster.length >= 3) {
    const myState = ctx.teams.find((t) => t.teamId === ctx.mySeat?.teamId);
    if (myState) {
      const thin = POSITIONS.filter((p) => p !== "K" && p !== "DST").filter(
        (pos) => (myState.need[pos] ?? 0) >= 1,
      );
      if (thin.length) {
        notes.push({
          code: "my_holes",
          label: "Your remaining holes",
          detail: `You still have starting spots open at ${thin.join(", ")} with ${Math.max(0, ctx.teams.length ? estimateRoundsLeft(ctx) : 0)} rounds to go.`,
          impact: 0,
          direction: "neutral",
        });
      }
    }
  }

  if (currentTop.length) {
    const top = currentTop[0];
    notes.push({
      code: "current_call",
      label: "The pick",
      detail: `On the current board the pick is ${top.player.name} (${top.player.position}, ${top.player.proTeam}).`,
      impact: 0,
      direction: "positive",
    });
  }

  return notes;
}

function estimateRoundsLeft(ctx: LiveDraftContext): number {
  const size = ctx.teams.length || 12;
  const totalPicks = size * 16;
  return Math.max(0, Math.round((totalPicks - ctx.currentPick) / size));
}

function slotPositions(slot: string): Position[] {
  switch (slot) {
    case "FLEX":
      return ["RB", "WR", "TE"];
    case "RB/WR":
      return ["RB", "WR"];
    case "WR/TE":
      return ["WR", "TE"];
    case "OP":
      return ["QB", "RB", "WR", "TE"];
    case "TQB":
      return ["QB"];
    default:
      return POSITIONS.includes(slot as Position) ? [slot as Position] : [];
  }
}

function emptyCounts(): Record<Position, number> {
  return { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
}

function emptyRates(): Record<Position, number> {
  return { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { ReasonBuilder };
