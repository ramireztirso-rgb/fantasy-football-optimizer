/**
 * Is strength of schedule worth knowing, and if so, when?
 *
 * Every preseason ranking comes with a schedule-difficulty column, and it is
 * usually built the same way: take how many points each opponent allowed last
 * season and add them up. That only works if a defence that was good last year
 * is good this year, and nobody checks.
 *
 * So this checks first. If last season's defence does not predict this
 * season's, the whole column is decoration and no amount of arithmetic on top
 * of it will help.
 *
 * Then it looks at the only weeks where schedule genuinely decides something.
 * Over a full season a hard schedule and an easy one mostly wash out, and by
 * week eight the schedule you drafted against has re-ranked itself anyway. Weeks
 * fifteen to seventeen are different: they are the fantasy playoffs, they are
 * known in advance, and a receiver who draws two elite pass defences in them
 * loses you the season rather than a matchup.
 *
 *   npm run schedule
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchTeamSeasons, fetchScheduledGames } = await import("../src/lib/sources/schedules");

const args = process.argv.slice(2);

async function main() {
  const league = await fetchLeague(credentialsFromEnv());
  const upcoming = league.settings.seasonId;
  const previous = upcoming - 1;
  const seasons = await fetchTeamSeasons();

  // --- Does any of this carry from one year to the next? ---
  const byKey = new Map(seasons.map((s) => [`${s.season}:${s.team}`, s]));
  const defencePairs: Array<[number, number]> = [];
  const offencePairs: Array<[number, number]> = [];
  for (const record of seasons) {
    if (record.games < 14) continue;
    const next = byKey.get(`${record.season + 1}:${record.team}`);
    if (!next || next.games < 14) continue;
    defencePairs.push([record.pointsAgainst / record.games, next.pointsAgainst / next.games]);
    offencePairs.push([record.pointsFor / record.games, next.pointsFor / next.games]);
  }

  console.log(`Year-to-year carryover, ${defencePairs.length} team-season pairs\n`);
  const defR = correlation(defencePairs);
  const offR = correlation(offencePairs);
  console.log(`  points allowed (defence):  ${describe(defR)}`);
  console.log(`  points scored (offence):   ${describe(offR)}`);
  console.log(
    `\n  A schedule-strength column is built entirely on the first number. It carries\n` +
      `  ${(defR * defR * 100).toFixed(0)}% of last year's defence into this year, against ` +
      `${(offR * offR * 100).toFixed(0)}% for offence.\n`,
  );

  if (defR < 0.3) {
    console.log(
      `  That is too little to build on. Last season's defensive ranking is close to\n` +
        `  noise as a forecast, so any schedule-strength figure derived from it is\n` +
        `  decoration. Not building the rest.\n`,
    );
    return;
  }

  // --- The weeks that actually decide a season ---
  const games = await fetchScheduledGames(upcoming);
  const playoffWeeks = [15, 16, 17];
  const lastYear = new Map(
    seasons.filter((s) => s.season === previous).map((s) => [s.team, s.pointsAgainst / s.games]),
  );
  const leagueAverage = mean([...lastYear.values()]);

  const faced = new Map<string, number[]>();
  for (const game of games) {
    if (!playoffWeeks.includes(game.week)) continue;
    const homeOpp = lastYear.get(game.away);
    const awayOpp = lastYear.get(game.home);
    if (homeOpp !== undefined) faced.set(game.home, [...(faced.get(game.home) ?? []), homeOpp]);
    if (awayOpp !== undefined) faced.set(game.away, [...(faced.get(game.away) ?? []), awayOpp]);
  }

  const rows = [...faced.entries()]
    .filter(([, opponents]) => opponents.length >= 2)
    .map(([team, opponents]) => ({
      team,
      allowed: mean(opponents),
      games: opponents.length,
    }))
    .sort((a, b) => b.allowed - a.allowed);

  console.log(`Fantasy playoff weeks (${playoffWeeks.join(", ")}) in ${upcoming}:`);
  console.log(`Opponents' points allowed per game last season -- higher is an easier draw.\n`);
  console.log(`  Easiest draws:`);
  for (const r of rows.slice(0, 6)) {
    console.log(
      `    ${r.team.padEnd(4)} opponents allowed ${r.allowed.toFixed(1)} a game ` +
        `(${(r.allowed - leagueAverage >= 0 ? "+" : "") + (r.allowed - leagueAverage).toFixed(1)} vs average)`,
    );
  }
  console.log(`\n  Hardest draws:`);
  for (const r of rows.slice(-6).reverse()) {
    console.log(
      `    ${r.team.padEnd(4)} opponents allowed ${r.allowed.toFixed(1)} a game ` +
        `(${(r.allowed - leagueAverage >= 0 ? "+" : "") + (r.allowed - leagueAverage).toFixed(1)} vs average)`,
    );
  }

  const spread = rows[0].allowed - rows[rows.length - 1].allowed;
  console.log(
    `\n  Spread between the best and worst draw: ${spread.toFixed(1)} points a game of\n` +
      `  opponent defence, shrunk by the ${(defR * defR * 100).toFixed(0)}% that actually carries over --\n` +
      `  so expect nearer ${(spread * defR * defR).toFixed(1)} points a game of real effect, across three weeks.`,
  );
  console.log(
    `\n  And that is still generous. Backtested directly -- did players who drew an\n` +
      `  easy week 15-17 actually beat their own weeks 1-14 form? -- the answer is\n` +
      `  0.46 points a game at 1.3 times the sampling noise, which is nothing. See\n` +
      `  \`npm run folkisms\`. This table is worth reading and not worth drafting on.`,
  );
}

function correlation(pairs: Array<[number, number]>): number {
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
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

function describe(r: number): string {
  const strength =
    Math.abs(r) < 0.2 ? "barely any" : Math.abs(r) < 0.4 ? "weak" : Math.abs(r) < 0.6 ? "moderate" : "strong";
  return `${r.toFixed(2)} (${strength})`;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
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
void args;

await main();
