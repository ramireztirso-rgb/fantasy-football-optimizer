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
const { fetchGameContext, impliedTotalFor, spreadFor, fetchTeamSeasons } = await import(
  "../src/lib/sources/schedules"
);
const { fetchPlayerIdIndex, ageAtSeason } = await import("../src/lib/sources/playerIds");
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
      if (!["QB", "RB", "WR", "TE", "K"].includes(line.position)) continue;
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
  findings.push(ageCliffEfficiency(playerSeasons, ids));
  findings.push(ageCliffWorkload(playerSeasons, ids));
  findings.push(underdogEffect(games, "WR"));
  findings.push(underdogEffect(games, "RB"));
  findings.push(windKillsPassing(games));
  findings.push(domeBoost(games));
  findings.push(...touchdownRegression(playerSeasons));
  findings.push(revengeGame(games));
  findings.push(shortRestFatigue(games));
  findings.push(await playoffScheduleTargeting(games));
  findings.push(kickersAreUnpredictable(playerSeasons));
  findings.push(toughCoverageSuppresses(games));

  console.log(renderScorecard(findings));
}

/** "A twenty-touch back has a floor." Compared as each back's own bad weeks. */
function workhorseFloor(playerSeasons: Game[][]): Finding {
  const heavy: number[] = [];
  const heavyNames: string[] = [];
  const light: number[] = [];
  const lightNames: string[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "RB") continue;
    const who = `${weeks[0].name} ${weeks[0].season}`;
    const touches = mean(weeks.map((w) => w.touches));
    // The floor is the tenth-percentile week, which is what "floor" means to
    // anyone using the word: not the average, the bad ones.
    const floor = percentile(weeks.map((w) => w.points), 0.1);
    if (touches >= 20) {
      heavy.push(floor);
      heavyNames.push(who);
    } else if (touches < 15) {
      light.push(floor);
      lightNames.push(who);
    }
  }
  return judge(
    "20+ touch backs have a real floor",
    { label: "sub-15-touch backs", values: light, names: lightNames },
    { label: "20+ touch backs", values: heavy, names: heavyNames },
    "pts in a bad week",
    { expect: "increase", practicalThreshold: 2 },
  );
}

/** "Committee backfields are a trap" -- tested as week-to-week swing. */
function committeeVariance(playerSeasons: Game[][]): Finding {
  const workhorse: number[] = [];
  const workhorseNames: string[] = [];
  const committee: number[] = [];
  const committeeNames: string[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "RB") continue;
    const who = `${weeks[0].name} ${weeks[0].season}`;
    const carries = mean(weeks.map((w) => w.carries));
    const points = weeks.map((w) => w.points);
    const average = mean(points);
    if (average < 4) continue;
    // Relative to output. A workhorse scores more and therefore swings more in
    // raw points no matter what else is true, so comparing raw spread would
    // find that workhorses are less consistent and mean nothing by it.
    const swing = stdev(points) / average;
    if (carries >= 15) {
      workhorse.push(swing);
      workhorseNames.push(who);
    } else if (carries > 5 && carries < 10) {
      committee.push(swing);
      committeeNames.push(who);
    }
  }
  return judge(
    "Committee backs swing more week to week",
    { label: "workhorse backs", values: workhorse, names: workhorseNames },
    { label: "committee backs", values: committee, names: committeeNames },
    "swing per point scored",
    { expect: "increase", practicalThreshold: 0.1 },
  );
}

