/**
 * Received wisdom, tested.
 *
 * Every claim here is one people repeat with confidence. Each gets three
 * separate questions rather than one: is there an effect, is it bigger than
 * chance, and is it big enough to change a decision. Collapsing those into a
 * yes or a no is how a folk belief survives being tested -- somebody finds a
 * real but tiny edge, writes "confirmed", and the belief keeps its reputation
 * for mattering.
 *
 *   npm run folkisms
 *   npm run folkisms -- --from 2018
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchWeeklyStats } = await import("../src/lib/sources/nflverse");
const { fetchGameContext, impliedTotalFor } = await import("../src/lib/sources/schedules");
const { fetchPlayerIdIndex } = await import("../src/lib/sources/playerIds");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");
const { judge, renderScorecard, mean, stdev, percentile } = await import(
  "../src/lib/analysis/scorecard"
);

type WeeklyStatLine = Awaited<ReturnType<typeof fetchWeeklyStats>>[number];
type GameContext = Awaited<ReturnType<typeof fetchGameContext>> extends Map<string, infer T>
  ? T
  : never;
type Finding = ReturnType<typeof judge>;

const args = process.argv.slice(2);
const firstSeason = Number(readFlag("--from") ?? 2016);
const lastSeason = Number(readFlag("--to") ?? 2025);

interface Game extends WeeklyStatLine {
  points: number;
  touches: number;
  context: GameContext | undefined;
}

async function main() {
  const settings = (await fetchLeague(credentialsFromEnv())).settings;
  const ids = await fetchPlayerIdIndex();

  const games: Game[] = [];
  for (let season = firstSeason; season <= lastSeason; season++) {
    let weekly: WeeklyStatLine[];
    try {
      weekly = await fetchWeeklyStats(season);
    } catch {
      continue;
    }
    const contexts = await fetchGameContext(season).catch(() => new Map<string, GameContext>());
    for (const line of weekly) {
      if (!["QB", "RB", "WR", "TE"].includes(line.position)) continue;
      games.push({
        ...line,
        points: scoreStatLine(line, settings, line.position as never).points,
        touches: line.carries + line.receptions,
        context: contexts.get(`${line.week}:${line.team}`),
      });
    }
  }

  console.log(`Scored ${games.length} player-games, ${firstSeason}-${lastSeason}, under "${settings.name}" rules.\n`);

  // Group games into player-seasons, which is the unit most of these need: a
  // question about consistency is a question about one player's spread of
  // weeks, and pooling every player's weeks together answers a different one.
  const bySeason = new Map<string, Game[]>();
  for (const g of games) {
    const key = `${g.season}:${g.gsisId}`;
    bySeason.set(key, [...(bySeason.get(key) ?? []), g]);
  }
  const playerSeasons = [...bySeason.values()].filter((weeks) => weeks.length >= 8);

  const findings: Finding[] = [];
  findings.push(workhorseFloor(playerSeasons));
  findings.push(committeeVariance(playerSeasons));
  findings.push(targetShareConsistency(playerSeasons));
  findings.push(rookieWrSlowStart(playerSeasons, ids));
  findings.push(impliedTotalMatters(games, "RB"));
  findings.push(impliedTotalMatters(games, "WR"));
  findings.push(thursdayNightNoise(games));

  console.log(renderScorecard(findings));
}

/** "A twenty-touch back has a floor." Compared as each back's own bad weeks. */
function workhorseFloor(playerSeasons: Game[][]): Finding {
  const heavy: number[] = [];
  const light: number[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "RB") continue;
    const touches = mean(weeks.map((w) => w.touches));
    // The floor is the tenth-percentile week, which is what "floor" means to
    // anyone using the word: not the average, the bad ones.
    const floor = percentile(weeks.map((w) => w.points), 0.1);
    if (touches >= 20) heavy.push(floor);
    else if (touches < 15) light.push(floor);
  }
  return judge(
    "20+ touch backs have a real floor",
    { label: "sub-15-touch backs", values: light },
    { label: "20+ touch backs", values: heavy },
    "pts in a bad week",
    { expect: "increase", practicalThreshold: 2 },
  );
}

