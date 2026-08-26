/**
 * Is a fast offence worth drafting from?
 *
 * The reasoning is sound on its face. A team that runs more plays gives its
 * players more carries and more targets, and fantasy scoring is mostly volume,
 * so the same player is worth more in a fast offence than a slow one.
 *
 * The step nobody checks is whether pace is a property of a team at all. It
 * only helps at a draft if a team that was fast last season is fast this
 * season. If it moves around year to year -- following the score, the injuries,
 * the coordinator -- then knowing last year's pace tells you nothing about this
 * year's, however real the effect within a season.
 *
 * Plays are counted as carries plus targets, which is every offensive snap that
 * puts the ball in a fantasy player's hands. It misses sacks and scrambles and
 * is close enough for a question about ranking teams against each other.
 *
 *   npm run pace
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { normalizeTeam } = await import("../src/lib/engine/teamChange");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");

type SeasonStatLine = Awaited<ReturnType<typeof fetchSeasonStats>>[number];

const args = process.argv.slice(2);
const firstSeason = Number(readFlag("--from") ?? 2015);
const lastSeason = Number(readFlag("--to") ?? 2025);

interface TeamPace {
  team: string;
  season: number;
  playsPerGame: number;
  carriesPerGame: number;
  targetsPerGame: number;
  /** Points per game the whole skill-position group scored under our rules. */
  skillPointsPerGame: number;
}

async function main() {
  const settings = (await fetchLeague(credentialsFromEnv())).settings;
  const rows: TeamPace[] = [];

  for (let season = firstSeason; season <= lastSeason; season++) {
    let lines: SeasonStatLine[];
    try {
      lines = await fetchSeasonStats(season);
    } catch {
      continue;
    }

    const byTeam = new Map<string, SeasonStatLine[]>();
    for (const line of lines) {
      if (!line.team) continue;
      const team = normalizeTeam(line.team);
      byTeam.set(team, [...(byTeam.get(team) ?? []), line]);
    }

    for (const [team, group] of byTeam) {
      const skill = group.filter((l) => ["RB", "WR", "TE"].includes(l.position));
      if (!skill.length) continue;
      // Team games, not the sum of player games: seventeen either way, and
      // summing players would count each game once per player on the field.
      const games = Math.max(...group.map((l) => l.games));
      if (games < 14) continue;

      const carries = skill.reduce((s, l) => s + l.carries, 0);
      const targets = skill.reduce((s, l) => s + l.targets, 0);
      if (carries + targets < 700) continue;

      const points = skill.reduce(
        (s, l) => s + scoreStatLine(l, settings, l.position as never).points,
        0,
      );
      rows.push({
        team,
        season,
        playsPerGame: (carries + targets) / games,
        carriesPerGame: carries / games,
        targetsPerGame: targets / games,
        skillPointsPerGame: points / games,
      });
    }
  }

  console.log(`${rows.length} team-seasons, ${firstSeason}-${lastSeason}\n`);

  // --- Does pace carry from one year to the next? ---
  const byKey = new Map(rows.map((r) => [`${r.season}:${r.team}`, r]));
  const pacePairs: Array<[number, number]> = [];
  for (const row of rows) {
    const next = byKey.get(`${row.season + 1}:${row.team}`);
    if (next) pacePairs.push([row.playsPerGame, next.playsPerGame]);
  }
  const r = correlation(pacePairs);
  console.log(
    `Pace carries ${r.toFixed(2)} from one season to the next -- ` +
      `${(r * r * 100).toFixed(0)}% of it is a property of the team,\n` +
      `the rest is whatever happened that year. (${pacePairs.length} pairs)\n`,
  );

  // --- Is it worth anything within a season? ---
  const sorted = [...rows].sort((a, b) => a.playsPerGame - b.playsPerGame);
  const q = Math.floor(sorted.length / 4);
  const buckets: Array<[string, TeamPace[]]> = [
    ["slowest quarter", sorted.slice(0, q)],
    ["second", sorted.slice(q, q * 2)],
    ["third", sorted.slice(q * 2, q * 3)],
    ["fastest quarter", sorted.slice(q * 3)],
  ];

  console.log(`Within a season, what a fast offence is worth:\n`);
  console.log(`  pace group        plays/g   carries/g   targets/g   skill pts/g`);
  for (const [label, group] of buckets) {
    console.log(
      `  ${label.padEnd(16)} ${mean(group.map((x) => x.playsPerGame)).toFixed(1).padStart(6)}   ` +
        `${mean(group.map((x) => x.carriesPerGame)).toFixed(1).padStart(8)}   ` +
        `${mean(group.map((x) => x.targetsPerGame)).toFixed(1).padStart(8)}   ` +
        `${mean(group.map((x) => x.skillPointsPerGame)).toFixed(1).padStart(10)}`,
    );
  }

  const slow = buckets[0][1];
  const fast = buckets[3][1];
  const gap = mean(fast.map((x) => x.skillPointsPerGame)) - mean(slow.map((x) => x.skillPointsPerGame));
  const shared = gap * r * r;

  console.log(
    `\n  The fastest quarter of offences produce ${gap.toFixed(1)} more fantasy points a game across\n` +
      `  their skill players than the slowest. That is a real gap and it is spread over a\n` +
      `  whole offence, so call it ${(gap / 5).toFixed(1)} a game for one player of the five who matter.\n` +
      `\n  But only ${(r * r * 100).toFixed(0)}% of pace repeats, so what you can act on at a draft is nearer\n` +
      `  ${(shared / 5).toFixed(2)} points a game per player. ${
        shared / 5 < 0.5
          ? "That is not draftable. Pace is real and it is not predictable."
          : "Worth a tiebreaker, no more."
      }`,
  );
}

function correlation(pairs: Array<[number, number]>): number {
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
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
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
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
