/**
 * Who owns a backfield, who is fragile, and who inherits the job.
 *
 * A projection tells you how many points a back is expected to score. It does
 * not tell you whether he got there as the only back his team uses or as one of
 * three splitting the work, and those are different bets with the same number
 * on them.
 *
 *   npm run backfields
 *   npm run backfields -- --max-adp 120
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague } = await import("../src/lib/espn/league");
const { fetchPlayerIdIndex } = await import("../src/lib/sources/playerIds");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { backfieldShares, injuryRecord, findHandcuffs } = await import(
  "../src/lib/engine/backfield"
);

type SeasonStatLine = Awaited<ReturnType<typeof fetchSeasonStats>>[number];

const args = process.argv.slice(2);
const maxAdp = Number(readFlag("--max-adp") ?? 150);

async function main() {
  const creds = credentialsFromEnv();
  const [pool, league, ids] = await Promise.all([
    fetchDraftPool(creds),
    fetchLeague(creds),
    fetchPlayerIdIndex(),
  ]);

  const lastSeason = league.settings.seasonId - 1;
  const history = new Map<string, SeasonStatLine[]>();
  let latest: SeasonStatLine[] = [];
  for (let season = lastSeason - 2; season <= lastSeason; season++) {
    try {
      const lines = await fetchSeasonStats(season);
      if (season === lastSeason) latest = lines;
      for (const line of lines) {
        const prior = history.get(line.gsisId) ?? [];
        prior.push(line);
        history.set(line.gsisId, prior);
      }
    } catch {
      // Season unavailable; everything below degrades rather than fails.
    }
  }

  const shares = backfieldShares(latest);
  const gsisIdFor = (p: { id: number }) => ids.byEspnId.get(p.id)?.gsisId;
  const injuryFor = (p: { id: number }) => {
    const gsis = gsisIdFor(p);
    return injuryRecord(gsis ? (history.get(gsis) ?? []) : []);
  };

  const backs = pool
    .filter((p) => p.position === "RB" && p.averageDraftPosition <= maxAdp)
    .sort((a, b) => a.averageDraftPosition - b.averageDraftPosition);

  console.log(`Backfield usage in ${lastSeason}, for backs going inside pick ${maxAdp}\n`);
  console.log(`  ADP  back                     team  carries  share  role         misses/yr`);
  for (const p of backs) {
    const gsis = gsisIdFor(p);
    const share = gsis ? shares.get(gsis) : undefined;
    const injury = injuryFor(p);
    console.log(
      `  ${String(Math.round(p.averageDraftPosition)).padStart(3)}  ${p.name.slice(0, 23).padEnd(23)} ` +
        `${p.proTeam.padEnd(4)} ${share ? String(share.carries).padStart(6) : "     -"}  ` +
        `${share ? `${(share.share * 100).toFixed(0)}%`.padStart(5) : "    -"}  ` +
        `${(share?.role ?? "no data").padEnd(11)}  ${injury.missedPerSeason.toFixed(1).padStart(4)}` +
        `${injury.fragile ? "  fragile" : ""}`,
    );
  }

  // Treat the top handful of backs as a plausible roster to show the pairings.
  const sample = backs.slice(0, 6);
  const isRookie = (p: { id: number }) =>
    ids.byEspnId.get(p.id)?.draftYear === league.settings.seasonId;
  const cuffs = findHandcuffs(sample, pool, shares, gsisIdFor, injuryFor, isRookie);
  console.log(`\nHandcuffs, if you owned each of these backs:\n`);
  for (const c of cuffs) {
    console.log(
      c.backup
        ? `  ${c.starter.name} -> ${c.backup.name} (ADP ${Math.round(c.backup.averageDraftPosition)})`
        : `  ${c.starter.name} -> nobody obvious`,
    );
    console.log(`     ${c.detail}`);
  }
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
