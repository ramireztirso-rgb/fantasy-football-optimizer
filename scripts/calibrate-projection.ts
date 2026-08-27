/**
 * How much should a projection trust the player and how much the population?
 *
 * The history-based projection shrinks a player's own scoring rate toward a
 * positional baseline, harder the less he has played. Both halves of that were
 * picked rather than measured: a half-weight point at sixteen games, and a
 * baseline set to the median of everyone who played. The consequence showed up
 * as Justin Jefferson appearing among players ESPN supposedly over-rates, which
 * he is not -- a quarter of his estimate was made of the sixtieth-best
 * receiver.
 *
 * So this measures both. Every player-season since 2016 is projected forward
 * using only what was known at the time, under every combination of shrink
 * strength and baseline, and scored against what actually happened. The
 * settings that predict best win. Guessing a fifth scoring change was how the
 * previous four went wrong.
 *
 *   npm run calibrate
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { fetchPlayerIdIndex, ageAtSeason } = await import("../src/lib/sources/playerIds");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");
const { buildAgeCurve } = await import("../src/lib/engine/aging");

type SeasonStatLine = Awaited<ReturnType<typeof fetchSeasonStats>>[number];

const args = process.argv.slice(2);
const firstSeason = Number(readFlag("--from") ?? 2016);
const lastSeason = Number(readFlag("--to") ?? 2025);

/** Half-weight points to try, in games of history. Zero means no shrink at all. */
const SHRINK_POINTS = [0, 4, 8, 16, 24, 32, 48];

interface Row {
  gsisId: string;
  position: string;
  season: number;
  rate: number;
  games: number;
  age: number | null;
}

async function main() {
  const settings = (await fetchLeague(credentialsFromEnv())).settings;
  const ids = await fetchPlayerIdIndex();

  const rows: Row[] = [];
  for (let season = firstSeason; season <= lastSeason; season++) {
    let lines: SeasonStatLine[];
    try {
      lines = await fetchSeasonStats(season);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!["RB", "WR", "TE", "QB"].includes(line.position) || line.games < 4) continue;
      const rate = scoreStatLine(line, settings, line.position as never).pointsPerGame;
      if (rate <= 0) continue;
      const identity = ids.byGsisId.get(line.gsisId);
      rows.push({
        gsisId: line.gsisId,
        position: line.position,
        season,
        rate,
        games: line.games,
        age: identity ? ageAtSeason(identity, season) : null,
      });
    }
  }

  const curve = buildAgeCurve(
    rows.flatMap((row) => {
      const next = rows.find((r) => r.gsisId === row.gsisId && r.season === row.season + 1);
      if (!next || row.age === null) return [];
      return [{ position: row.position as never, age: row.age, delta: next.rate - row.rate }];
    }),
  );

  // Baselines per position per season, each a different theory of "the player
  // you could have had instead".
  const baselines = new Map<string, Map<string, number>>();
  for (const position of ["RB", "WR", "TE", "QB"]) {
    for (let season = firstSeason; season <= lastSeason; season++) {
      const rates = rows
        .filter((r) => r.position === position && r.season === season)
        .map((r) => r.rate)
        .sort((a, b) => b - a);
      if (rates.length < 12) continue;
      // Roughly the last player a twelve-team league starts at the position.
      const startersDeep = position === "QB" ? 12 : position === "TE" ? 13 : 29;
      const key = `${position}:${season}`;
      for (const [name, value] of [
        ["median of everyone", rates[Math.floor(rates.length / 2)]],
        ["mean of everyone", rates.reduce((a, b) => a + b, 0) / rates.length],
        ["last startable", rates[Math.min(rates.length - 1, startersDeep)]],
      ] as Array<[string, number]>) {
        const forName = baselines.get(name) ?? new Map<string, number>();
        forName.set(key, value);
        baselines.set(name, forName);
      }
    }
  }

  // Each test case: what was known before a season, and what happened in it.
  interface Case {
    position: string;
    season: number;
    ownRate: number;
    games: number;
    actual: number;
  }
  const cases: Case[] = [];
  for (const row of rows) {
    const next = rows.find((r) => r.gsisId === row.gsisId && r.season === row.season + 1);
    if (!next) continue;
    const prior = rows.filter((r) => r.gsisId === row.gsisId && r.season <= row.season);
    const recent = prior.sort((a, b) => b.season - a.season).slice(0, 3);
    const weights = [0.6, 0.28, 0.12];

    let weighted = 0;
    let used = 0;
    let games = 0;
    recent.forEach((r, i) => {
      const weight = weights[i] * Math.min(1, r.games / 16);
      const carried =
        r.age !== null && next.age !== null
          ? curve.between(r.position as never, r.age, next.age)
          : 0;
      weighted += (r.rate + carried) * weight;
      used += weight;
      games += r.games;
    });
    if (used <= 0) continue;
    cases.push({
      position: row.position,
      season: next.season,
      ownRate: weighted / used,
      games,
      actual: next.rate,
    });
  }

  console.log(
    `Calibrating on ${cases.length} player-seasons, ${firstSeason}-${lastSeason}, ` +
      `scored under "${settings.name}" rules.`,
  );
  console.log(`Average error in points a game -- lower is better.\n`);

  const names = ["median of everyone", "mean of everyone", "last startable"];
  console.log(`  shrink   ${names.map((n) => n.padStart(20)).join("")}`);

  let best = { error: Infinity, shrink: 0, baseline: "" };
  for (const shrink of SHRINK_POINTS) {
    const cells: string[] = [];
    for (const name of names) {
      const table = baselines.get(name);
      let total = 0;
      let n = 0;
      for (const c of cases) {
        const baseline = table?.get(`${c.position}:${c.season - 1}`);
        if (baseline === undefined) continue;
        const weight = shrink / (shrink + c.games);
        const predicted = c.ownRate * (1 - weight) + baseline * weight;
        total += Math.abs(predicted - c.actual);
        n++;
      }
      const error = n ? total / n : Infinity;
      if (error < best.error) best = { error, shrink, baseline: name };
      cells.push(error.toFixed(3).padStart(20));
    }
    console.log(`  ${String(shrink).padStart(6)}   ${cells.join("")}`);
  }

  console.log(
    `\n  Best: shrink toward the ${best.baseline} with a half-weight point of ` +
      `${best.shrink} games,\n  at ${best.error.toFixed(3)} points a game of average error.`,
  );
  console.log(
    `\n  The projection currently uses the median of everyone at 16 games. A row that\n` +
      `  beats it is a change worth making; a table that is flat across the top says the\n` +
      `  setting never mattered and the disagreement lies somewhere else.`,
  );
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
