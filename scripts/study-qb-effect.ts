/**
 * What a bad quarterback does to everyone else on his offence.
 *
 * Two claims, and they are not equally easy to check.
 *
 * The receiver claim -- a poor quarterback means worse throws, so fewer catches
 * and fewer yards per target -- is nearly circular. Receiving yards *are* the
 * quarterback's passing yards. Finding that receivers catch less from a bad
 * passer is close to finding that a bad passer is a bad passer. It is measured
 * here anyway, because the size of it is worth knowing even if the direction is
 * a foregone conclusion.
 *
 * The running back claim is the interesting one and it is genuinely testable.
 * If defences stop respecting the pass they can commit an extra man to the run,
 * and a back's yards per carry should fall for reasons that have nothing to do
 * with the back. Yards per carry is not the quarterback's statistic, so if it
 * moves with quarterback quality, something real is happening.
 *
 *   npm run qb-effect
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { normalizeTeam } = await import("../src/lib/engine/teamChange");

type SeasonStatLine = Awaited<ReturnType<typeof fetchSeasonStats>>[number];

const args = process.argv.slice(2);
const firstSeason = Number(readFlag("--from") ?? 2015);
const lastSeason = Number(readFlag("--to") ?? 2025);

interface TeamSeason {
  team: string;
  season: number;
  /** Passing yards per game by the team's main quarterback. */
  qbYardsPerGame: number;
  qbTdRate: number;
  qbIntRate: number;
  carries: number;
  rushYardsPerCarry: number;
  targets: number;
  catchRate: number;
  yardsPerTarget: number;
}

async function main() {
  await fetchLeague(credentialsFromEnv()); // fail early on bad credentials
  const rows: TeamSeason[] = [];

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
      const group = byTeam.get(team) ?? [];
      group.push(line);
      byTeam.set(team, group);
    }

    for (const [team, group] of byTeam) {
      // The main quarterback, not the sum: a team that lost its starter for
      // half a season had two different offences and averaging them describes
      // neither.
      const qb = [...group]
        .filter((l) => l.position === "QB")
        .sort((a, b) => b.passingYards - a.passingYards)[0];
      if (!qb || qb.games < 6) continue;

      const backs = group.filter((l) => l.position === "RB");
      const catchers = group.filter((l) => l.position === "WR" || l.position === "TE");

      const carries = backs.reduce((s, l) => s + l.carries, 0);
      const rushYards = backs.reduce((s, l) => s + l.rushingYards, 0);
      const targets = catchers.reduce((s, l) => s + l.targets, 0);
      const receptions = catchers.reduce((s, l) => s + l.receptions, 0);
      const recYards = catchers.reduce((s, l) => s + l.receivingYards, 0);
      if (carries < 200 || targets < 300) continue;

      const attemptsProxy = Math.max(1, qb.passingTds + qb.interceptions + targets * 0.5);
      rows.push({
        team,
        season,
        qbYardsPerGame: qb.passingYards / qb.games,
        qbTdRate: qb.passingTds / attemptsProxy,
        qbIntRate: qb.interceptions / attemptsProxy,
        carries,
        rushYardsPerCarry: rushYards / carries,
        targets,
        catchRate: receptions / targets,
        yardsPerTarget: recYards / targets,
      });
    }
  }

  if (rows.length < 40) {
    console.error(`✗ Only ${rows.length} team-seasons available; not enough to say anything.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${rows.length} team-seasons, ${firstSeason}-${lastSeason}\n`);

  const sorted = [...rows].sort((a, b) => a.qbYardsPerGame - b.qbYardsPerGame);
  const q = Math.floor(sorted.length / 4);
  const buckets: Array<[string, TeamSeason[]]> = [
    ["worst quarter", sorted.slice(0, q)],
    ["second", sorted.slice(q, q * 2)],
    ["third", sorted.slice(q * 2, q * 3)],
    ["best quarter", sorted.slice(q * 3)],
  ];

  console.log("Teams grouped by how much their main quarterback threw for:\n");
  console.log("  QB group        pass yds/g   RB yds/carry   RB carries   targets   catch rate   yds/target");
  for (const [label, group] of buckets) {
    console.log(
      `  ${label.padEnd(14)} ${mean(group.map((r) => r.qbYardsPerGame)).toFixed(0).padStart(8)}   ` +
        `${mean(group.map((r) => r.rushYardsPerCarry)).toFixed(2).padStart(10)}   ` +
        `${mean(group.map((r) => r.carries)).toFixed(0).padStart(9)}   ` +
        `${mean(group.map((r) => r.targets)).toFixed(0).padStart(6)}   ` +
        `${(mean(group.map((r) => r.catchRate)) * 100).toFixed(1).padStart(9)}%   ` +
        `${mean(group.map((r) => r.yardsPerTarget)).toFixed(2).padStart(9)}`,
    );
  }

  const worst = buckets[0][1];
  const best = buckets[3][1];
  console.log(`\nWorst quarter of quarterbacks against the best:`);
  report("running back yards per carry", worst.map((r) => r.rushYardsPerCarry), best.map((r) => r.rushYardsPerCarry));
  report("running back carries", worst.map((r) => r.carries), best.map((r) => r.carries));
  report("targets to receivers", worst.map((r) => r.targets), best.map((r) => r.targets));
  report("catch rate", worst.map((r) => r.catchRate * 100), best.map((r) => r.catchRate * 100));
  report("yards per target", worst.map((r) => r.yardsPerTarget), best.map((r) => r.yardsPerTarget));

  console.log(
    `\nThe receiver numbers are close to circular -- receiving yards are the\n` +
      `quarterback's passing yards, so a gap there mostly restates the grouping.\n` +
      `Yards per carry is the honest test: it is not his statistic, so if it moves\n` +
      `with him, defences really are treating those offences differently.`,
  );
}

/**
 * Difference between two groups, with the spread that would arise by chance.
 *
 * Without it any two groups differ by something and every difference reads as a
 * finding.
 */
function report(label: string, a: number[], b: number[]) {
  const diff = mean(b) - mean(a);
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  const sigmas = se > 0 ? Math.abs(diff) / se : 0;
  console.log(
    `  ${label.padEnd(28)} ${mean(a).toFixed(2).padStart(7)} -> ${mean(b).toFixed(2).padStart(7)}  ` +
      `difference ${(diff >= 0 ? "+" : "") + diff.toFixed(2)}  ` +
      `${sigmas >= 2 ? `real (${sigmas.toFixed(1)}x the noise)` : `could be chance (${sigmas.toFixed(1)}x)`}`,
  );
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
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
