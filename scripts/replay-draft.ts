/**
 * Replays a full draft through the live code path.
 *
 * The board is easy to check at rest and hard to check in motion, which is
 * backwards: every interesting behaviour -- survival probabilities tightening
 * as your turn approaches, targets disappearing when someone else takes them,
 * runs firing -- only exists while picks are arriving. Draft night is a bad
 * time to discover that path is broken.
 *
 * So this drives real league settings, a real player pool, and the real pick
 * order through `buildLiveDraftContext` and `buildDraftBoard` pick by pick,
 * asserting the invariants that must hold at every one of them.
 *
 * The rival pick model is deliberately crude -- ADP with noise, nudged by
 * roster need. It is not trying to predict your league. It exists to make the
 * board face a plausible, adversarial sequence of states.
 *
 *   npm run replay
 *   npm run replay -- --seed 7 --verbose
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague, fetchDraftStatus } = await import("../src/lib/espn/league");
const { buildLiveDraftContext, courseCorrection, snakePicksForSlot, teamAtPick } = await import(
  "../src/lib/engine/draftLive"
);
const { buildDraftBoard } = await import("../src/lib/engine/draft");
const { fetchAdpMarket } = await import("../src/lib/sources/adp");
const { mandatoryStarters } = await import("../src/lib/engine/replacement");

type Player = Awaited<ReturnType<typeof fetchDraftPool>>[number];
type DraftStatus = Awaited<ReturnType<typeof fetchDraftStatus>>;

const args = process.argv.slice(2);
const seed = Number(readFlag("--seed") ?? 1);
const verbose = args.includes("--verbose");

const failures: string[] = [];
let checks = 0;

function check(condition: boolean, message: string) {
  checks++;
  if (!condition) failures.push(message);
}

async function main() {
  const creds = credentialsFromEnv();
  const [pool, league, live] = await Promise.all([
    fetchDraftPool(creds),
    fetchLeague(creds),
    fetchDraftStatus(creds),
  ]);
  const market = await fetchAdpMarket(league.settings).catch(() => undefined);

  const settings = league.settings;
  const size = settings.size;
  const pickOrder = live.settings.pickOrder;
  const rounds = live.settings.rounds;
  const totalPicks = size * rounds;
  const myTeamId = league.myTeamId;

  if (!pickOrder.length) {
    console.error("✗ No pick order published yet -- nothing to replay against.");
    process.exitCode = 1;
    return;
  }

  const mySlot = myTeamId === undefined ? -1 : pickOrder.indexOf(myTeamId) + 1;
  const myPicks = mySlot > 0 ? snakePicksForSlot(mySlot, size, rounds) : [];

  console.log(`League ${creds.leagueId} · ${size} teams · ${rounds} rounds · ${totalPicks} picks`);
  console.log(`Your seat: ${mySlot} (team ${myTeamId}) · picks ${myPicks.slice(0, 4).join(", ")}...`);
  console.log(`Pool: ${pool.length} players · seed ${seed}\n`);

  // Real drafts never run to the last pick with the pool untouched, so the
  // replay uses the whole grid rather than stopping at the user's last turn.
  check(
    myPicks.length === rounds,
    `Seat ${mySlot} should own exactly ${rounds} picks, got ${myPicks.length}`,
  );
  check(
    myPicks.every((p) => p >= 1 && p <= totalPicks),
    `Every pick must fall inside the draft: got ${myPicks.filter((p) => p > totalPicks).join(", ")}`,
  );

  const rand = lcg(seed);
  const byId = new Map(pool.map((p) => [p.id, p]));
  const made: DraftStatus["picks"] = [];
  const taken = new Set<number>();
  let previousTargets: number[] = [];
  let myTurns = 0;
  let sniped = 0;

  for (let overall = 1; overall <= totalPicks; overall++) {
    const status: DraftStatus = {
      ...live,
      picks: [...made],
      inProgress: true,
      completed: false,
    };
    const ctx = buildLiveDraftContext(status, settings, league.teams, pool, myTeamId);

    // --- Invariants that must hold at every single pick ---
    check(
      ctx.currentPick === overall,
      `pick ${overall}: context says the clock is on ${ctx.currentPick}`,
    );
    check(
      ctx.draftedIds.size === made.length,
      `pick ${overall}: ${made.length} picks made but ${ctx.draftedIds.size} ids marked drafted`,
    );
    if (ctx.myNextPick !== null) {
      check(
        ctx.myNextPick >= overall && ctx.myNextPick <= totalPicks,
        `pick ${overall}: myNextPick ${ctx.myNextPick} is outside the draft`,
      );
      check(
        myPicks.includes(ctx.myNextPick),
        `pick ${overall}: myNextPick ${ctx.myNextPick} is not one of my seat's picks`,
      );
    }
    if (ctx.myFollowingPick !== null) {
      check(
        ctx.myFollowingPick <= totalPicks,
        `pick ${overall}: myFollowingPick ${ctx.myFollowingPick} exceeds the ${totalPicks}-pick draft`,
      );
    }
    check(
      ctx.interveningTeams.length === Math.max(0, (ctx.myNextPick ?? overall) - overall),
      `pick ${overall}: intervening team count does not match the gap to my turn`,
    );

    const onTheClock = teamAtPick(overall, pickOrder);
    let chosen: Player | undefined;

    if (onTheClock === myTeamId) {
      // --- My turn: this is the path the app actually has to get right ---
      myTurns++;
      const board = buildDraftBoard(
        pool,
        settings,
        {
          pickNumber: ctx.currentPick,
          nextPickNumber: ctx.myFollowingPick ?? ctx.currentPick + size,
          drafted: ctx.draftedIds,
          myRoster: ctx.myRoster,
          live: ctx,
          market,
        },
        25,
      );

      check(
        board.recommendations.length > 0,
        `pick ${overall} (my turn ${myTurns}): board returned no recommendations`,
      );
      const leaked = board.recommendations.filter((r) => ctx.draftedIds.has(r.player.id));
      check(
        leaked.length === 0,
        `pick ${overall}: board recommended ${leaked.length} already-drafted player(s), e.g. ${leaked[0]?.player.name}`,
      );
      const ordered = board.recommendations.every(
        (r, i) => i === 0 || board.recommendations[i - 1].score >= r.score,
      );
      check(ordered, `pick ${overall}: recommendations are not sorted by score`);

      // Course correction is the piece that reads last turn's targets, so it
      // only ever runs meaningfully in a sequence like this one.
      const correction = courseCorrection(
        ctx,
        previousTargets,
        board.recommendations.map((r) => ({ player: r.player, score: r.score })),
        byId,
      );
      check(Array.isArray(correction), `pick ${overall}: course correction did not return notes`);
      const stillThere = previousTargets.filter((id) => !ctx.draftedIds.has(id)).length;
      sniped += previousTargets.length - stillThere;

      chosen = board.recommendations[0]?.player;
      previousTargets = board.recommendations.slice(0, 5).map((r) => r.player.id);

      if (verbose || myTurns <= 3) {
        const note = correction[0];
        console.log(
          `  ${String(overall).padStart(3)} R${String(Math.ceil(overall / size)).padStart(2)} ` +
            `YOU  -> ${chosen?.name ?? "(none)"} (${chosen?.position ?? "?"})` +
            (note ? `   [${note.label}]` : ""),
        );
      }
    } else {
      chosen = rivalPick(pool, taken, rand);
      if (verbose) {
        console.log(
          `  ${String(overall).padStart(3)} R${String(Math.ceil(overall / size)).padStart(2)} ` +
            `t${String(onTheClock).padStart(2)}  -> ${chosen?.name ?? "(none)"}`,
        );
      }
    }

    if (!chosen) {
      failures.push(`pick ${overall}: nobody could be selected -- pool exhausted early`);
      break;
    }

    taken.add(chosen.id);
    made.push({
      overallPick: overall,
      round: Math.ceil(overall / size),
      roundPick: ((overall - 1) % size) + 1,
      teamId: onTheClock ?? 0,
      playerId: chosen.id,
      keeper: false,
      bidAmount: undefined,
    });
  }

  // --- Final state ---
  const finalCtx = buildLiveDraftContext(
    { ...live, picks: made, inProgress: false, completed: true },
    settings,
    league.teams,
    pool,
    myTeamId,
  );
  check(
    finalCtx.myNextPick === null,
    `after a completed draft myNextPick should be null, got ${finalCtx.myNextPick}`,
  );
  check(
    finalCtx.myRoster.length === rounds,
    `my roster should hold ${rounds} players, got ${finalCtx.myRoster.length}`,
  );

  // The point of a draft is not a good roster, it is a *startable* one. A board
  // that returns fifteen excellent running backs has failed completely, and it
  // fails silently: every individual pick looks defensible, and nothing goes
  // wrong until week one when there is nobody to put in the kicker slot.
  const required = mandatoryStarters(settings);
  const held = {} as Record<string, number>;
  for (const p of finalCtx.myRoster) held[p.position] = (held[p.position] ?? 0) + 1;

  for (const [pos, count] of Object.entries(required)) {
    if (count <= 0) continue;
    check(
      (held[pos] ?? 0) >= count,
      `roster cannot fill its ${pos} slot(s): needs ${count}, drafted ${held[pos] ?? 0}`,
    );
  }

  // Flex takes the leftovers, so it is only legal if some eligible position ran
  // a surplus past its own dedicated slots.
  const flexCount = settings.lineupSlots.find((s) => s.slot === "FLEX")?.count ?? 0;
  if (flexCount > 0) {
    const flexEligible = ["RB", "WR", "TE"] as Array<keyof typeof required>;
    const spare = flexEligible.reduce(
      (n, pos) => n + Math.max(0, (held[pos] ?? 0) - (required[pos] ?? 0)),
      0,
    );
    check(
      spare >= flexCount,
      `roster cannot fill ${flexCount} FLEX slot(s): no RB/WR/TE left over past the dedicated slots`,
    );
  }

  console.log(`\nDrafted roster (seat ${mySlot}):`);
  const byPos = new Map<string, string[]>();
  for (const p of finalCtx.myRoster) {
    if (!byPos.has(p.position)) byPos.set(p.position, []);
    byPos.get(p.position)!.push(p.name);
  }
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const names = byPos.get(pos);
    if (names?.length) console.log(`  ${pos.padEnd(4)} ${names.join(", ")}`);
  }

  console.log(
    `\n${totalPicks} picks replayed · ${myTurns} of them mine · ${sniped} target(s) sniped between turns`,
  );
  if (failures.length) {
    console.log(`\n✗ ${failures.length} of ${checks} checks failed:`);
    for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
    if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more`);
    process.exitCode = 1;
  } else {
    console.log(`✓ All ${checks} checks passed across the full draft.`);
  }
}

/**
 * A rival's pick: near the top of the board by ADP, but not deterministic.
 *
 * Sampling from a window rather than always taking the best available is what
 * makes the replay useful -- a board that only ever sees the consensus order
 * never has to handle a target vanishing early.
 */
function rivalPick(pool: Player[], taken: Set<number>, rand: () => number): Player | undefined {
  const available = pool
    .filter((p) => !taken.has(p.id))
    .sort((a, b) => a.averageDraftPosition - b.averageDraftPosition);
  if (!available.length) return undefined;
  const window = Math.min(8, available.length);
  return available[Math.floor(rand() * window)];
}

/** Seeded generator so a failing replay can be re-run exactly. */
function lcg(s: number): () => number {
  let state = s >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function readFlag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Minimal .env reader so the script does not need a dotenv dependency. */
function loadEnvFile(name: string) {
  try {
    const text = readFileSync(resolve(process.cwd(), name), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Missing file is fine -- the variables may come from the shell.
  }
}

await main();
