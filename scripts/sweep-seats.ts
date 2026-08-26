/**
 * What every draft slot is worth, and how to play the one you draw.
 *
 * This league randomizes its order at draft start (`orderType: DRAFT_START`),
 * so the seat is not knowable in advance -- which makes "prepare for your seat"
 * the wrong preparation. The useful question is what each of the twelve seats
 * tends to hand you, and where the board's advice changes between them.
 *
 * Every seat is drafted many times against a model of *this* league's eleven
 * managers, fitted to four years of their real picks, rather than against
 * national ADP. The output is per-seat: what the roster is worth, what shape it
 * takes, and who is realistically there at the first turn.
 *
 *   npm run sweep
 *   npm run sweep -- --sims 24 --seat 7 --verbose
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague, fetchDraftStatus } = await import("../src/lib/espn/league");
const { getHistoricalDrafts } = await import("../src/lib/data");
const { analyzeDraftTendencies } = await import("../src/lib/engine/tendencies");
const { buildRivalModel } = await import("../src/lib/engine/rivalModel");
const { buildLiveDraftContext, teamAtPick } = await import("../src/lib/engine/draftLive");
const { buildDraftBoard } = await import("../src/lib/engine/draft");
const { expandSlots } = await import("../src/lib/engine/lineup");
const { maxValueAssignment } = await import("../src/lib/engine/assignment");
const { SLOT_ELIGIBILITY } = await import("../src/lib/espn/constants");

type Player = Awaited<ReturnType<typeof fetchDraftPool>>[number];
type DraftStatus = Awaited<ReturnType<typeof fetchDraftStatus>>;
type League = Awaited<ReturnType<typeof fetchLeague>>;
type LeagueSettings = League["settings"];

const args = process.argv.slice(2);
const sims = Number(readFlag("--sims") ?? 12);
const onlySeat = readFlag("--seat") ? Number(readFlag("--seat")) : null;
const verbose = args.includes("--verbose");

interface SeatResult {
  seat: number;
  starterPoints: number[];
  shapes: Array<Record<string, number>>;
  firstPicks: string[];
  secondPicks: string[];
}

async function main() {
  const creds = credentialsFromEnv();
  const [pool, league, live, history] = await Promise.all([
    fetchDraftPool(creds),
    fetchLeague(creds),
    fetchDraftStatus(creds),
    getHistoricalDrafts(4),
  ]);

  const settings = league.settings;
  const size = settings.size;
  const rounds = live.settings.rounds;
  const myTeamId = league.myTeamId;
  if (myTeamId === undefined) {
    console.error("✗ Could not resolve your team id -- check SWID in .env.local.");
    process.exitCode = 1;
    return;
  }

  const teamNames = new Map(history.data.teamNames);
  for (const team of league.teams) teamNames.set(team.id, team.name);
  const tendencies = analyzeDraftTendencies(
    history.data.drafts,
    history.data.playerInfo,
    teamNames,
    history.data.marketOrder,
  );
  const model = buildRivalModel(tendencies);

  console.log(`League ${creds.leagueId} · ${size} teams · ${rounds} rounds`);
  console.log(
    `Rival model: ${tendencies.seasonsAnalyzed.join(", ")} · ${model.sample} picks` +
      (model.isNaive ? "  ⚠ too thin to bend ADP, falling back to market order" : ""),
  );
  console.log(`Pool: ${pool.length} players · ${sims} simulations per seat\n`);

  const otherTeams = league.teams.map((t) => t.id).filter((id) => id !== myTeamId);
  const seats = onlySeat ? [onlySeat] : Array.from({ length: size }, (_, i) => i + 1);
  const results: SeatResult[] = [];

  for (const seat of seats) {
    const result: SeatResult = {
      seat,
      starterPoints: [],
      shapes: [],
      firstPicks: [],
      secondPicks: [],
    };

    for (let s = 0; s < sims; s++) {
      // Vary the rival seating as well as the dice: who sits immediately ahead
      // of you is part of what a seat is worth, and fixing it would measure one
      // arrangement rather than the seat.
      const rand = lcg(seat * 1000 + s + 1);
      const pickOrder = seatOrder(myTeamId, otherTeams, seat, rand);
      const roster = runDraft({ pool, settings, live, league, model, pickOrder, myTeamId, rounds, size, rand });

      result.starterPoints.push(startingLineupValue(roster, settings));
      result.shapes.push(shapeOf(roster));
      if (roster[0]) result.firstPicks.push(roster[0].name);
      if (roster[1]) result.secondPicks.push(roster[1].name);
    }

    results.push(result);
    report(result, verbose);
  }

  if (results.length > 1) summarize(results);
}

interface DraftArgs {
  pool: Player[];
  settings: LeagueSettings;
  live: DraftStatus;
  league: League;
  model: ReturnType<typeof buildRivalModel>;
  pickOrder: number[];
  myTeamId: number;
  rounds: number;
  size: number;
  rand: () => number;
}

function runDraft({
  pool,
  settings,
  live,
  league,
  model,
  pickOrder,
  myTeamId,
  rounds,
  size,
  rand,
}: DraftArgs): Player[] {
  const totalPicks = size * rounds;
  const made: DraftStatus["picks"] = [];
  const taken = new Set<number>();
  const rostersByTeam = new Map<number, Player[]>();
  const mine: Player[] = [];

  for (let overall = 1; overall <= totalPicks; overall++) {
    const round = Math.ceil(overall / size);
    const onTheClock = teamAtPick(overall, pickOrder);
    if (onTheClock === undefined) break;

    const available = pool.filter((p) => !taken.has(p.id));
    let chosen: Player | undefined;

    if (onTheClock === myTeamId) {
      // The board is only exercised at my own picks, which is the whole point:
      // this measures the advice, not the simulator.
      const ctx = buildLiveDraftContext(
        { ...live, settings: { ...live.settings, pickOrder }, picks: [...made], inProgress: true, completed: false },
        settings,
        league.teams,
        pool,
        myTeamId,
      );
      const board = buildDraftBoard(
        pool,
        settings,
        {
          pickNumber: overall,
          nextPickNumber: ctx.myFollowingPick ?? overall + size,
          drafted: ctx.draftedIds,
          myRoster: ctx.myRoster,
          live: ctx,
        },
        10,
      );
      chosen = board.recommendations[0]?.player;
    } else {
      chosen = model.pick({
        available,
        teamId: onTheClock,
        round,
        roster: rostersByTeam.get(onTheClock) ?? [],
        settings,
        rand,
      });
    }

    if (!chosen) break;
    taken.add(chosen.id);
    if (onTheClock === myTeamId) mine.push(chosen);
    else {
      const r = rostersByTeam.get(onTheClock) ?? [];
      r.push(chosen);
      rostersByTeam.set(onTheClock, r);
    }

    made.push({
      overallPick: overall,
      round,
      roundPick: ((overall - 1) % size) + 1,
      teamId: onTheClock,
      playerId: chosen.id,
      keeper: false,
      bidAmount: undefined,
    });
  }

  return mine;
}

/**
 * Season points of the best legal starting lineup this roster can field.
 *
 * Bench players are deliberately worth nothing here. A roster's value on draft
 * night is what it can put on the field; depth matters through injuries and
 * byes, which is a different question this is not trying to answer.
 */
