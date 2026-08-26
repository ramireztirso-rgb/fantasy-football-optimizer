/**
 * Does the second-year receiver breakout actually happen?
 *
 * Draft advice is full of rules like this, and they are repeated because they
 * are memorable rather than because anyone checked. They are also exactly the
 * kind of claim that survivorship bias manufactures: everyone remembers the
 * second-year receivers who broke out, because a receiver who does nothing in
 * year two is out of the league by year four and nobody writes about him.
 *
 * So this measures it. Every player-season since 2015 is scored under *this*
 * league's rules -- which is the only scoring that matters here, and is not
 * the scoring any published study used -- bucketed by years of NFL experience,
 * and asked a fixed question: what share of players at this experience level
 * finished as a startable fantasy option for the first time?
 *
 * It also runs the obvious rival explanation. If "second-year receivers break
 * out" is really "first-round receivers break out, and they get their chance in
 * year two", then splitting by draft capital should absorb the effect. That is
 * the difference between a rule you can draft on and a coincidence.
 *
 *   npm run study
 *   npm run study -- --position RB --top 24
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchPlayerIdIndex, experienceIn } = await import("../src/lib/sources/playerIds");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");

const args = process.argv.slice(2);
const position = (readFlag("--position") ?? "WR").toUpperCase();
const topN = Number(readFlag("--top") ?? 24);
const firstSeason = Number(readFlag("--from") ?? 2015);
const lastSeason = Number(readFlag("--to") ?? 2025);
const minGames = Number(readFlag("--min-games") ?? 6);

interface PlayerSeason {
  gsisId: string;
  name: string;
  season: number;
  experience: number;
  draftRound: number | null;
  pointsPerGame: number;
  games: number;
  startable: boolean;
}

async function main() {
  const creds = credentialsFromEnv();
  const [league, ids] = await Promise.all([fetchLeague(creds), fetchPlayerIdIndex()]);
  const settings = league.settings;

  console.log(`Scoring every season under "${settings.name}" rules · ${position} · top ${topN} = startable`);
  if (ids.stale) console.log("⚠ player id map came from a stale cache");

  const seasons: PlayerSeason[] = [];
  for (let season = firstSeason; season <= lastSeason; season++) {
    let lines;
    try {
      lines = await fetchSeasonStats(season);
    } catch (err) {
      console.log(`  ${season}: unavailable (${err instanceof Error ? err.message : err})`);
      continue;
    }

    const rows: PlayerSeason[] = [];
    for (const line of lines) {
      if (line.position !== position) continue;
      if (line.games < minGames) continue;

      const identity = ids.byGsisId.get(line.gsisId);
      // No identity means no draft year, and every question here is about
      // experience. Dropping them is honest; defaulting them is not.
      if (!identity) continue;
      const experience = experienceIn(identity, season);
      if (experience === null) continue;

      const scored = scoreStatLine(line, settings, position as never);
      rows.push({
        gsisId: line.gsisId,
        name: line.name,
        season,
        experience,
        draftRound: identity.draftRound ?? null,
        pointsPerGame: scored.pointsPerGame,
        games: line.games,
        startable: false,
      });
    }

    // Startable is a rank within the season, so it is decided per season.
    rows.sort((a, b) => b.pointsPerGame - a.pointsPerGame);
    rows.forEach((r, i) => (r.startable = i < topN));
    seasons.push(...rows);
    console.log(`  ${season}: ${rows.length} qualifying ${position}s`);
  }

  if (!seasons.length) {
    console.error("\n✗ No seasons could be loaded.");
    process.exitCode = 1;
    return;
  }

  // A breakout is the *first* startable season of a career. Counting every
  // startable season would just measure who is good, which nobody needed a
  // study for.
  const firstStartable = new Map<string, number>();
  for (const s of [...seasons].sort((a, b) => a.season - b.season)) {
    if (s.startable && !firstStartable.has(s.gsisId)) firstStartable.set(s.gsisId, s.season);
  }

  // Denominator: everyone who was on the field at that experience level and had
  // not already broken out. This is what stops the result being survivorship.
  const buckets = new Map<number, { eligible: number; broke: number }>();
  const byRound = new Map<string, Map<number, { eligible: number; broke: number }>>();

  for (const s of seasons) {
    const breakoutSeason = firstStartable.get(s.gsisId);
    if (breakoutSeason !== undefined && s.season > breakoutSeason) continue;

    const bucket = buckets.get(s.experience) ?? { eligible: 0, broke: 0 };
    bucket.eligible++;
    if (breakoutSeason === s.season) bucket.broke++;
    buckets.set(s.experience, bucket);

    const capital = roundLabel(s.draftRound);
    const inner = byRound.get(capital) ?? new Map();
    const rb = inner.get(s.experience) ?? { eligible: 0, broke: 0 };
    rb.eligible++;
    if (breakoutSeason === s.season) rb.broke++;
    inner.set(s.experience, rb);
    byRound.set(capital, inner);
  }

  console.log(`\nFirst startable season, by years of NFL experience (${position}, top ${topN}):`);
  console.log(`  yr   broke out / on field    rate`);
  for (const year of [...buckets.keys()].sort((a, b) => a - b)) {
    if (year > 8) continue;
    const b = buckets.get(year)!;
    const rate = b.eligible ? b.broke / b.eligible : 0;
    console.log(
      `  ${String(year).padStart(2)}   ${String(b.broke).padStart(3)} / ${String(b.eligible).padStart(4)}` +
        `           ${(rate * 100).toFixed(1)}%  ${bar(rate)}`,
    );
  }

  console.log(`\nSame question, split by draft capital -- the rival explanation:`);
  for (const capital of ["Round 1", "Round 2-3", "Round 4-7", "Undrafted"]) {
    const inner = byRound.get(capital);
    if (!inner) continue;
    const cells = [0, 1, 2, 3, 4]
      .map((yr) => {
        const b = inner.get(yr);
        if (!b || b.eligible < 8) return "   --";
        return `${((b.broke / b.eligible) * 100).toFixed(0).padStart(4)}%`;
      })
      .join(" ");
    console.log(`  ${capital.padEnd(10)} yr0-4: ${cells}`);
  }

  console.log(
    `\nRead the columns, not the headline: if a rate only looks high in one row of the\n` +
      `first table but is flat across the second, the year was never the cause.`,
  );
}

function roundLabel(round: number | null): string {
  if (round === null) return "Undrafted";
  if (round <= 1) return "Round 1";
  if (round <= 3) return "Round 2-3";
  return "Round 4-7";
}

function bar(rate: number): string {
  return "█".repeat(Math.round(rate * 60));
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