/** "Target share beats yardage for receiver consistency." */
function targetShareConsistency(playerSeasons: Game[][]): Finding {
  const highVolume: number[] = [];
  const highNames: string[] = [];
  const lowVolume: number[] = [];
  const lowNames: string[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "WR") continue;
    const who = `${weeks[0].name} ${weeks[0].season}`;
    const targets = mean(weeks.map((w) => w.targets));
    const points = weeks.map((w) => w.points);
    const average = mean(points);
    if (average < 5) continue;
    // Swing relative to output, so a high scorer is not penalised for having
    // more to swing with.
    const relativeSwing = stdev(points) / average;
    if (targets >= 8) {
      highVolume.push(relativeSwing);
      highNames.push(who);
    } else if (targets <= 5) {
      lowVolume.push(relativeSwing);
      lowNames.push(who);
    }
  }
  return judge(
    "High-target receivers are steadier",
    { label: "low-target receivers", values: lowVolume, names: lowNames },
    { label: "high-target receivers", values: highVolume, names: highNames },
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

/**
 * "Backs fall off a cliff at 27 or 28."
 *
 * Split in two, because the claim never says which thing is supposed to
 * collapse. This half asks whether an older back is worse *with the ball* --
 * points per touch, which is efficiency and nothing to do with how often his
 * coach uses him.
 */
function ageCliffEfficiency(
  playerSeasons: Game[][],
  ids: Awaited<ReturnType<typeof fetchPlayerIdIndex>>,
): Finding {
  const young: number[] = [];
  const old: number[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "RB") continue;
    const identity = ids.byGsisId.get(weeks[0].gsisId);
    if (!identity) continue;
    const age = ageAtSeason(identity, weeks[0].season);
    if (age === null) continue;
    const touches = weeks.reduce((n, w) => n + w.touches, 0);
    if (touches < 80) continue;
    const perTouch = weeks.reduce((n, w) => n + w.points, 0) / touches;
    if (age <= 25) young.push(perTouch);
    else if (age >= 28) old.push(perTouch);
  }
  return judge(
    "Backs 28+ do less with each touch",
    { label: "backs 25 and under", values: young },
    { label: "backs 28 and over", values: old },
    "pts per touch",
    { expect: "decrease", practicalThreshold: 0.05 },
  );
}

/** The other half: are they given the ball less? */
function ageCliffWorkload(
  playerSeasons: Game[][],
  ids: Awaited<ReturnType<typeof fetchPlayerIdIndex>>,
): Finding {
  const young: number[] = [];
  const old: number[] = [];
  for (const weeks of playerSeasons) {
    if (weeks[0].position !== "RB") continue;
    const identity = ids.byGsisId.get(weeks[0].gsisId);
    if (!identity) continue;
    const age = ageAtSeason(identity, weeks[0].season);
    if (age === null) continue;
    const perGame = mean(weeks.map((w) => w.touches));
    if (age <= 25) young.push(perGame);
    else if (age >= 28) old.push(perGame);
  }
  return judge(
    "Backs 28+ are given the ball less",
    { label: "backs 25 and under", values: young },
    { label: "backs 28 and over", values: old },
    "touches a game",
    { expect: "decrease", practicalThreshold: 1.5 },
  );
}

/**
 * "When a team is a big underdog, fade the back and start the receivers."
 *
 * The one game-script claim with a clear mechanism: a team expected to trail
 * throws to catch up. Run per position because the claim says opposite things
 * about them, and a single team-level answer would average the two away.
 */
function underdogEffect(games: Game[], position: string): Finding {
  const favoured: number[] = [];
  const underdog: number[] = [];
  for (const g of games) {
    if (g.position !== position || !g.context) continue;
    if (g.touches < 5 && g.targets < 5) continue;
    const spread = spreadFor(g.team, g.context);
    if (spread === null) continue;
    if (spread >= 3) favoured.push(g.points);
    else if (spread <= -7) underdog.push(g.points);
  }
  const expectMore = position !== "RB";
  return judge(
    `${position}s ${expectMore ? "gain" : "lose"} when their team is a big underdog`,
    { label: "favoured games", values: favoured },
    { label: "7+ point underdog games", values: underdog },
    "pts",
    { expect: expectMore ? "increase" : "decrease", practicalThreshold: 1 },
  );
}

