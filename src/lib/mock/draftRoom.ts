import type { DraftStatus, League, Player } from "@/lib/domain/types";
import { fetchDraftPool, fetchDraftStatus, fetchLeague } from "@/lib/espn/league";
import { credentialsFromEnv } from "@/lib/espn/client";
import { getHistoricalDrafts } from "@/lib/data";
import { analyzeDraftTendencies } from "@/lib/engine/tendencies";
import { buildRivalModel, type RivalModel } from "@/lib/engine/rivalModel";

/**
 * A practice draft room, served through the app's real plumbing.
 *
 * The live draft path has never watched a real draft, and the one thing that
 * cannot be rehearsed without a draft room is the loop itself: picks arriving,
 * the board re-ranking, targets vanishing, your turn coming up. This room
 * fakes exactly one thing -- ESPN's answer to "what picks have been made" --
 * and everything downstream of that answer is the production code: the same
 * routes, the same board, the same notes, the same page.
 *
 * The eleven rivals are the fitted model of this league's actual managers,
 * the same one the seat sweep drafts against. They pick on a clock; the room
 * advances lazily whenever the app polls, so there are no timers to leak and
 * a paused room costs nothing.
 *
 * Gated on MOCK_DRAFT=1 so it cannot exist on draft night by accident, and it
 * never writes anything anywhere.
 */

const PICK_SECONDS = Number(process.env.MOCK_PICK_SECONDS ?? 5);
/** With MOCK_AUTOPICK=1 the room drafts the board's top pick for you too. */
const AUTOPICK = process.env.MOCK_AUTOPICK === "1";

interface Room {
  league: League;
  pool: Player[];
  real: DraftStatus;
  rivals: RivalModel;
  pickOrder: number[];
  rounds: number;
  picks: DraftStatus["picks"];
  taken: Set<number>;
  rosters: Map<number, Player[]>;
  /** When the current pick came on the clock. */
  clockStarted: number;
  rand: () => number;
  /** Autopick decisions the user's seat made, for review. */
  autopicked: string[];
}

/** Survives dev-server module reloads; one room per process is the point. */
const globalStore = globalThis as unknown as { __mockDraftRoom?: Room | Promise<Room> };

export function mockDraftEnabled(): boolean {
  return process.env.MOCK_DRAFT === "1";
}

async function buildRoom(seat?: number): Promise<Room> {
  const creds = credentialsFromEnv();
  const [league, pool, real, history] = await Promise.all([
    fetchLeague(creds),
    fetchDraftPool(creds),
    fetchDraftStatus(creds),
    getHistoricalDrafts(4),
  ]);

  const teamNames = new Map(history.data.teamNames);
  for (const team of league.teams) teamNames.set(team.id, team.name);
  const tendencies = analyzeDraftTendencies(
    history.data.drafts,
    history.data.playerInfo,
    teamNames,
    history.data.marketOrder,
  );

  const rand = lcg(Date.now() % 100000 | 1);
  const myTeamId = league.myTeamId;

  // The real order when ESPN has one; otherwise the teams shuffled. A
  // requested seat re-deals the order with your team placed there, which is
  // how you practice the seats you did not draw.
  let pickOrder = [...real.settings.pickOrder];
  if (!pickOrder.length) pickOrder = league.teams.map((t) => t.id);
  if (seat !== undefined && myTeamId !== undefined) {
    const others = pickOrder.filter((id) => id !== myTeamId);
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [others[i], others[j]] = [others[j], others[i]];
    }
    others.splice(Math.max(0, Math.min(seat - 1, others.length)), 0, myTeamId);
    pickOrder = others;
  }

  return {
    league,
    pool,
    real,
    rivals: buildRivalModel(tendencies),
    pickOrder,
    rounds: real.settings.rounds || 15,
    picks: [],
    taken: new Set(),
    rosters: new Map(),
    clockStarted: Date.now(),
    rand,
    autopicked: [],
  };
}

async function room(): Promise<Room> {
  if (!globalStore.__mockDraftRoom) globalStore.__mockDraftRoom = buildRoom();
  return globalStore.__mockDraftRoom;
}

export async function resetMockDraft(seat?: number): Promise<void> {
  globalStore.__mockDraftRoom = buildRoom(seat);
  await globalStore.__mockDraftRoom;
}

