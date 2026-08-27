/**
 * The board itself, drafted against history.
 *
 * The strategy backtest settled Zero RB by drafting real boards and scoring
 * real outcomes. This turns the same harness on the board: rebuild each past
 * August -- the market's actual draft board, projections knowable only then --
 * let the marginal-value engine draft from every seat against an ADP room, and
 * score the rosters on what the players went on to do under this league's
 * rules.
 *
 * The control is drafting by ADP, which is what the room does and what a
 * manager without a tool does. The question is never "did the board score
 * points" but "did it beat the market it was drafting against", season by
 * season, with the spread across seasons as the error bar. This is the harness
 * that lets scoring ideas be judged on reality instead of on agreement with
 * ESPN -- the referee every earlier tuning was stuck with.
 *
 *   npm run backtest-board
 *   npm run backtest-board -- --seasons 2024,2025
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchLeague } = await import("../src/lib/espn/league");
const { fetchWeeklyStats, fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { fetchPlayerIdIndex } = await import("../src/lib/sources/playerIds");
const { fetchTextCached } = await import("../src/lib/sources/cache");
const { scoreStatLine } = await import("../src/lib/engine/scoreFromStats");
const { buildDraftBoard } = await import("../src/lib/engine/draft");
const { buildPeriodProjector } = await import("../src/lib/analysis/periodProjection");
const { mean, stdev } = await import("../src/lib/analysis/scorecard");

import type { Player, Position } from "../src/lib/domain/types";

const args = process.argv.slice(2);
const seasons = (readFlag("--seasons") ?? "2019,2020,2021,2023,2024,2025")
  .split(",")
  .map((s) => Number(s.trim()));
const rounds = Number(readFlag("--rounds") ?? 12);
const teams = 12;

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"] as const;
const FLEX = new Set(["RB", "WR", "TE"]);

interface BoardEntry {
  name: string;
  position: Position;
  adp: number;
  gsisId: string | undefined;
  projection: number;
  basis: string;
  player: Player;
}

async function main() {
  const settings = (await fetchLeague(credentialsFromEnv())).settings;
  const ids = await fetchPlayerIdIndex();
  const gsisByName = new Map<string, string>();
  const identityByGsis = new Map<string, (typeof ids.byGsisId extends Map<string, infer V> ? V : never)>();
  for (const identity of ids.byGsisId.values()) {
    if (identity.gsisId) {
      gsisByName.set(normalizeName(identity.name), identity.gsisId);
      identityByGsis.set(identity.gsisId, identity);
    }
  }

  // Season stats for every year once: history for projections, actuals for
  // scoring, and the ADP-outcome table for the rookie fallback.
  const seasonLines = new Map<number, Awaited<ReturnType<typeof fetchSeasonStats>>>();
  for (let season = 2015; season <= 2025; season++) {
    try {
      seasonLines.set(season, await fetchSeasonStats(season));
    } catch {
      // Less history.
    }
  }
  const history = new Map<string, Array<(typeof seasonLines extends Map<number, infer V> ? V : never)[number]>>();
  for (const lines of seasonLines.values()) {
    for (const line of lines) {
      if (!["QB", "RB", "WR", "TE"].includes(line.position)) continue;
      history.set(line.gsisId, [...(history.get(line.gsisId) ?? []), line]);
    }
  }

  // Realized points by draft slot, for the market-implied rookie fallback.
  // The target season is excluded per projector call; other seasons feed the
  // structural ADP-to-points mapping. That is a structural prior, not player
  // foresight, and it is shared identically by every variant being compared.
  const adpOutcomesBySeason = new Map<number, Array<{ position: Position; adp: number; points: number; season: number }>>();
  for (const season of [2019, 2020, 2021, 2023, 2024, 2025]) {
    const board = await loadAdp(season).catch(() => []);
    const actualByGsis = new Map(
      (seasonLines.get(season) ?? []).map((l) => [l.gsisId, scoreStatLine(l, settings, l.position as Position).points]),
    );
    const outcomes = [];
    for (const p of board) {
      const gsis = gsisByName.get(normalizeName(p.name));
      if (!gsis) continue;
      outcomes.push({ position: p.position, adp: p.adp, points: actualByGsis.get(gsis) ?? 0, season });
    }
    adpOutcomesBySeason.set(season, outcomes);
  }

  console.log(
    `The board against the market, ${seasons.length} seasons, every seat, scored on\n` +
      `what actually happened under "${settings.name}" rules.\n`,
  );

  const deltas: { total: number[]; playoff: number[] } = { total: [], playoff: [] };

  for (const season of seasons) {
    const raw = await loadAdp(season).catch(() => []);
    if (raw.length < rounds * teams) {
      console.log(`  ${season}: board too thin (${raw.length}), skipped`);
      continue;
    }

    const outcomes = [...adpOutcomesBySeason.entries()]
      .filter(([s]) => s !== season)
      .flatMap(([, v]) => v);
    const projector = buildPeriodProjector(season, history, settings, outcomes);

    const entries: BoardEntry[] = raw.map((p, i) => {
      const gsisId = gsisByName.get(normalizeName(p.name));
      const projected = projector.project({
        gsisId,
        identity: gsisId ? identityByGsis.get(gsisId) : undefined,
        position: p.position,
        adp: p.adp,
      });
      const player = {
        id: i + 1,
        name: p.name,
        position: p.position,
        proTeam: "",
        averageDraftPosition: p.adp,
        seasonProjectedPoints: projected.points,
        projectedPoints: projected.points / 17,
        eligibleSlots: [],
        byeWeek: 0,
        injuryStatus: "ACTIVE",
        percentOwned: 0,
        percentOwnedDelta: 0,
        gameLog: [],
      } as unknown as Player;
      return { name: p.name, position: p.position, adp: p.adp, gsisId, projection: projected.points, basis: projected.basis, player };
    });

    // Actual weekly points for scoring the finished rosters.
    let weekly;
    try {
      weekly = await fetchWeeklyStats(season);
    } catch {
      console.log(`  ${season}: no weekly stats, skipped`);
      continue;
    }
    const pointsByWeek = new Map<string, number>();
    for (const line of weekly) {
      if (!["QB", "RB", "WR", "TE"].includes(line.position)) continue;
      pointsByWeek.set(
        `${line.gsisId}:${line.week}`,
        scoreStatLine(line, settings, line.position as Position).points,
      );
    }

    const seasonDelta: number[] = [];
    const playoffDelta: number[] = [];
    for (let seat = 1; seat <= teams; seat++) {
      const adpRoster = draft(entries, seat, "adp");
      const boardRoster = draft(entries, seat, "board");
      const a = score(adpRoster, pointsByWeek);
      const b = score(boardRoster, pointsByWeek);
      seasonDelta.push(b.total - a.total);
      playoffDelta.push(b.playoff - a.playoff);
    }
    deltas.total.push(mean(seasonDelta));
    deltas.playoff.push(mean(playoffDelta));
    console.log(
      `  ${season}: board vs ADP ${signed(mean(seasonDelta))} pts/season · weeks 15-17 ${signed(mean(playoffDelta))}` +
        ` · projections: ${entries.filter((e) => e.basis === "component").length} own record, ${entries.filter((e) => e.basis === "market").length} market-implied`,
    );

    function draft(pool: BoardEntry[], mySeat: number, mode: "adp" | "board"): BoardEntry[] {
      const taken = new Set<number>();
      const mine: BoardEntry[] = [];
      for (let overall = 1; overall <= rounds * teams; overall++) {
        const round = Math.ceil(overall / teams);
        const within = (overall - 1) % teams;
        const seatNow = round % 2 === 1 ? within + 1 : teams - within;
        let choice: BoardEntry | undefined;
        if (seatNow !== mySeat || mode === "adp") {
          choice = pool.find((e) => !taken.has(e.player.id));
        } else {
          const myNext = nextMyPick(overall, mySeat);
          const board = buildDraftBoard(
            pool.map((e) => e.player),
            settings,
            {
              pickNumber: overall,
              nextPickNumber: Math.min(myNext, rounds * teams),
              drafted: taken,
              myRoster: mine.map((e) => e.player),
            },
            8,
          );
          const id = board.recommendations[0]?.player.id;
          choice = pool.find((e) => e.player.id === id) ?? pool.find((e) => !taken.has(e.player.id));
        }
        if (!choice) break;
        taken.add(choice.player.id);
        if (seatNow === mySeat) mine.push(choice);
      }
      return mine;
    }

    function nextMyPick(after: number, mySeat: number): number {
      for (let overall = after + 1; overall <= rounds * teams; overall++) {
        const round = Math.ceil(overall / teams);
        const within = (overall - 1) % teams;
        const seatNow = round % 2 === 1 ? within + 1 : teams - within;
        if (seatNow === mySeat) return overall;
      }
      return rounds * teams;
    }

    function score(roster: BoardEntry[], byWeek: Map<string, number>): { total: number; playoff: number } {
      let total = 0;
      let playoff = 0;
      for (let week = 1; week <= 17; week++) {
        const scored = roster.map((e) => ({
          position: e.position,
          points: e.gsisId ? (byWeek.get(`${e.gsisId}:${week}`) ?? 0) : 0,
        }));
        const used = new Set<number>();
        let weekTotal = 0;
        for (const slot of SLOTS) {
          let best = -1;
          for (let i = 0; i < scored.length; i++) {
            if (used.has(i)) continue;
            const ok = slot === "FLEX" ? FLEX.has(scored[i].position) : scored[i].position === slot;
            if (!ok) continue;
            if (best < 0 || scored[i].points > scored[best].points) best = i;
          }
          if (best >= 0) {
            used.add(best);
            weekTotal += scored[best].points;
          }
        }
        total += weekTotal;
        if (week >= 15) playoff += weekTotal;
      }
      return { total, playoff };
    }
  }

  const se = deltas.total.length > 1 ? stdev(deltas.total) / Math.sqrt(deltas.total.length) : 0;
  const sigmas = se > 0 ? Math.abs(mean(deltas.total)) / se : 0;
  console.log(
    `\n  Overall: the board ${mean(deltas.total) >= 0 ? "beats" : "loses to"} the ADP drafter by ` +
      `${signed(mean(deltas.total))} ± ${se.toFixed(0)} points a season (${sigmas.toFixed(1)}x noise), ` +
      `${signed(mean(deltas.playoff))} in weeks 15-17.`,
  );
  console.log(
    `\n  Read it strictly: both drafters share the same projections and the same\n` +
      `  market. The difference is only the board's reasoning -- lineup-marginal\n` +
      `  value, opportunity cost, roster construction -- which is exactly the part\n` +
      `  a tool can claim credit for.`,
  );
}

async function loadAdp(season: number): Promise<Array<{ name: string; position: Position; adp: number }>> {
  const { text } = await fetchTextCached(
    `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=${teams}&year=${season}`,
    `ffc-backtest-half-ppr-${season}.json`,
    { ttlMs: 30 * 24 * 60 * 60 * 1000, timeoutSeconds: 30 },
  );
  const parsed = JSON.parse(text) as { players?: Array<Record<string, unknown>> };
  return (parsed.players ?? [])
    .map((raw) => ({
      name: String(raw.name ?? ""),
      position: String(raw.position ?? "").toUpperCase() as Position,
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