/** "Wind ruins the passing game." */
function windKillsPassing(games: Game[]): Finding {
  const calm: number[] = [];
  const windy: number[] = [];
  for (const g of games) {
    if (g.position !== "QB" || !g.context || g.context.wind === null) continue;
    if (g.passingYards < 50) continue;
    if (g.context.wind >= 15) windy.push(g.points);
    else if (g.context.wind <= 5) calm.push(g.points);
  }
  return judge(
    "Quarterbacks score less in high wind",
    { label: "calm games", values: calm },
    { label: "15+ mph wind", values: windy },
    "pts",
    { expect: "decrease", practicalThreshold: 1 },
  );
}

/** "Indoors is a passing paradise." */
function domeBoost(games: Game[]): Finding {
  const outdoors: number[] = [];
  const indoors: number[] = [];
  for (const g of games) {
    if (g.position !== "QB" || !g.context) continue;
    if (g.passingYards < 50) continue;
    const roof = g.context.roof.toLowerCase();
    if (roof.includes("dome") || roof.includes("closed")) indoors.push(g.points);
    else if (roof.includes("outdoor")) outdoors.push(g.points);
  }
  return judge(
    "Quarterbacks score more indoors",
    { label: "outdoor games", values: outdoors },
    { label: "indoor games", values: indoors },
    "pts",
    { expect: "increase", practicalThreshold: 1 },
  );
}

/**
 * "Touchdowns regress. Fade whoever scored more than his yardage deserved."
 *
 * This one needs a model rather than a split, because the claim is about a
 * quantity nobody records: how many touchdowns a player *should* have scored.
 * The cheap version is yardage. Touchdowns arrive roughly in proportion to
 * yards gained, at a rate the whole league shares, so a player's yards imply a
 * number of scores and the gap between that and reality is his surplus.
 *
 * That gap being real is not the interesting part. Every distribution has
 * tails. The question is whether the surplus is a *skill* -- whether the
 * players who beat their yardage this year beat it again next year -- and that
 * is answerable directly, by checking whether the surplus persists at all.
 *
 * Two findings come out, because the folk claim bundles two things: that the
 * surplus is luck, and that acting on it is worth something.
 */
