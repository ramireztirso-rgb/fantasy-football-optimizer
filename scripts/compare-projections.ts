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
const { fetchPlayerIdIndex } = await import("../src/lib/sources/playerIds");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { componentProjection, positionalBaselines, compareToForecast } = await import(
  "../src/lib/engine/componentProjection"
);

type SeasonStatLine = Awaited<ReturnType<typeof fetchSeasonStats>>[number];

interface Row {
  name: string;
  position: string;
  adp: number;
  forecast: number;
  own: number;
  relativeGap: number;
  games: number;
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
    const own = componentProjection(lines, settings, player.position, baseline ?? 0);
    // Half the estimate coming from the positional baseline means we are
    // describing the baseline, not the player.
    if (!own || own.regression > 0.5) continue;

    const cmp = compareToForecast(player.seasonProjectedPoints, own, player.name);
    rows.push({
      name: player.name,
      position: player.position,
      adp: player.averageDraftPosition,
      forecast: player.seasonProjectedPoints,
      own: own.points,
      relativeGap: cmp.relativeGap,
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
        `${(r.relativeGap >= 0 ? "+" : "") + (r.relativeGap * 100).toFixed(0)}%`,
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