function startingLineupValue(roster: Player[], settings: LeagueSettings): number {
  const slots = expandSlots(settings);
  if (!slots.length || !roster.length) return 0;

  const columns = Math.max(slots.length, roster.length);
  const value: number[][] = slots.map((slot) =>
    Array.from({ length: columns }, (_, j) => {
      const p = roster[j];
      if (!p) return 0;
      const eligible = p.eligibleSlots.length
        ? p.eligibleSlots.includes(slot)
        : (SLOT_ELIGIBILITY[slot] ?? []).includes(p.position);
      return eligible ? p.seasonProjectedPoints : 0;
    }),
  );

  const assignment = maxValueAssignment(value);
  let total = 0;
  for (let i = 0; i < slots.length; i++) {
    const col = assignment[i];
    if (col >= 0) total += value[i][col];
  }
  return Math.round(total);
}

function shapeOf(roster: Player[]): Record<string, number> {
  const shape: Record<string, number> = {};
  for (const p of roster) shape[p.position] = (shape[p.position] ?? 0) + 1;
  return shape;
}

/** Pick order with my team at `seat`, everyone else shuffled around me. */
function seatOrder(myTeamId: number, others: number[], seat: number, rand: () => number): number[] {
  const rest = [...others];
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  rest.splice(seat - 1, 0, myTeamId);
  return rest;
}