function touchdownRegression(playerSeasons: Game[][]): Finding[] {
  interface Season {
    gsisId: string;
    season: number;
    position: string;
    surplus: number;
    pointsPerGame: number;
  }

  // League-wide scoring rates, measured rather than assumed, so the model moves
  // with the era instead of pinning 2016 rules onto 2025.
  let rushYards = 0;
  let rushTds = 0;
  let recYards = 0;
  let recTds = 0;
  for (const weeks of playerSeasons) {
    for (const w of weeks) {
      rushYards += w.rushingYards;
      rushTds += w.rushingTds;
      recYards += w.receivingYards;
      recTds += w.receivingTds;
    }
  }
  const rushRate = rushTds / Math.max(1, rushYards);
  const recRate = recTds / Math.max(1, recYards);

  const seasons: Season[] = [];
  for (const weeks of playerSeasons) {
    const position = weeks[0].position;
    if (!["RB", "WR", "TE"].includes(position)) continue;
    const yardsRush = weeks.reduce((n, w) => n + w.rushingYards, 0);
    const yardsRec = weeks.reduce((n, w) => n + w.receivingYards, 0);
    if (yardsRush + yardsRec < 400) continue;

    const actual = weeks.reduce((n, w) => n + w.rushingTds + w.receivingTds, 0);
    const expected = yardsRush * rushRate + yardsRec * recRate;
    seasons.push({
      gsisId: weeks[0].gsisId,
      season: weeks[0].season,
      position,
      surplus: actual - expected,
      pointsPerGame: mean(weeks.map((w) => w.points)),
    });
  }

  // --- Does the surplus persist? ---
  const byKey = new Map(seasons.map((x) => [`${x.season}:${x.gsisId}`, x]));
  const pairs: Array<[number, number]> = [];
  const luckyNext: number[] = [];
  const normalNext: number[] = [];
  for (const year of seasons) {
    const next = byKey.get(`${year.season + 1}:${year.gsisId}`);
    if (!next) continue;
    pairs.push([year.surplus, next.surplus]);
    // Matched on what they scored, so the comparison is between two players who
    // looked equally good, one of whom got there on touchdowns.
    if (year.pointsPerGame < 8 || year.pointsPerGame > 18) continue;
    const change = next.pointsPerGame - year.pointsPerGame;
    if (year.surplus >= 3) luckyNext.push(change);
    else if (Math.abs(year.surplus) < 1) normalNext.push(change);
  }

  const r = correlation(pairs);
  const persistence: Finding = {
    claim: "Beating your yardage on TDs is a repeatable skill",
    verdict: Math.abs(r) < 0.15 ? "REJECTED" : r > 0 ? "CONFIRMED" : "REJECTED",
    effect: Math.round(r * 100) / 100,
    effectUnit: "correlation",
    sigmas: Math.abs(r) * Math.sqrt(Math.max(1, pairs.length - 2)) / Math.sqrt(Math.max(0.0001, 1 - r * r)),
    sample: pairs.length,
    examples: [],
    detail:
      `A player's touchdown surplus carries ${r.toFixed(2)} into the next season -- ` +
      `${(r * r * 100).toFixed(0)}% of it. ${
        Math.abs(r) < 0.15
          ? "Which is to say it is luck, and the players who beat their yardage this year are not the ones who beat it next year."
          : "Some of it is a real property of the player."
      }`,
  };

  const consequence = judge(
    "Fading last year's TD surplus is worth doing",
    { label: "players whose TDs matched their yards", values: normalNext },
    { label: "players with 3+ TDs of surplus", values: luckyNext },
    "pts a game next season",
    { expect: "decrease", practicalThreshold: 1 },
  );

  return [persistence, consequence];
}

/**
 * "Never spend an early pick on a kicker -- you cannot predict them."
 *
 * The advice is right and almost nobody states the actual reason, which is not
 * that kickers score few points. It is that this year's good kicker is not next
 * year's. Tested as how much a position's scoring rate carries from one season
 * to the next: a position you can forecast is one worth paying for early, and a
 * position that resets every year is one to take last whatever it scores.
 *
 * This league makes the test sharper than most, because it pays kickers by
 * distance -- a tenth of a point per field-goal yard -- rather than a flat three
 * per kick. If leg strength were a durable skill it would show up here.
 */
function kickersAreUnpredictable(playerSeasons: Game[][]): Finding {
  const rateByPosition = new Map<string, Map<string, number>>();
  for (const weeks of playerSeasons) {
    const position = weeks[0].position;
    const rate = mean(weeks.map((w) => w.points));
    if (rate <= 0) continue;
    const forPosition = rateByPosition.get(position) ?? new Map<string, number>();
    forPosition.set(`${weeks[0].season}:${weeks[0].gsisId}`, rate);
    rateByPosition.set(position, forPosition);
  }

  const carryover = (position: string): { r: number; pairs: number } => {
    const rates = rateByPosition.get(position);
    if (!rates) return { r: 0, pairs: 0 };
    const pairs: Array<[number, number]> = [];
    for (const [key, rate] of rates) {
      const [season, id] = key.split(":");
      const next = rates.get(`${Number(season) + 1}:${id}`);
      if (next !== undefined) pairs.push([rate, next]);
    }
    return { r: correlation(pairs), pairs: pairs.length };
  };

  const kicker = carryover("K");
  // Compared against receivers, the most predictable position there is, so the
  // gap is the strongest version of the contrast rather than a flattering one.
  const receiver = carryover("WR");
  const gap = receiver.r - kicker.r;

  return {
    claim: "Kickers are less predictable than skill players",
    verdict: gap >= 0.2 ? "CONFIRMED" : "REJECTED",
    effect: Math.round(gap * 100) / 100,
    effectUnit: "correlation",
    sigmas: 0,
    sample: kicker.pairs + receiver.pairs,
    examples: [],
    detail:
      `A kicker's scoring rate carries ${kicker.r.toFixed(2)} into the next season -- ` +
      `${(kicker.r * kicker.r * 100).toFixed(0)}% of it -- against ${receiver.r.toFixed(2)} ` +
      `for receivers, or ${(receiver.r * receiver.r * 100).toFixed(0)}%. This year's good ` +
      `kicker is essentially not next year's, which is the real reason to take one last: ` +
      `not that they score little, but that the good ones cannot be identified in advance. ` +
      `Sharper here than elsewhere, since this league pays kickers by distance, so a durable ` +
      `leg would have shown up and did not.`,
  };
}

