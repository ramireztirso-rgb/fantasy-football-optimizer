/**
 * Where ESPN's forecast and a player's own production disagree.
 *
 * The board has only ever had one opinion in it. ESPN projects, the board
 * ranks, and if ESPN is wrong about somebody the board is wrong about him in
 * exactly the same direction with no way to notice.
 *
 * This builds the second opinion: every player's recent production, scored
 * under this league's rules, regressed for sample size, set beside the
 * forecast. It does not adjudicate -- a forecast far above a young player's
 * own rate is usually pricing in a role that has not shown up yet and is
 * often right. It just stops the disagreement being invisible.
 *
 *   npm run compare
 *   npm run compare -- --position WR --max-adp 120
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague } = await import("../src/lib/espn/league");
const { fetchPlayerIdIndex, ageAtSeason } = await import("../src/lib/sources/playerIds");
const { buildAgeCurve } = await import("../src/lib/engine/aging");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { componentProjection, positionalBaselines, compareToForecast } = await import(
  "../src/lib/engine/componentProjection"
);
const { detectTeamChange } = await import("../src/lib/engine/teamChange");

type SeasonStatLine = Awaited<ReturnType<typeof fetchSeasonStats>>[number];

interface Row {
  name: string;
  position: string;
  adp: number;
  forecast: number;
  own: number;
  relativeGap: number;
  games: number;
  /** Points a game the aging curve added or removed. */
  aged: number;
  /** Where he played last, when that is somewhere else. */
  movedFrom: string | null;
}

const args = process.argv.slice(2);
const onlyPosition = readFlag("--position")?.toUpperCase();
const maxAdp = Number(readFlag("--max-adp") ?? 180);
const seasonsBack = Number(readFlag("--seasons") ?? 3);
const show = Number(readFlag("--show") ?? 12);
/**
 * Below this, ESPN is not making a low forecast -- it is saying the player will
 * not play. Comparing "0 projected points" against a healthy season's
 * production measures a depth-chart or injury decision, not a disagreement
 * about volume, and it swamps the tail with noise.
 */
const minForecast = Number(readFlag("--min-forecast") ?? 60);

/** nflverse carries every position on an NFL roster; only these are fantasy. */
const FANTASY_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

