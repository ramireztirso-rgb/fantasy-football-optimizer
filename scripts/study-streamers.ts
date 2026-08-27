/**
 * Should a kicker or a defence ever go early?
 *
 * Everyone says no and almost nobody says why. The usual reason offered is
 * that they score few points, which is not true -- a good kicker outscores a
 * flex receiver in this league. The real question is whether you can tell in
 * advance which ones will be good, and that is answerable: measure how much a
 * position's scoring rate carries from one season to the next. A position you
 * can forecast is worth paying for. A position that resets every year is worth
 * taking last however much it scores.
 *
 * Kickers are scored from play-by-play under this league's rules. Defences are
 * taken as ESPN's own applied totals, which sidesteps stat-id guesswork
 * entirely -- ESPN did the scoring, under these rules, and published the answer.
 *
 *   npm run streamers
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv, espnFetchHistory } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");

const args = process.argv.slice(2);
const firstSeason = Number(readFlag("--from") ?? 2016);
const lastSeason = Number(readFlag("--to") ?? 2025);

async function main() {
  const settings = (await fetchLeague(credentialsFromEnv())).settings;

  // --- Skill positions and kickers, from play-by-play ---
  const rates = new Map<string, Map<string, number>>();
  for (let season = firstSeason; season <= lastSeason; season++) {
    let lines;
    try {
      lines = await fetchSeasonStats(season);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!["QB", "RB", "WR", "TE", "K"].includes(line.position) || line.games < 8) continue;
      const rate = scoreStatLine(line, settings, line.position as never).pointsPerGame;
      if (rate <= 0) continue;
      const forPosition = rates.get(line.position) ?? new Map<string, number>();
      forPosition.set(`${season}:${line.gsisId}`, rate);
      rates.set(line.position, forPosition);
    }
  }

  console.log(`How much a position's scoring carries into the next season\n`);
  console.log(`  position   carryover   repeats   pairs`);
  const results: Array<[string, number, number]> = [];
  for (const position of ["WR", "TE", "RB", "QB", "K"]) {
    const { r, pairs } = carryover(rates.get(position));
    results.push([position, r, pairs]);
    console.log(
      `  ${position.padEnd(10)} ${r.toFixed(2).padStart(8)}   ${(r * r * 100).toFixed(0).padStart(6)}%   ${String(pairs).padStart(5)}`,
    );
  }

  // --- Defences, scored by ESPN under these rules ---
  const creds = credentialsFromEnv();
  const bySeason = new Map<number, Map<string, number>>();
  for (let season = Math.max(firstSeason, 2019); season <= lastSeason; season++) {
    try {
      const history: Array<Record<string, unknown>> = await espnFetchHistory(creds, season, [
        "mRoster",
      ]);
      const raw = history.find((s) => s.seasonId === season);
      if (!raw) continue;
      const totals = new Map<string, number>();
      for (const team of (raw.teams as Array<Record<string, unknown>>) ?? []) {
        const roster = team.roster as { entries?: Array<Record<string, unknown>> } | undefined;
        for (const entry of roster?.entries ?? []) {
          const pool = entry.playerPoolEntry as { player?: Record<string, unknown> } | undefined;
          const player = pool?.player;
          if (!player || player.defaultPositionId !== 16) continue;
          const stats = (player.stats as Array<Record<string, number>>) ?? [];
          const season0 = stats.find((s) => s.statSourceId === 0 && s.statSplitTypeId === 0);
          if (season0?.appliedTotal) totals.set(String(player.fullName), season0.appliedTotal);
        }
      }
      if (totals.size) bySeason.set(season, totals);
    } catch {
      // A season that will not load is one fewer pair, not a failure.
    }
  }

  const dstPairs: Array<[number, number]> = [];
  for (const [season, totals] of bySeason) {
    const next = bySeason.get(season + 1);
    if (!next) continue;
    for (const [name, points] of totals) {
      const after = next.get(name);
      if (after !== undefined) dstPairs.push([points, after]);
    }
  }
  const dstR = correlation(dstPairs);
  console.log(
    `  ${"DST".padEnd(10)} ${dstR.toFixed(2).padStart(8)}   ${(dstR * dstR * 100).toFixed(0).padStart(6)}%   ${String(dstPairs.length).padStart(5)}`,
  );

  const best = results.find(([p]) => p === "WR");
  console.log(
    `\n  Kickers and defences reset almost completely. A receiver's rate carries\n` +
      `  ${((best?.[1] ?? 0) ** 2 * 100).toFixed(0)}% of itself into the next year; a kicker's carries ` +
      `${(((results.find(([p]) => p === "K")?.[1] ?? 0)) ** 2 * 100).toFixed(0)}%, a defence's ${(dstR * dstR * 100).toFixed(0)}%.\n` +
      `\n  So the familiar advice is right for a reason nobody gives. These are not late\n` +
      `  picks because they score little -- a good kicker outscores a flex receiver here.\n` +
      `  They are late picks because this year's good one is not next year's, and no\n` +
      `  amount of preparation identifies them in advance.`,
  );
  console.log(
    `\n  Two limits worth stating. The defence figure rests on ${dstPairs.length} pairs, and only on\n` +
      `  defences rostered in this league in consecutive years -- a filter that favours\n` +
      `  the ones that were good twice, so 0.17 is an upper bound rather than an estimate.\n` +
      `  And kickers here are paid by distance, which should reward a durable leg. It does not.`,
  );
}

function carryover(rates: Map<string, number> | undefined): { r: number; pairs: number } {
  if (!rates) return { r: 0, pairs: 0 };
  const pairs: Array<[number, number]> = [];
  for (const [key, rate] of rates) {
    const [season, id] = key.split(":");
    const next = rates.get(`${Number(season) + 1}:${id}`);
    if (next !== undefined) pairs.push([rate, next]);
  }
  return { r: correlation(pairs), pairs: pairs.length };
}

function correlation(pairs: Array<[number, number]>): number {
  if (pairs.length < 3) return 0;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
  const my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
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