/**
 * "Sit your receiver against a shutdown corner."
 *
 * Real coverage grades are not available here, so this uses the stand-in
 * everybody reaches for: how many fantasy points a defence gave up to receivers
 * last season. That substitution is the weakness of the test and has to be said
 * plainly -- a team-level number cannot see which corner travels, and a
 * receiver facing a great defence with one bad corner is invisible to it.
 *
 * Two things make it worth running anyway. It is the version of the claim most
 * people actually act on, since almost nobody has coverage grades either. And
 * it is measured against the receiver's own form that season, so a good
 * receiver on a good team cannot pass for a matchup effect.
 *
 * Priced on the previous season, because that is what a manager setting a
 * lineup in September knows.
 */
function toughCoverageSuppresses(games: Game[]): Finding {
  // What each defence gave up to receivers, per game, per season.
  const conceded = new Map<string, { points: number; games: Set<number> }>();
  for (const g of games) {
    if (g.position !== "WR" || !g.opponent) continue;
    const key = `${g.season}:${g.opponent}`;
    const entry = conceded.get(key) ?? { points: 0, games: new Set<number>() };
    entry.points += g.points;
    entry.games.add(g.week);
    conceded.set(key, entry);
  }
  const allowedPerGame = new Map<string, number>();
  for (const [key, entry] of conceded) {
    if (entry.games.size >= 14) allowedPerGame.set(key, entry.points / entry.games.size);
  }

  // The toughest and softest defences of each season, by what they conceded.
  const rankBySeason = new Map<number, { tough: Set<string>; soft: Set<string> }>();
  const seasons = new Set([...allowedPerGame.keys()].map((k) => Number(k.split(":")[0])));
  for (const season of seasons) {
    const teams = [...allowedPerGame.entries()]
      .filter(([k]) => k.startsWith(`${season}:`))
      .map(([k, v]) => [k.split(":")[1], v] as [string, number])
      .sort((a, b) => a[1] - b[1]);
    if (teams.length < 24) continue;
    rankBySeason.set(season, {
      tough: new Set(teams.slice(0, 6).map(([t]) => t)),
      soft: new Set(teams.slice(-6).map(([t]) => t)),
    });
  }

  const seasonMean = new Map<string, number>();
  const bucket = new Map<string, number[]>();
  for (const g of games) {
    if (g.position !== "WR") continue;
    const key = `${g.season}:${g.gsisId}`;
    bucket.set(key, [...(bucket.get(key) ?? []), g.points]);
  }
  for (const [key, points] of bucket) {
    if (points.length >= 10) seasonMean.set(key, mean(points));
  }

  const versusTough: number[] = [];
  const toughNames: string[] = [];
  const versusSoft: number[] = [];
  const softNames: string[] = [];

  for (const g of games) {
    if (g.position !== "WR" || !g.opponent) continue;
    if (g.targets < 4) continue;
    const average = seasonMean.get(`${g.season}:${g.gsisId}`);
    if (average === undefined || average < 5) continue;
    // The previous season's ranking, which is what was knowable at the time.
    const ranks = rankBySeason.get(g.season - 1);
    if (!ranks) continue;
    const lift = g.points - average;
    const who = `${g.name} ${g.season} wk${g.week}`;
    if (ranks.tough.has(g.opponent)) {
      versusTough.push(lift);
      toughNames.push(who);
    } else if (ranks.soft.has(g.opponent)) {
      versusSoft.push(lift);
      softNames.push(who);
    }
  }

  return judge(
    "Receivers are suppressed by a top pass defence",
    { label: "games against the softest six", values: versusSoft, names: softNames },
    { label: "games against the toughest six", values: versusTough, names: toughNames },
    "pts vs own form",
    { expect: "decrease", practicalThreshold: 1 },
  );
}