async function main() {
  const creds = credentialsFromEnv();
  const [pool, league, ids] = await Promise.all([
    fetchDraftPool(creds),
    fetchLeague(creds),
    fetchPlayerIdIndex(),
  ]);
  const settings = league.settings;

  const latest = settings.seasonId - 1;
  const seasons: number[] = [];
  const history = new Map<string, SeasonStatLine[]>();
  const byPosition = new Map<string, SeasonStatLine[]>();

  for (let season = latest - seasonsBack + 1; season <= latest; season++) {
    try {
      const lines = await fetchSeasonStats(season);
      seasons.push(season);
      for (const line of lines) {
        const prior = history.get(line.gsisId) ?? [];
        prior.push(line);
        history.set(line.gsisId, prior);
        if (!FANTASY_POSITIONS.has(line.position)) continue;
        const pos = byPosition.get(line.position) ?? [];
        pos.push(line);
        byPosition.set(line.position, pos);
      }
    } catch (err) {
      console.log(`  ${season} unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!seasons.length) {
    console.error("✗ No seasons loaded.");
    process.exitCode = 1;
    return;
  }

  // The aging curve, fitted from the same seasons rather than assumed. Without
  // it the disagreement below sorts almost perfectly by age, which is an aging
  // curve showing through rather than anything anyone can act on.
  const ageObservations: Array<{ position: never; age: number; delta: number }> = [];
  const rateByKey = new Map<string, number>();
  for (const [gsisId, lines] of history) {
    for (const line of lines) {
      if (line.games < 8) continue;
      const scored = scoreStatLine(line, settings, line.position as never);
      if (scored.pointsPerGame > 0) rateByKey.set(`${line.season}:${gsisId}`, scored.pointsPerGame);
    }
  }
  for (const [key, rate] of rateByKey) {
    const [seasonText, gsisId] = key.split(":");
    const next = rateByKey.get(`${Number(seasonText) + 1}:${gsisId}`);
    if (next === undefined) continue;
    const identity = ids.byGsisId.get(gsisId);
    if (!identity?.position) continue;
    const age = ageAtSeason(identity, Number(seasonText));
    if (age === null) continue;
    ageObservations.push({ position: identity.position as never, age, delta: next - rate });
  }
  const ageCurve = buildAgeCurve(ageObservations);
  console.log(`Aging curve fitted on ${ageObservations.length} season pairs`);

  const baselines = positionalBaselines(byPosition as never, settings);
  console.log(`Seasons ${seasons.join(", ")} · scored under "${settings.name}" rules`);
  console.log(
    `Replacement-level points per game: ` +
      Object.entries(baselines)
        .map(([pos, v]) => `${pos} ${(v as number).toFixed(1)}`)
        .join("  "),
  );

  const rows: Row[] = [];
  let unmatched = 0;

  for (const player of pool) {
    if (player.averageDraftPosition > maxAdp) continue;
    if (onlyPosition && player.position !== onlyPosition) continue;

    if (player.seasonProjectedPoints < minForecast) continue;

    const identity = ids.byEspnId.get(player.id);
    const lines = identity?.gsisId ? history.get(identity.gsisId) : undefined;
    if (!lines?.length) {
      unmatched++;
      continue;
    }

    const baseline = baselines[player.position as never] as number | undefined;

    const ageBySeason = new Map<number, number>();
    for (const line of lines) {
      const was = identity ? ageAtSeason(identity, line.season) : null;
      if (was !== null) ageBySeason.set(line.season, was);
    }
    const targetAge = identity ? ageAtSeason(identity, settings.seasonId) : null;
    const aging =
      targetAge !== null && ageBySeason.size
        ? {
            ageBySeason,
            targetAge,
            between: (from: number, to: number) =>
              ageCurve.between(player.position as never, from, to),
          }
        : undefined;

    const own = componentProjection(lines, settings, player.position, baseline ?? 0, aging);
    // Half the estimate coming from the positional baseline means we are
    // describing the baseline, not the player.
    if (!own || own.regression > 0.5) continue;

    const move = detectTeamChange(player, lines);
    const cmp = compareToForecast(player.seasonProjectedPoints, own, player.name);
    rows.push({
      movedFrom: move?.changed ? move.from : null,
      name: player.name,
      position: player.position,
      adp: player.averageDraftPosition,
      forecast: player.seasonProjectedPoints,
      own: own.points,
      relativeGap: cmp.relativeGap,
      aged: own.ageAdjustment,
      games: own.gamesOfHistory,
    });
  }

  console.log(
    `\n${rows.length} draftable players compared · ${unmatched} without usable history ` +
      `(rookies, and anyone who has not played)\n` +
      `Excluding anyone ESPN projects under ${minForecast} points -- that is a depth-chart\n` +
      `call, not a disagreement about production.\n`,
  );

  const sorted = [...rows].sort((a, b) => b.relativeGap - a.relativeGap);
  print("ESPN is highest above their own production", sorted.slice(0, show));
  print("ESPN is furthest below their own production", sorted.slice(-show).reverse());

  const moved = rows.filter((r) => r.movedFrom);
  console.log(
    `${moved.length} of ${rows.length} compared players changed teams. Their own-production\n` +
      `figure is the least trustworthy number in this table -- it is extrapolating targets\n` +
      `that belonged to a different offence.\n`,
  );

  const agree = rows.filter((r) => Math.abs(r.relativeGap) < 0.15).length;
  console.log(
    `\n${agree} of ${rows.length} (${((agree / rows.length) * 100).toFixed(0)}%) agree within 15%. ` +
      `The tails are where the board currently has no second opinion.`,
  );
}

function print(title: string, rows: Row[]) {
  console.log(`${title}:`);
  console.log(`  pos  player                  ADP   ESPN   own    gap`);
  for (const r of rows) {
    console.log(
      `  ${r.position.padEnd(4)} ${r.name.slice(0, 22).padEnd(22)} ` +
        `${String(Math.round(r.adp)).padStart(4)} ` +
        `${String(Math.round(r.forecast)).padStart(5)} ` +
        `${String(Math.round(r.own)).padStart(5)}  ` +
        `${((r.relativeGap >= 0 ? "+" : "") + (r.relativeGap * 100).toFixed(0) + "%").padStart(5)}` +
        `${r.movedFrom ? `   moved from ${r.movedFrom}` : ""}`,
    );
  }
  console.log("");
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
    // Absent env file is fine; credentialsFromEnv reports what is missing.
  }
}

await main();
