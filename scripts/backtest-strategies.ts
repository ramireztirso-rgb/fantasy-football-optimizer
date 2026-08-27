/**
 * Zero RB against Robust RB, drafted for real and scored on what happened.
 *
 * Both strategies are argued from first principles constantly and settled
 * almost never, because settling them needs three things at once: what the
 * board looked like at the time, what the players went on to do, and this
 * league's scoring rather than someone else's.
 *
 * Method. Take a season's real average draft positions -- what the market
 * believed *before* the season, so nothing is chosen with hindsight. Run a
 * twelve-team snake draft in which eleven teams take the best player left on
 * the board. The twelfth follows a strategy. Then score every roster on what
 * the players actually did, week by week, under this league's rules, starting
 * the best legal lineup available each week.
 *
 * Two numbers come out: the whole season, and weeks fifteen to seventeen. The
 * second is the one that matters, because a fantasy season is decided there
 * and a strategy that banks points in September has not necessarily won
 * anything.
 *
 *   npm run backtest
 *   npm run backtest -- --seasons 2019,2020,2021
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchWeeklyStats } = await import("../src/lib/sources/nflverse");
const { fetchPlayerIdIndex } = await import("../src/lib/sources/playerIds");
const { fetchTextCached } = await import("../src/lib/sources/cache");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");
const { mean, stdev } = await import("../src/lib/analysis/scorecard");

const args = process.argv.slice(2);
const seasons = (readFlag("--seasons") ?? "2019,2020,2021,2023,2024,2025")
  .split(",")
  .map((x) => Number(x.trim()));
const rounds = Number(readFlag("--rounds") ?? 12);
const teams = 12;

/** Starters scored. Kickers and defences go too late to be part of this. */
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"] as const;
const FLEX_ELIGIBLE = new Set(["RB", "WR", "TE"]);

interface Pick {
  name: string;
  position: string;
  adp: number;
}

type Strategy = {
  name: string;
  /** Positions this strategy refuses in a given round, if any. */
  forbid(round: number, taken: Record<string, number>): Set<string>;
  /** A position it insists on while one is available. */
  require(round: number, taken: Record<string, number>): string | null;
};

const STRATEGIES: Strategy[] = [
  {
    name: "Best available",
    forbid: () => new Set(),
    require: () => null,
  },
  {
    name: "Zero RB",
    // No back before round five, which is the whole idea: spend the early
    // picks where the market underpays and take backs once they are cheap.
    forbid: (round) => (round < 5 ? new Set(["RB"]) : new Set()),
    require: () => null,
  },
  {
    name: "Robust RB",
    forbid: () => new Set(),
    require: (round, taken) => (round <= 2 && (taken.RB ?? 0) < 2 ? "RB" : null),
  },
  {
    name: "Hero RB",
    // One back early, then none until the middle rounds.
    forbid: (round, taken) => (round >= 2 && round < 5 && (taken.RB ?? 0) >= 1 ? new Set(["RB"]) : new Set()),
    require: (round, taken) => (round === 1 && (taken.RB ?? 0) < 1 ? "RB" : null),
  },
];

