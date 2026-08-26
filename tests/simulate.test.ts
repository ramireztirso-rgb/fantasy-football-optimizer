import { describe, expect, it } from "vitest";
import { simulateMatchup, simulatePlayoffOdds, teamStrengths } from "@/lib/engine/simulate";
import { buildScoutingReport } from "@/lib/engine/scout";
import { buildDemoLeague } from "@/lib/demo/league";
import type { Projection } from "@/lib/engine/projections";
import type { Player, Position } from "@/lib/domain/types";

function proj(points: number, volatility: number, proTeam = "KC", position: Position = "WR"): Projection {
  const player: Player = {
    id: Math.round(points * 1000 + volatility * 7),
    name: `${position} ${points}`,
    position,
    proTeam,
    eligibleSlots: [position],
    byeWeek: 99,
    percentOwned: 50,
    percentOwnedDelta: 0,
    percentStarted: 50,
    projectedPoints: points,
    seasonProjectedPoints: points * 17,
    gameLog: [],
    seasonPoints: 0,
    averageDraftPosition: Number.POSITIVE_INFINITY,
    draftRank: Number.POSITIVE_INFINITY,
  };
  return {
    player,
    points,
    floor: Math.max(0, points - volatility),
    ceiling: points + volatility,
    volatility,
    reasons: [],
  };
}

const balanced = () => [
  proj(18, 7, "KC", "QB"),
  proj(14, 6, "BUF", "RB"),
  proj(12, 6, "SF", "WR"),
  proj(9, 5, "DAL", "TE"),
];

describe("simulateMatchup", () => {
  it("is deterministic for a given seed", () => {
    const a = simulateMatchup(balanced(), balanced(), 2000, 42);
    const b = simulateMatchup(balanced(), balanced(), 2000, 42);
    expect(a).toEqual(b);
  });

  it("gives identical lineups a near coin-flip", () => {
    const result = simulateMatchup(balanced(), balanced(), 20_000, 5);
    expect(result.winProbability).toBeGreaterThan(0.45);
    expect(result.winProbability).toBeLessThan(0.55);
  });

  it("favors the stronger lineup", () => {
    const strong = balanced().map((p) => proj(p.points + 5, p.volatility, p.player.proTeam, p.player.position));
    const result = simulateMatchup(strong, balanced(), 10_000, 9);
    expect(result.winProbability).toBeGreaterThan(0.6);
    expect(result.medianMargin).toBeGreaterThan(0);
  });

  it("does not treat a favorite as a certainty", () => {
    // A four-point edge is a real edge and nothing more; reporting it as ~100%
    // is the exact error the simulation exists to prevent.
    const favored = balanced().map((p) => proj(p.points + 1, p.volatility, p.player.proTeam, p.player.position));
    const result = simulateMatchup(favored, balanced(), 20_000, 11);
    expect(result.winProbability).toBeGreaterThan(0.5);
    expect(result.winProbability).toBeLessThan(0.75);
  });

  it("keeps outcomes non-negative and orders the percentiles", () => {
    const result = simulateMatchup(balanced(), balanced(), 5000, 3);
    expect(result.floor).toBeGreaterThanOrEqual(0);
    expect(result.floor).toBeLessThan(result.meanFor);
    expect(result.ceiling).toBeGreaterThan(result.meanFor);
  });

  it("ignores players projected at zero", () => {
    const withZero = [...balanced(), proj(0, 0, "LAR", "WR")];
    const a = simulateMatchup(withZero, balanced(), 4000, 21);
    const b = simulateMatchup(balanced(), balanced(), 4000, 21);
    expect(a.meanFor).toBeCloseTo(b.meanFor, 0);
  });

  it("makes a stacked lineup more volatile than a diversified one", () => {
    // Same projected total, same per-player volatility -- the only difference is
    // that the stack shares one NFL team, so the outcomes move together.
    const stacked = [
      proj(18, 7, "KC", "QB"),
      proj(14, 6, "KC", "WR"),
      proj(12, 6, "KC", "WR"),
      proj(9, 5, "KC", "TE"),
    ];
    const spread = [
      proj(18, 7, "KC", "QB"),
      proj(14, 6, "BUF", "WR"),
      proj(12, 6, "SF", "WR"),
      proj(9, 5, "DAL", "TE"),
    ];
    const stackedSim = simulateMatchup(stacked, balanced(), 20_000, 77);
    const spreadSim = simulateMatchup(spread, balanced(), 20_000, 77);

    const stackedRange = stackedSim.ceiling - stackedSim.floor;
    const spreadRange = spreadSim.ceiling - spreadSim.floor;
    expect(stackedRange).toBeGreaterThan(spreadRange);
  });
});

