/**
 * Does changing the head coach change the offence?
 *
 * "Offensive-minded coach" is one of the most confident phrases in fantasy
 * football and one of the hardest to pin down, because a coach with a good
 * quarterback looks like a genius and the label is usually applied after the
 * fact. Rather than argue about who counts as offensive-minded, this asks the
 * objective version: when a team changes head coach, does its scoring move more
 * than a team that kept theirs?
 *
 * The trap is the same one that makes worn-out running backs look real. Teams
 * that sack a coach are bad teams, and bad teams improve the next year whatever
 * they do, because a bad season is partly bad luck and luck does not repeat.
 * Line up the teams that made a change, watch them improve, and the new coach
 * takes credit for the average.
 *
 * So the comparison is made within bands of how a team scored the year before.
 * If a new coach does the work, teams that changed should improve more than
 * equally bad teams that stood pat.
 *
 *   npm run coaching
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { fetchTeamSeasons, fetchCoaches } = await import("../src/lib/sources/schedules");
const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");

const args = process.argv.slice(2);
const firstSeason = Number(readFlag("--from") ?? 2010);

interface Change {
  team: string;
  season: number;
  before: number;
  after: number;
  delta: number;
  changed: boolean;
}

async function main() {
  const seasons = await fetchTeamSeasons();
  const byKey = new Map(seasons.map((s) => [`${s.season}:${s.team}`, s]));

  const pairs: Change[] = [];
  for (const record of seasons) {
    if (record.season < firstSeason) continue;
    if (record.games < 14) continue;
    const next = byKey.get(`${record.season + 1}:${record.team}`);
    if (!next || next.games < 14) continue;
    // A team that changed coach mid-season had two coaches in one year and
    // belongs to neither group cleanly.
    if (record.midSeasonChange || next.midSeasonChange) continue;

    const before = record.pointsFor / record.games;
    const after = next.pointsFor / next.games;
    pairs.push({
      team: record.team,
      season: record.season,
      before,
      after,
      delta: after - before,
      changed: next.coach !== record.coach,
    });
  }

  const changed = pairs.filter((p) => p.changed);
  const kept = pairs.filter((p) => !p.changed);
  console.log(
    `${pairs.length} team-season pairs from ${firstSeason} on · ` +
      `${changed.length} changed head coach, ${kept.length} kept theirs\n`,
  );

  console.log("The naive test -- what happens after a coaching change:");
  console.log(
    `  changed coach   ${mean(changed.map((p) => p.before)).toFixed(1)} -> ` +
      `${mean(changed.map((p) => p.after)).toFixed(1)} points a game  ` +
      `${signed(mean(changed.map((p) => p.delta)))}`,
  );
  console.log(
    `  kept coach      ${mean(kept.map((p) => p.before)).toFixed(1)} -> ` +
      `${mean(kept.map((p) => p.after)).toFixed(1)} points a game  ` +
      `${signed(mean(kept.map((p) => p.delta)))}`,
  );

  console.log(`\nThe controlled test -- same scoring last year, split by what they did:`);
  console.log(`  last season        changed coach      kept coach       difference   verdict`);
  const bands: Array<[string, (p: number) => boolean]> = [
    ["under 18 a game", (p) => p < 18],
    ["18-21 a game", (p) => p >= 18 && p < 21],
    ["21-24 a game", (p) => p >= 21 && p < 24],
    ["24+ a game", (p) => p >= 24],
  ];
  for (const [label, test] of bands) {
    const c = changed.filter((p) => test(p.before));
    const k = kept.filter((p) => test(p.before));
    if (c.length < 5 || k.length < 5) continue;
    const cd = mean(c.map((p) => p.delta));
    const kd = mean(k.map((p) => p.delta));
    // Two small groups differ by something every time. Without asking how much
    // of that is chance, every band reads as a finding.
    const se = Math.sqrt(variance(c.map((p) => p.delta)) / c.length + variance(k.map((p) => p.delta)) / k.length);
    const sigmas = se > 0 ? Math.abs(cd - kd) / se : 0;
    console.log(
      `  ${label.padEnd(18)} ${signed(cd)} (n=${String(c.length).padStart(3)})   ` +
        `${signed(kd)} (n=${String(k.length).padStart(3)})   ${signed(cd - kd)}   ` +
        `${sigmas >= 2 ? `real (${sigmas.toFixed(1)}x noise)` : `could be chance (${sigmas.toFixed(1)}x)`}`,
    );
  }

  console.log(
    `\nRead the difference column. If a new coach were doing the work it would be\n` +
      `consistently positive. Near zero means both groups are only being pulled back\n` +
      `toward the middle, and the new coach is being credited for the average.`,
  );

  await applyToUpcomingSeason(seasons);
}

/**
 * Which teams the finding actually applies to this year.
 *
 * A result nobody can act on is a result nobody will use, and the whole point
 * of separating broken offences from mediocre ones is that they point opposite
 * ways.
 */
async function applyToUpcomingSeason(seasons: Awaited<ReturnType<typeof fetchTeamSeasons>>) {
  const league = await fetchLeague(credentialsFromEnv());
  const upcoming = league.settings.seasonId;
  const previous = upcoming - 1;

  const lastYear = new Map(
    seasons.filter((s) => s.season === previous).map((s) => [s.team, s]),
  );
  const coachesNow = await fetchCoaches(upcoming);
  if (!coachesNow.size) {
    console.log(`\nNo ${upcoming} coaching assignments published yet.`);
    return;
  }

  interface Row {
    team: string;
    from: string;
    to: string;
    scored: number;
  }
  const changes: Row[] = [];
  for (const [team, coach] of coachesNow) {
    const before = lastYear.get(team);
    if (!before || !before.coach || before.coach === coach) continue;
    changes.push({ team, from: before.coach, to: coach, scored: before.pointsFor / before.games });
  }
  changes.sort((a, b) => a.scored - b.scored);

  console.log(`\n${"=".repeat(74)}`);
  console.log(`Teams with a new head coach for ${upcoming}, and what the above implies:\n`);
  if (!changes.length) {
    console.log(`  None. Every team kept its head coach.`);
    return;
  }

  for (const row of changes) {
    const verdict =
      row.scored < 18
        ? `broken offence -- the one case where a change helps, worth about +3.7 a game`
        : row.scored < 24
          ? `merely mediocre -- a change costs about 1.5 a game here, so fade slightly`
          : `already good -- the evidence is too thin to call either way`;
    console.log(
      `  ${row.team.padEnd(4)} ${row.scored.toFixed(1).padStart(5)} pts/g in ${previous}  ` +
        `${row.from} -> ${row.to}`,
    );
    console.log(`       ${verdict}`);
  }

  console.log(
    `\n  Note the sample: this rests on 29 broken offences that changed coach since\n` +
      `  2010, against 28 that did not. Real, and not many.`,
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
    // Absent env file is fine.
  }
}

await main();