async function main() {
  const settings = (await fetchLeague(credentialsFromEnv())).settings;
  const ids = await fetchPlayerIdIndex();

  // Crosswalk from a name to the id the statistics use. FFC publishes no
  // shared id, so this is the same normalisation the live ADP source uses.
  const gsisByName = new Map<string, string>();
  for (const identity of ids.byGsisId.values()) {
    if (identity.gsisId) gsisByName.set(normalizeName(identity.name), identity.gsisId);
  }

  console.log(
    `Backtesting ${STRATEGIES.length} strategies across ${seasons.length} seasons, ` +
      `${rounds}-round ${teams}-team drafts, scored under "${settings.name}" rules.\n`,
  );

  // Kept per season, because a season is the honest unit here. The twelve
  // seats within one share a player pool, so a year where a strategy happened
  // to work counts once rather than twelve times -- treating seats as
  // independent would shrink the error bars by a factor of three and make
  // every difference look decisive.
  const totals = new Map<string, number[]>();
  const playoffs = new Map<string, number[]>();

  for (const season of seasons) {
    const board = await loadAdp(season);
    if (board.length < rounds * teams) {
      console.log(`  ${season}: only ${board.length} players on the board, skipping.`);
      continue;
    }

    const weekly = await fetchWeeklyStats(season);
    const pointsByPlayerWeek = new Map<string, number>();
    for (const line of weekly) {
      if (!["QB", "RB", "WR", "TE"].includes(line.position)) continue;
      const points = scoreStatLine(line, settings, line.position as never).points;
      pointsByPlayerWeek.set(`${line.gsisId}:${line.week}`, points);
    }

    let matched = 0;
    for (const p of board.slice(0, rounds * teams)) {
      if (gsisByName.has(normalizeName(p.name))) matched++;
    }

    const line: string[] = [];
    for (const strategy of STRATEGIES) {
      // Every seat, so the answer is about the strategy rather than about
      // drawing the first pick.
      const seasonTotals: number[] = [];
      const seasonPlayoffs: number[] = [];
      for (let seat = 1; seat <= teams; seat++) {
        const roster = draft(board, strategy, seat);
        const weeks = scoreRoster(roster, gsisByName, pointsByPlayerWeek);
        seasonTotals.push(weeks.reduce((a, b) => a + b, 0));
        seasonPlayoffs.push(weeks.slice(14, 17).reduce((a, b) => a + b, 0));
      }
      totals.set(strategy.name, [...(totals.get(strategy.name) ?? []), mean(seasonTotals)]);
      playoffs.set(strategy.name, [...(playoffs.get(strategy.name) ?? []), mean(seasonPlayoffs)]);
      line.push(`${strategy.name} ${mean(seasonTotals).toFixed(0)}`);
    }
    console.log(
      `  ${season}: ${matched}/${rounds * teams} drafted players matched to stats · ${line.join(" · ")}`,
    );
  }

  const baselineSeasons = totals.get("Best available") ?? [];
  const baselinePlayoffSeasons = playoffs.get("Best available") ?? [];

  console.log(`\n  strategy          season points        weeks 15-17         verdict`);
  for (const strategy of STRATEGIES) {
    const mySeasons = totals.get(strategy.name) ?? [];
    const myPlayoffs = playoffs.get(strategy.name) ?? [];
    // Paired by season: the same year, the same board, one decision changed.
    const deltas = mySeasons.map((v, i) => v - (baselineSeasons[i] ?? 0));
    const playoffDeltas = myPlayoffs.map((v, i) => v - (baselinePlayoffSeasons[i] ?? 0));
    const se = deltas.length > 1 ? stdev(deltas) / Math.sqrt(deltas.length) : 0;
    const sigmas = se > 0 ? Math.abs(mean(deltas)) / se : 0;

    const verdict =
      strategy.name === "Best available"
        ? "the baseline"
        : sigmas >= 2
          ? `real (${sigmas.toFixed(1)}x noise)`
          : `could be chance (${sigmas.toFixed(1)}x)`;

    console.log(
      `  ${strategy.name.padEnd(16)} ${mean(mySeasons).toFixed(0).padStart(5)} ` +
        `${signed(mean(deltas)).padStart(5)} ± ${se.toFixed(0).padStart(2)}   ` +
        `${mean(myPlayoffs).toFixed(0).padStart(5)} ${signed(mean(playoffDeltas)).padStart(4)}   ` +
        `${verdict}`,
    );
  }

  console.log(
    `\n  Error bars are across seasons, not seats. Twelve seats in one year share a\n` +
      `  player pool, so counting them separately would shrink the spread threefold\n` +
      `  and make every difference look decisive.\n` +
      `\n  Differences are against taking the best player available, which is the\n` +
      `  strategy of having no strategy. Every seat in every season is drafted, so a\n` +
      `  result is not an artefact of one slot. Kickers and defences are excluded --\n` +
      `  they go after round twelve and are nobody's strategy.`,
  );
}

