/**
 * Where ESPN's forecast and a player's own production disagree.
 *
 * The board has only ever had one opinion in it. ESPN projects, the board
 * ranks, and if ESPN is wrong about somebody the board is wrong about him in
 * exactly the same direction with no way to notice.
 *
 * The second opinion itself lives in the source the draft board uses -- this
 * script is the league-wide view of it: both tails of the disagreement, sorted,
 * with the team-change flags that mark where the history is least trustworthy.
 * It used to assemble the aging curve and baselines itself, in parallel with
 * the source, which was two implementations of one model waiting to drift.
 *
 *   npm run compare
 *   npm run compare -- --position WR --max-adp 120
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague } = await import("../src/lib/espn/league");
const { fetchSecondOpinion } = await import("../src/lib/sources/secondOpinion");

interface Row {
  name: string;
  position: string;
  adp: number;
  forecast: number;
  own: number;
  relativeGap: number;
  aged: number;
  movedFrom: string | null;
}

const args = process.argv.slice(2);
const onlyPosition = readFlag("--position")?.toUpperCase();
const maxAdp = Number(readFlag("--max-adp") ?? 180);
const show = Number(readFlag("--show") ?? 12);
/**
 * Below this, ESPN is not making a low forecast -- it is saying the player
 * will not play, which is a depth-chart call rather than a disagreement.
 */
const minForecast = Number(readFlag("--min-forecast") ?? 60);

async function main() {
  const creds = credentialsFromEnv();
  const [pool, league] = await Promise.all([fetchDraftPool(creds), fetchLeague(creds)]);
  const opinions = await fetchSecondOpinion(league.settings);

  console.log(
    `Second opinions under "${league.settings.name}" rules · aging curve fitted on ${opinions.fitted} pairs`,
  );

  const rows: Row[] = [];
  let unmatched = 0;
  for (const player of pool) {
    if (player.averageDraftPosition > maxAdp) continue;
    if (onlyPosition && player.position !== onlyPosition) continue;
    if (player.seasonProjectedPoints < minForecast) continue;

    const opinion = opinions.for(player);
    if (!opinion) {
      if (["QB", "RB", "WR", "TE"].includes(player.position)) unmatched++;
      continue;
    }
    rows.push({
      name: player.name,
      position: player.position,
      adp: player.averageDraftPosition,
      forecast: player.seasonProjectedPoints,
      own: opinion.fromOwnProduction,
      relativeGap: opinion.relativeGap,
      aged: opinion.ageAdjustment,
      movedFrom: opinion.movedFrom,
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
    `${agree} of ${rows.length} (${((agree / rows.length) * 100).toFixed(0)}%) agree within 15%. ` +
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
