/**
 * The decisions each draft slot actually faces, turn by turn.
 *
 * The seat sweep answers what a seat is worth; this answers what it is like
 * to sit in. At every one of a seat's turns, across many simulated drafts
 * against this league's fitted managers, three things get recorded: who the
 * board chose, who the runner-up was, and what positions the top band held.
 * Repetition across simulations is what turns that into preparation -- the
 * same head-to-head recurring at the same turn is a decision worth having
 * made before the clock starts.
 *
 *   npm run decisions                 # every seat
 *   npm run decisions -- --seat 1 --sims 120
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
const { fetchAdpMarket } = await import("../src/lib/sources/adp");

type Player = Awaited<ReturnType<typeof fetchDraftPool>>[number];
type DraftStatus = Awaited<ReturnType<typeof fetchDraftStatus>>;

const args = process.argv.slice(2);
const sims = Number(readFlag("--sims") ?? 60);
const onlySeat = readFlag("--seat") ? Number(readFlag("--seat")) : null;
/** Turns per seat worth reporting; late rounds are all interchangeable. */
const TURNS = Number(readFlag("--turns") ?? 6);

interface TurnRecord {
  pick: number;
  taken: Map<string, number>;
  pairs: Map<string, number>;
  bandShapes: Map<string, number>;
}

async function main() {
  const creds = credentialsFromEnv();
  const [pool, league, live, history] = await Promise.all([
    fetchDraftPool(creds),
    fetchLeague(creds),
    fetchDraftStatus(creds),
    getHistoricalDrafts(4),
  ]);
  const market = await fetchAdpMarket(league.settings).catch(() => undefined);
  const settings = league.settings;
  const size = settings.size;
  const rounds = live.settings.rounds;
  const myTeamId = league.myTeamId;
  if (myTeamId === undefined) {
    console.error("✗ Could not resolve your team.");
    process.exitCode = 1;
    return;
  }

  const teamNames = new Map(history.data.teamNames);
  for (const team of league.teams) teamNames.set(team.id, team.name);
  const model = buildRivalModel(
    analyzeDraftTendencies(
      history.data.drafts,
      history.data.playerInfo,
      teamNames,
      history.data.marketOrder,
    ),
  );

  const otherTeams = league.teams.map((t) => t.id).filter((id) => id !== myTeamId);
  const seats = onlySeat ? [onlySeat] : Array.from({ length: size }, (_, i) => i + 1);

  console.log(
    `What each seat's turns look like · ${sims} drafts per seat · rivals are this\n` +
      `league's fitted managers · first ${TURNS} turns reported\n`,
  );

  for (const seat of seats) {
    const turns = new Map<number, TurnRecord>();

    for (let s = 0; s < sims; s++) {
      const rand = lcg(seat * 7919 + s + 1);
      const rest = [...otherTeams];
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      rest.splice(seat - 1, 0, myTeamId);
      const pickOrder = rest;

      const made: DraftStatus["picks"] = [];
      const taken = new Set<number>();
      const rosters = new Map<number, Player[]>();
      let myTurns = 0;

      for (let overall = 1; overall <= size * rounds && myTurns < TURNS + 1; overall++) {
        const onClock = teamAtPick(overall, pickOrder);
        if (onClock === undefined) break;
        let chosen: Player | undefined;

        if (onClock === myTeamId) {
          myTurns++;
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
              market,
            },
            8,
          );
          const top = board.recommendations[0];
          const second = board.recommendations[1];
          chosen = top?.player;
          if (top && myTurns <= TURNS) {
            const record =
              turns.get(myTurns) ??
              ({ pick: overall, taken: new Map(), pairs: new Map(), bandShapes: new Map() } as TurnRecord);
            record.pick = overall;
            bump(record.taken, `${top.player.name} (${top.player.position})`);
            if (second) {
              bump(
                record.pairs,
                `${top.player.name} over ${second.player.name} (${top.player.position} v ${second.player.position})`,
              );
            }
            const band = board.tiers[0]?.players ?? [];
            const shape = [...new Set(band.map((b) => b.player.position))].sort().join("+");
            if (shape) bump(record.bandShapes, shape);
            turns.set(myTurns, record);
          }
        } else {
          chosen = model.pick({
            available: pool.filter((p) => !taken.has(p.id)),
            teamId: onClock,
            round: Math.ceil(overall / size),
            roster: rosters.get(onClock) ?? [],
            settings,
            rand,
          });
        }

        if (!chosen) break;
        taken.add(chosen.id);
        if (onClock !== myTeamId) rosters.set(onClock, [...(rosters.get(onClock) ?? []), chosen]);
        else rosters.set(myTeamId, [...(rosters.get(myTeamId) ?? []), chosen]);
        made.push({
          overallPick: overall,
          round: Math.ceil(overall / size),
          roundPick: ((overall - 1) % size) + 1,
          teamId: onClock,
          playerId: chosen.id,
          keeper: false,
          bidAmount: undefined,
        });
      }
    }

    console.log(`SEAT ${seat}`);
    for (const [turn, record] of [...turns.entries()].sort((a, b) => a[0] - b[0])) {
      const takeList = top(record.taken, 3)
        .map(([name, n]) => `${name} ${pct(n)}`)
        .join(", ");
      const pair = top(record.pairs, 1)[0];
      const shape = top(record.bandShapes, 1)[0];
      console.log(`  Turn ${turn} (pick ~${record.pick})`);
      console.log(`    board takes: ${takeList}`);
      if (pair) console.log(`    the recurring decision: ${pair[0]} ${pct(pair[1])}`);
      if (shape) console.log(`    top band is usually: ${shape[0]} ${pct(shape[1])}`);
    }
    console.log("");
  }

  function pct(n: number): string {
    return `${Math.round((n / sims) * 100)}%`;
  }
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function top(map: Map<string, number>, n: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
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
    // Absent env file is fine.
  }
}

await main();