describe("season simulation", () => {
  const { league } = buildDemoLeague({ week: 6 });
  const strengths = teamStrengths(league.teams, league.settings, 6);

  it("gives every team a positive expected weekly score", () => {
    expect(strengths).toHaveLength(league.teams.length);
    for (const s of strengths) {
      expect(s.mean).toBeGreaterThan(0);
      expect(s.sd).toBeGreaterThan(0);
    }
  });

  it("produces playoff odds that sum to the size of the field", () => {
    const schedule = [];
    for (let week = 7; week <= 14; week++) {
      for (let i = 0; i < league.teams.length; i += 2) {
        schedule.push({ week, homeId: league.teams[i].id, awayId: league.teams[i + 1].id });
      }
    }
    const odds = simulatePlayoffOdds(
      league.teams,
      strengths,
      schedule,
      league.settings.playoffTeamCount,
      1000,
    );
    expect(odds).not.toBeNull();
    const total = odds!.reduce((s, o) => s + o.playoffProbability, 0);
    expect(total).toBeCloseTo(league.settings.playoffTeamCount, 0);

    const firstSeeds = odds!.reduce((s, o) => s + o.firstSeedProbability, 0);
    expect(firstSeeds).toBeCloseTo(1, 1);
  });

  it("ranks a stronger team above a weaker one", () => {
    const schedule = [];
    for (let week = 7; week <= 14; week++) {
      for (let i = 0; i < league.teams.length; i += 2) {
        schedule.push({ week, homeId: league.teams[i].id, awayId: league.teams[i + 1].id });
      }
    }
    const odds = simulatePlayoffOdds(
      league.teams,
      strengths,
      schedule,
      league.settings.playoffTeamCount,
      1500,
    );
    const best = strengths.reduce((a, b) => (a.mean > b.mean ? a : b));
    const worst = strengths.reduce((a, b) => (a.mean < b.mean ? a : b));
    const bestOdds = odds!.find((o) => o.teamId === best.teamId)!;
    const worstOdds = odds!.find((o) => o.teamId === worst.teamId)!;
    expect(bestOdds.playoffProbability).toBeGreaterThan(worstOdds.playoffProbability);
  });
});

describe("scouting report", () => {
  const { league } = buildDemoLeague({ week: 6 });
  const report = buildScoutingReport(league, 1, 6, 3000);

  it("identifies the opponent and simulates the matchup", () => {
    expect(report.opponent).not.toBeNull();
    expect(report.simulation).not.toBeNull();
    expect(report.simulation!.winProbability).toBeGreaterThan(0);
    expect(report.simulation!.winProbability).toBeLessThan(1);
  });

  it("turns the odds into an instruction rather than a number", () => {
    const codes = report.strategy.map((s) => s.code);
    expect(codes.some((c) => ["favored", "underdog", "coinflip"].includes(c))).toBe(true);
    expect(report.strategy.every((s) => s.detail.length > 20)).toBe(true);
  });

  it("reports positional edges that net out against the opponent", () => {
    expect(report.edges.length).toBeGreaterThan(0);
    for (const edge of report.edges) {
      expect(edge.edge).toBeCloseTo(edge.myPoints - edge.theirPoints, 1);
    }
  });

  it("ranks threats by ceiling", () => {
    const ceilings = report.threats.map((t) => t.projection.ceiling);
    expect([...ceilings].sort((a, b) => b - a)).toEqual(ceilings);
  });

  it("throws for a team that is not in the league", () => {
    expect(() => buildScoutingReport(league, 9999, 6, 100)).toThrow(/not in this league/);
  });
});

describe("playoff odds guard", () => {
  const { league } = buildDemoLeague({ week: 6 });
  const strengths = teamStrengths(league.teams, league.settings, 6);

  // With nothing left to simulate, every run yields identical standings and the
  // "odds" become 100%/0% -- the current table wearing a percent sign.
  it("returns null rather than certainties when no games remain", () => {
    expect(simulatePlayoffOdds(league.teams, strengths, [], 6, 500)).toBeNull();
  });

  it("produces real probabilities once a schedule exists", () => {
    const schedule = [{ week: 7, homeId: league.teams[0].id, awayId: league.teams[1].id }];
    const odds = simulatePlayoffOdds(league.teams, strengths, schedule, 6, 500);
    expect(odds).not.toBeNull();
    expect(odds!.some((o) => o.playoffProbability > 0 && o.playoffProbability < 1)).toBe(true);
  });
});

describe("demo league schedule", () => {
  it("publishes a full season so remaining matchups exist", () => {
    const { league } = buildDemoLeague({ week: 6 });
    const weeks = new Set(league.matchups.map((m) => m.week));
    expect(weeks.size).toBeGreaterThan(10);
    expect(league.matchups.filter((m) => m.week > 6).length).toBeGreaterThan(0);
  });

  it("schedules every team exactly once per week", () => {
    const { league } = buildDemoLeague({ week: 6 });
    for (const week of new Set(league.matchups.map((m) => m.week))) {
      const inWeek = league.matchups.filter((m) => m.week === week);
      const ids = inWeek.flatMap((m) => [m.home.teamId, m.away!.teamId]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(league.teams.length);
    }
  });
});

describe("demo league parity", () => {
  // Allocating position by position in team order gave team one the top five
  // backs and the top five receivers, making every matchup a foregone
  // conclusion and the simulation useless as a demonstration.
  it("gives every team a competitive roster", () => {
    const { league } = buildDemoLeague({ week: 6 });
    const strengths = teamStrengths(league.teams, league.settings, 6);
    const means = strengths.map((s) => s.mean);
    const best = Math.max(...means);
    const worst = Math.min(...means);
    expect(best / worst).toBeLessThan(1.6);
  });

  it("produces matchups that are not foregone conclusions", () => {
    const { league } = buildDemoLeague({ week: 6 });
    const report = buildScoutingReport(league, 1, 6, 4000);
    expect(report.simulation!.winProbability).toBeGreaterThan(0.02);
    expect(report.simulation!.winProbability).toBeLessThan(0.98);
  });
});