function report(r: SeatResult, verbose: boolean) {
  const shape = averageShape(r.shapes);
  console.log(
    `Seat ${String(r.seat).padStart(2)} · starters ${String(Math.round(mean(r.starterPoints))).padStart(4)} ` +
      `± ${String(Math.round(stderr(r.starterPoints))).padStart(2)} pts · ${shape}`,
  );
  if (verbose) {
    console.log(`         R1: ${topCounts(r.firstPicks, 3)}`);
    console.log(`         R2: ${topCounts(r.secondPicks, 3)}`);
  }
}

function summarize(results: SeatResult[]) {
  const ranked = [...results].sort((a, b) => mean(b.starterPoints) - mean(a.starterPoints));
  console.log(`\nSeats ranked by mean starting lineup:`);
  for (const r of ranked) {
    console.log(
      `  ${String(Math.round(mean(r.starterPoints))).padStart(4)} ± ${String(Math.round(stderr(r.starterPoints))).padStart(2)}` +
        ` · seat ${String(r.seat).padStart(2)} · ${topCounts(r.firstPicks, 2)}`,
    );
  }

  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const spread = mean(best.starterPoints) - mean(worst.starterPoints);

  // Twelve noisy estimates have a widest-minus-narrowest gap even when every
  // seat is identical, so the gap alone proves nothing. Roughly 3.3 standard
  // errors separate the extremes of twelve draws from one distribution; below
  // that the ranking above is describing the dice.
  const noise = 3.3 * Math.sqrt(
    (stderr(best.starterPoints) ** 2 + stderr(worst.starterPoints) ** 2) / 2,
  );
  console.log(
    `\nSpread seat ${best.seat} to seat ${worst.seat}: ${Math.round(spread)} points, ` +
      `against ${Math.round(noise)} expected from sampling noise alone.`,
  );
  if (spread <= noise) {
    console.log(
      `That is inside the noise: on this evidence no seat is materially better than another, ` +
        `and the seat you draw should not change your strategy. Raise --sims to tighten it.`,
    );
    return;
  }

  // Detectable and worth acting on are different questions, and enough
  // simulations will make almost any gap detectable. A season's worth of
  // points spread over the schedule is the scale a manager actually feels.
  const perWeek = spread / 17;
  console.log(
    `That gap is larger than the noise, but it is worth ${perWeek.toFixed(1)} points a week ` +
      (perWeek < 1.5
        ? `-- statistically real and practically irrelevant. Draw whatever seat you draw.`
        : `, which is enough to prepare differently depending on where you land.`),
  );
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stderr(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}

function averageShape(shapes: Array<Record<string, number>>): string {
  const sum: Record<string, number> = {};
  for (const s of shapes) for (const [k, v] of Object.entries(s)) sum[k] = (sum[k] ?? 0) + v;
  return ["QB", "RB", "WR", "TE", "K", "DST"]
    .map((pos) => `${pos} ${((sum[pos] ?? 0) / shapes.length).toFixed(1)}`)
    .join("  ");
}

function topCounts(values: string[], n: number): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, c]) => `${name} ${Math.round((c / values.length) * 100)}%`)
      .join(", ") || "-"
  );
}

/** Deterministic PRNG so a surprising seat can be re-run and inspected. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function readFlag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function loadEnvFile(file: string) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
  } catch {
    // Absent env file is fine; credentialsFromEnv will report what is missing.
  }
}

await main();