/**
 * "Draft the players with an easy run in the fantasy playoffs."
 *
 * This one exists to check a tool rather than a saying. The board already
 * reports which teams face soft defences in weeks fifteen to seventeen, built
 * the way every such column is built: last season's points allowed. Whether
 * that column predicts anything was never tested, only whether the defensive
 * rankings behind it carry from year to year -- and they barely do, at ten
 * percent.
 *
 * So: did players whose teams drew an easy playoff run actually beat their own
 * form in those exact weeks? Measured against the player's own weeks one to
 * fourteen, so a good player on a good team cannot pass for a schedule effect.
 */
async function playoffScheduleTargeting(games: Game[]): Promise<Finding> {
  const seasons = await fetchTeamSeasons().catch(() => []);
  const allowed = new Map<string, number>();
  for (const s of seasons) {
    if (s.games >= 14) allowed.set(`${s.season}:${s.team}`, s.pointsAgainst / s.games);
  }

  // A team's playoff-week draw, priced the way the column prices it: on the
  // season *before* the one being played, since that is all a drafter knows.
  const draw = new Map<string, number[]>();
  for (const g of games) {
    if (!g.context || ![15, 16, 17].includes(g.week)) continue;
    const opponent = g.team === g.context.home ? g.context.away : g.context.home;
    const opponentAllowed = allowed.get(`${g.season - 1}:${opponent}`);
    if (opponentAllowed === undefined) continue;
    const key = `${g.season}:${g.team}`;
    draw.set(key, [...(draw.get(key) ?? []), opponentAllowed]);
  }

  const easy: number[] = [];
  const easyNames: string[] = [];
  const hard: number[] = [];
  const hardNames: string[] = [];

  const bySeason = new Map<string, Game[]>();
  for (const g of games) {
    const key = `${g.season}:${g.gsisId}`;
    bySeason.set(key, [...(bySeason.get(key) ?? []), g]);
  }

  for (const weeks of bySeason.values()) {
    const before = weeks.filter((w) => w.week <= 14).map((w) => w.points);
    const playoff = weeks.filter((w) => [15, 16, 17].includes(w.week)).map((w) => w.points);
    if (before.length < 8 || playoff.length < 2) continue;
    if (mean(before) < 5) continue;

    const opponents = draw.get(`${weeks[0].season}:${weeks[0].team}`);
    if (!opponents || opponents.length < 2) continue;
    const softness = mean(opponents);
    // The player against himself: did the easy run lift him above his own form?
    const lift = mean(playoff) - mean(before);
    const who = `${weeks[0].name} ${weeks[0].season}`;

    if (softness >= 24) {
      easy.push(lift);
      easyNames.push(who);
    } else if (softness <= 21) {
      hard.push(lift);
      hardNames.push(who);
    }
  }

  return judge(
    "An easy playoff schedule lifts a player above his own form",
    { label: "players with a hard week 15-17 draw", values: hard, names: hardNames },
    { label: "players with an easy week 15-17 draw", values: easy, names: easyNames },
    "pts vs own form",
    { expect: "increase", practicalThreshold: 1 },
  );
}

