/**
 * Does a heavy season actually cost a running back the next one?
 *
 * The claim is old and specific -- somewhere around three hundred and seventy
 * carries a back is said to be spent -- and it is the sort that confirms itself
 * if you test it carelessly. Any group picked for having a big year declines
 * afterwards, because the group was selected partly for good luck and luck does
 * not repeat. Line up last season's workhorses, watch them fall off, and the
 * curse looks real when all you have measured is regression to the mean.
 *
 * So the workload has to be separated from what the workload produced. Backs
 * are bucketed by how well they scored, and *within* each of those bands
 * compared by how many carries it took them to do it. If heavy usage does the
 * damage, the worn-down back should fall further than the back who scored just
 * as well on half the carries. If both fall the same distance, the carries were
 * never the cause and the decline was only ever the mean pulling them back.
 *
 *   npm run workload
 *   npm run workload -- --min-games 10
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");

const args = process.argv.slice(2);
const minGames = Number(readFlag("--min-games") ?? 8);
const firstSeason = Number(readFlag("--from") ?? 2015);
const lastSeason = Number(readFlag("--to") ?? 2025);

interface Pair {
  name: string;
  season: number;
  carries: number;
  ppgBefore: number;
  ppgAfter: number;
  delta: number;
}

async function main() {
  const league = await fetchLeague(credentialsFromEnv());
  const settings = league.settings;

  const bySeason = new Map<number, Map<string, { ppg: number; carries: number; name: string }>>();
  for (let season = firstSeason; season <= lastSeason; season++) {
    try {
      const lines = await fetchSeasonStats(season);
      const map = new Map<string, { ppg: number; carries: number; name: string }>();
      for (const line of lines) {
        if (line.position !== "RB" || line.games < minGames) continue;
        map.set(line.gsisId, {
          ppg: scoreStatLine(line, settings, "RB").pointsPerGame,
          carries: line.carries,
          name: line.name,
        });
      }
      bySeason.set(season, map);
    } catch {
      // Season unavailable; the pairs that need it simply do not form.
    }
  }

  const pairs: Pair[] = [];
  for (const [season, map] of bySeason) {
    const next = bySeason.get(season + 1);
    if (!next) continue;
    for (const [id, before] of map) {
      const after = next.get(id);
      // A back who does not appear the next season is dropped, and that is a
      // real limitation: it discards the most extreme outcome there is, which
      // is being finished. It is reported below rather than hidden.
      if (!after) continue;
      pairs.push({
        name: before.name,
        season,
        carries: before.carries,
        ppgBefore: before.ppg,
        ppgAfter: after.ppg,
        delta: after.ppg - before.ppg,
      });
    }
  }

  console.log(`Running backs, ${firstSeason}-${lastSeason}, ${minGames}+ games in both seasons`);
  console.log(`Scored under "${settings.name}" rules · ${pairs.length} season pairs\n`);

  console.log("The naive test -- bucket by carries, watch the next season:");
  const carryBands: Array<[string, (c: number) => boolean]> = [
    ["under 150", (c) => c < 150],
    ["150-224", (c) => c >= 150 && c < 225],
    ["225-299", (c) => c >= 225 && c < 300],
    ["300+", (c) => c >= 300],
  ];
  for (const [label, test] of carryBands) {
    const group = pairs.filter((p) => test(p.carries));
    if (group.length < 5) continue;
    console.log(
      `  ${label.padEnd(9)} n=${String(group.length).padStart(3)}  ` +
        `before ${mean(group.map((p) => p.ppgBefore)).toFixed(1).padStart(5)}  ` +
        `after ${mean(group.map((p) => p.ppgAfter)).toFixed(1).padStart(5)}  ` +
        `change ${signed(mean(group.map((p) => p.delta)))}`,
    );
  }

  console.log(`\nThe controlled test -- same scoring band, split by how many carries it took:`);
  console.log(`  scoring band     light usage          heavy usage         difference`);
  const scoreBands: Array<[string, (p: number) => boolean]> = [
    ["8-11 ppg", (p) => p >= 8 && p < 11],
    ["11-14 ppg", (p) => p >= 11 && p < 14],
    ["14-17 ppg", (p) => p >= 14 && p < 17],
    ["17+ ppg", (p) => p >= 17],
  ];
  for (const [label, test] of scoreBands) {
    const group = pairs.filter((p) => test(p.ppgBefore));
    if (group.length < 12) continue;
    const median = [...group].sort((a, b) => a.carries - b.carries)[Math.floor(group.length / 2)]
      .carries;
    const light = group.filter((p) => p.carries < median);
    const heavy = group.filter((p) => p.carries >= median);
    if (light.length < 5 || heavy.length < 5) continue;

    const lightDelta = mean(light.map((p) => p.delta));
    const heavyDelta = mean(heavy.map((p) => p.delta));
    console.log(
      `  ${label.padEnd(15)} ${signed(lightDelta)} (n=${String(light.length).padStart(3)})     ` +
        `${signed(heavyDelta)} (n=${String(heavy.length).padStart(3)})    ` +
        `${signed(heavyDelta - lightDelta)}`,
    );
  }

  const heavy = pairs.filter((p) => p.carries >= 300);
  if (heavy.length >= 5) {
    console.log(`\nThe 300-carry seasons themselves, worst falls first:`);
    for (const p of [...heavy].sort((a, b) => a.delta - b.delta).slice(0, 8)) {
      console.log(
        `  ${p.name.slice(0, 22).padEnd(22)} ${p.season} ${String(p.carries).padStart(3)} carries  ` +
          `${p.ppgBefore.toFixed(1)} -> ${p.ppgAfter.toFixed(1)} ppg  ${signed(p.delta)}`,
      );
    }
  }

  console.log(
    `\nRead the difference column. If heavy usage were the cause it would be\n` +
      `consistently negative; if it is near zero the carries never mattered and\n` +
      `both groups are only being pulled back toward the middle.\n` +
      `Backs who did not play enough the following season are excluded, which\n` +
      `drops the most extreme outcome of all -- so this understates any real effect.`,
  );
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`.padStart(6);
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