function teamOnClock(r: Room): number | undefined {
  const overall = r.picks.length + 1;
  if (overall > r.pickOrder.length * r.rounds) return undefined;
  const round = Math.ceil(overall / r.pickOrder.length);
  const within = (overall - 1) % r.pickOrder.length;
  const index = round % 2 === 1 ? within : r.pickOrder.length - 1 - within;
  return r.pickOrder[index];
}

function record(r: Room, teamId: number, player: Player) {
  const overall = r.picks.length + 1;
  r.taken.add(player.id);
  r.rosters.set(teamId, [...(r.rosters.get(teamId) ?? []), player]);
  r.picks.push({
    overallPick: overall,
    round: Math.ceil(overall / r.pickOrder.length),
    roundPick: ((overall - 1) % r.pickOrder.length) + 1,
    teamId,
    playerId: player.id,
    keeper: false,
    bidAmount: undefined,
  });
}

/**
 * Advances every rival pick whose clock has expired.
 *
 * Called on read rather than on a timer, so the room only moves while someone
 * is watching -- which is also how it stays honest as a test of the polling
 * loop: picks arrive between polls, in batches, the way they will on the
 * night.
 */
function advance(r: Room) {
  const myTeamId = r.league.myTeamId;
  for (;;) {
    const onClock = teamOnClock(r);
    if (onClock === undefined) return;
    const isMe = onClock === myTeamId;
    if (isMe && !AUTOPICK) return;
    if (Date.now() - r.clockStarted < PICK_SECONDS * 1000) return;

    const available = r.pool.filter((p) => !r.taken.has(p.id));
    if (!available.length) return;

    if (isMe) {
      // Autopick: honest best-available by ADP is NOT the model; the board is.
      // But building the full board here would import half the engine into the
      // room, so the route layer does it -- see the pick endpoint, which the
      // autopilot in the page calls with the board's own top choice. Fallback
      // when nobody does: best ADP, marked as such.
      const byAdp = [...available].sort(
        (a, b) => a.averageDraftPosition - b.averageDraftPosition,
      )[0];
      r.autopicked.push(byAdp.name);
      record(r, onClock, byAdp);
      r.clockStarted = Math.min(Date.now(), r.clockStarted + PICK_SECONDS * 1000);
      continue;
    }

    const pick = r.rivals.pick({
      available,
      teamId: onClock,
      round: Math.ceil((r.picks.length + 1) / r.pickOrder.length),
      roster: r.rosters.get(onClock) ?? [],
      settings: r.league.settings,
      rand: r.rand,
    });
    if (!pick) return;
    record(r, onClock, pick);
    // The clock consumes its allotment rather than restarting, so time that
    // passed between polls yields the picks it should have. Restarting it --
    // the first version -- meant a fifty-second gap produced one rival pick
    // instead of twenty-two, and the room only moved as fast as it was
    // watched.
    r.clockStarted = Math.min(Date.now(), r.clockStarted + PICK_SECONDS * 1000);
  }
}

/** The one thing the room fakes: ESPN's draft status, advanced to now. */
export async function mockDraftStatus(): Promise<DraftStatus> {
  const r = await room();
  advance(r);
  const total = r.pickOrder.length * r.rounds;
  return {
    ...r.real,
    settings: { ...r.real.settings, pickOrder: r.pickOrder, rounds: r.rounds },
    picks: [...r.picks],
    inProgress: r.picks.length < total,
    completed: r.picks.length >= total,
  };
}

export interface MockPickResult {
  ok: boolean;
  error?: string;
  onClock?: boolean;
}

/** Your pick, valid only when the clock is actually yours. */
export async function makeMockPick(playerId: number): Promise<MockPickResult> {
  const r = await room();
  advance(r);
  const onClock = teamOnClock(r);
  if (onClock === undefined) return { ok: false, error: "The draft is over." };
  if (onClock !== r.league.myTeamId) {
    return { ok: false, error: "Not your pick.", onClock: false };
  }
  const player = r.pool.find((p) => p.id === playerId);
  if (!player) return { ok: false, error: "No such player." };
  if (r.taken.has(playerId)) return { ok: false, error: `${player.name} is already gone.` };
  record(r, onClock, player);
  // Your pick restarts the clock for real: the next rival's time begins now.
  r.clockStarted = Date.now();
  return { ok: true };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