/**
 * "He always plays out of his mind against his old team."
 *
 * A good test of the machinery as much as the claim, because it is the sort of
 * thing that gets asserted every week on the strength of the games where it
 * happened. Nobody brings up the eleven quiet ones.
 *
 * Measured against the player's own average that season, so the comparison is
 * a player against himself rather than against other players. A revenge game
 * is a real fixture whatever else is true, and if the effect exists it should
 * show as him beating his own baseline in those weeks specifically.
 */
function revengeGame(games: Game[]): Finding {
  // Which teams each player had already played for before a given season.
  const teamsBefore = new Map<string, Map<number, Set<string>>>();
  const sorted = [...games].sort((a, b) => a.season - b.season || a.week - b.week);
  const seen = new Map<string, Set<string>>();
  for (const g of sorted) {
    const bySeason = teamsBefore.get(g.gsisId) ?? new Map<number, Set<string>>();
    if (!bySeason.has(g.season)) {
      bySeason.set(g.season, new Set(seen.get(g.gsisId) ?? []));
      teamsBefore.set(g.gsisId, bySeason);
    }
    const played = seen.get(g.gsisId) ?? new Set<string>();
    played.add(g.team);
    seen.set(g.gsisId, played);
  }

  // Season averages, so each game can be judged against the player's own form.
  const seasonMean = new Map<string, number>();
  const bucket = new Map<string, number[]>();
  for (const g of games) {
    const key = `${g.season}:${g.gsisId}`;
    bucket.set(key, [...(bucket.get(key) ?? []), g.points]);
  }
  for (const [key, points] of bucket) {
    if (points.length >= 8) seasonMean.set(key, mean(points));
  }

  const revenge: number[] = [];
  const ordinary: number[] = [];
  for (const g of games) {
    if (g.touches < 3 && g.targets < 3) continue;
    const average = seasonMean.get(`${g.season}:${g.gsisId}`);
    if (average === undefined) continue;
    const priorTeams = teamsBefore.get(g.gsisId)?.get(g.season);
    // Only counts if he had played for them *before* this season, and is not
    // playing for them now.
    const isRevenge =
      priorTeams?.has(g.opponent) === true && g.opponent !== g.team && priorTeams.size > 1;
    const delta = g.points - average;
    if (isRevenge) revenge.push(delta);
    else ordinary.push(delta);
  }

  return judge(
    "Players beat their average against a former team",
    { label: "their other games", values: ordinary },
    { label: "games against a former team", values: revenge },
    "pts vs own average",
    { expect: "increase", practicalThreshold: 1 },
  );
}

/**
 * "A heavy workload plus a short week is a fade."
 *
 * Thursday is the short week -- three days rather than six -- so the test is
 * whether a back who was worked hard last Sunday drops off on the Thursday
 * specifically, against backs equally worked who got the normal rest.
 */
function shortRestFatigue(games: Game[]): Finding {
  const byPlayer = new Map<string, Game[]>();
  for (const g of games) {
    const key = `${g.season}:${g.gsisId}`;
    byPlayer.set(key, [...(byPlayer.get(key) ?? []), g]);
  }

  const shortRest: number[] = [];
  const normalRest: number[] = [];
  for (const weeks of byPlayer.values()) {
    if (weeks[0].position !== "RB") continue;
    const ordered = [...weeks].sort((a, b) => a.week - b.week);
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      // Consecutive weeks only: a bye or a missed game is not a short week.
      if (current.week - previous.week !== 1) continue;
      if (previous.touches < 20) continue;
      if (!current.context) continue;
      if (current.context.weekday === "Thursday") shortRest.push(current.points);
      else if (current.context.weekday === "Sunday") normalRest.push(current.points);
    }
  }

  return judge(
    "Heavily used backs fade on a short week",
    { label: "backs on normal rest", values: normalRest },
    { label: "backs on a Thursday after 20+ touches", values: shortRest },
    "pts",
    { expect: "decrease", practicalThreshold: 1.5 },
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