/** A draft where everyone but you takes the best player left. */
function draft(board: Pick[], strategy: Strategy, seat: number): Pick[] {
  const taken = new Set<number>();
  const mine: Pick[] = [];
  const myCounts: Record<string, number> = {};

  for (let round = 1; round <= rounds; round++) {
    const order = round % 2 === 1 ? seatOrder() : [...seatOrder()].reverse();
    for (const picking of order) {
      const available = board.filter((_, i) => !taken.has(i));
      if (!available.length) break;

      let choice: number;
      if (picking !== seat) {
        choice = board.findIndex((_, i) => !taken.has(i));
      } else {
        const forbidden = strategy.forbid(round, myCounts);
        const required = strategy.require(round, myCounts);
        // A requirement is a preference, not a straitjacket: if the position
        // has run dry the pick still has to be spent on somebody.
        choice =
          (required !== null
            ? board.findIndex((p, i) => !taken.has(i) && p.position === required)
            : -1) >= 0 && required !== null
            ? board.findIndex((p, i) => !taken.has(i) && p.position === required)
            : board.findIndex((p, i) => !taken.has(i) && !forbidden.has(p.position));
        if (choice < 0) choice = board.findIndex((_, i) => !taken.has(i));
      }

      taken.add(choice);
      if (picking === seat) {
        mine.push(board[choice]);
        myCounts[board[choice].position] = (myCounts[board[choice].position] ?? 0) + 1;
      }
    }
  }
  return mine;
}

function seatOrder(): number[] {
  return Array.from({ length: teams }, (_, i) => i + 1);
}

/** Points this roster would have scored, starting its best legal lineup weekly. */
function scoreRoster(
  roster: Pick[],
  gsisByName: Map<string, string>,
  pointsByPlayerWeek: Map<string, number>,
): number[] {
  const weeks: number[] = [];
  for (let week = 1; week <= 17; week++) {
    const scored = roster.map((p) => {
      const gsis = gsisByName.get(normalizeName(p.name));
      // A player with no line that week did not play, and scores nothing --
      // which is the correct answer, not missing data.
      return { position: p.position, points: gsis ? (pointsByPlayerWeek.get(`${gsis}:${week}`) ?? 0) : 0 };
    });

    let total = 0;
    const used = new Set<number>();
    for (const slot of SLOTS) {
      let best = -1;
      for (let i = 0; i < scored.length; i++) {
        if (used.has(i)) continue;
        const eligible = slot === "FLEX" ? FLEX_ELIGIBLE.has(scored[i].position) : scored[i].position === slot;
        if (!eligible) continue;
        if (best < 0 || scored[i].points > scored[best].points) best = i;
      }
      if (best >= 0) {
        used.add(best);
        total += scored[best].points;
      }
    }
    weeks.push(total);
  }
  return weeks;
}

async function loadAdp(season: number): Promise<Pick[]> {
  const { text } = await fetchTextCached(
    `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=${teams}&year=${season}`,
    `ffc-backtest-half-ppr-${season}.json`,
    { ttlMs: 30 * 24 * 60 * 60 * 1000, timeoutSeconds: 30 },
  );
  const parsed = JSON.parse(text) as { players?: Array<Record<string, unknown>> };
  return (parsed.players ?? [])
    .map((raw) => ({
      name: String(raw.name ?? ""),
      position: String(raw.position ?? "").toUpperCase(),
      adp: Number(raw.adp),
    }))
    .filter((p) => p.name && Number.isFinite(p.adp) && ["QB", "RB", "WR", "TE"].includes(p.position))
    .sort((a, b) => a.adp - b.adp);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z]/g, "");
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(0)}`;
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