/** "Committee backfields are a trap" -- tested as week-to-week swing. */
function committeeVariance(playerSeasons: Game[][]): Finding {
  const workhorse: number[] = [];
  const committee: number[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "RB") continue;
    const carries = mean(weeks.map((w) => w.carries));
    const points = weeks.map((w) => w.points);
    const average = mean(points);
    if (average < 4) continue;
    // Relative to output. A workhorse scores more and therefore swings more in
    // raw points no matter what else is true, so comparing raw spread would
    // find that workhorses are less consistent and mean nothing by it.
    const swing = stdev(points) / average;
    if (carries >= 15) workhorse.push(swing);
    else if (carries > 5 && carries < 10) committee.push(swing);
  }
  return judge(
    "Committee backs swing more week to week",
    { label: "workhorse backs", values: workhorse },
    { label: "committee backs", values: committee },
    "swing per point scored",
    { expect: "increase", practicalThreshold: 0.1 },
  );
}

/** "Target share beats yardage for receiver consistency." */
function targetShareConsistency(playerSeasons: Game[][]): Finding {
  const highVolume: number[] = [];
  const lowVolume: number[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "WR") continue;
    const targets = mean(weeks.map((w) => w.targets));
    const points = weeks.map((w) => w.points);
    const average = mean(points);
    if (average < 5) continue;
    // Swing relative to output, so a high scorer is not penalised for having
    // more to swing with.
    const relativeSwing = stdev(points) / average;
    if (targets >= 8) highVolume.push(relativeSwing);
    else if (targets <= 5) lowVolume.push(relativeSwing);
  }
  return judge(
    "High-target receivers are steadier",
    { label: "low-target receivers", values: lowVolume },
    { label: "high-target receivers", values: highVolume },
    "swing per point scored",
    { expect: "decrease", practicalThreshold: 0.1 },
  );
}

/** "Rookie receivers start slow and come on late." */
function rookieWrSlowStart(
  playerSeasons: Game[][],
  ids: Awaited<ReturnType<typeof fetchPlayerIdIndex>>,
): Finding {
  const early: number[] = [];
  const late: number[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "WR") continue;
    const identity = ids.byGsisId.get(weeks[0].gsisId);
    if (identity?.draftYear !== weeks[0].season) continue;
    const opening = weeks.filter((w) => w.week <= 4).map((w) => w.points);
    const closing = weeks.filter((w) => w.week >= 10).map((w) => w.points);
    if (opening.length < 2 || closing.length < 3) continue;
    early.push(mean(opening));
    late.push(mean(closing));
  }
  return judge(
    "Rookie receivers finish stronger than they start",
    { label: "their weeks 1-4", values: early },
    { label: "their weeks 10+", values: late },
    "pts a game",
    { expect: "increase", practicalThreshold: 1.5, minGroupSize: 15 },
  );
}

/** "Play the players on teams Vegas expects to score." */
function impliedTotalMatters(games: Game[], position: string): Finding {
  const high: number[] = [];
  const low: number[] = [];
  for (const g of games) {
    if (g.position !== position || !g.context) continue;
    const implied = impliedTotalFor(g.team, g.context);
    if (implied === null) continue;
    // Only players with a real role: a bench player scores nothing whatever the
    // game total, and including them measures playing time instead.
    if (g.touches < 5 && g.targets < 5) continue;
    if (implied >= 26) high.push(g.points);
    else if (implied <= 19) low.push(g.points);
  }
  return judge(
    `${position}s score more when Vegas expects points`,
    { label: "low-total games", values: low },
    { label: "high-total games", values: high },
    "pts",
    { expect: "increase", practicalThreshold: 1.5 },
  );
}

/**
 * "Thursday games are weird, do not read anything into them."
 *
 * Tested as output rather than predictiveness, which is the weaker half of the
 * claim but the half this data answers cleanly.
 */
function thursdayNightNoise(games: Game[]): Finding {
  const thursday: number[] = [];
  const sunday: number[] = [];
  for (const g of games) {
    if (!g.context || g.touches + g.targets < 5) continue;
    if (g.context.weekday === "Thursday") thursday.push(g.points);
    else if (g.context.weekday === "Sunday") sunday.push(g.points);
  }
  return judge(
    "Thursday games produce less than Sunday games",
    { label: "Sunday games", values: sunday },
    { label: "Thursday games", values: thursday },
    "pts",
    { expect: "decrease", practicalThreshold: 1 },
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
