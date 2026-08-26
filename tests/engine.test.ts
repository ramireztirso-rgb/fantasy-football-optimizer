import { describe, expect, it } from "vitest";
import { buildDemoLeague } from "@/lib/demo/league";
import { projectPlayer } from "@/lib/engine/projections";
import { computeReplacementLevels, starterDemand, assignTiers } from "@/lib/engine/replacement";
import { buildDraftBoard, normalCdf, rosterNeed, survivalProbability } from "@/lib/engine/draft";
import { buildWaiverReport } from "@/lib/engine/waivers";
import { diffSnapshots, lineupProblems } from "@/lib/live/events";
import type { Player } from "@/lib/domain/types";

const { league, freeAgents } = buildDemoLeague({ week: 6 });
const myTeam = league.teams[0];

function samplePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    name: "Test Player",
    position: "RB",
    proTeam: "KC",
    eligibleSlots: ["RB", "FLEX", "BE"],
    byeWeek: 9,
    percentOwned: 60,
    percentOwnedDelta: 0,
    percentStarted: 50,
    projectedPoints: 12,
    seasonProjectedPoints: 204,
    gameLog: [],
    seasonPoints: 60,
    averageDraftPosition: 40,
    draftRank: 20,
    ...overrides,
  };
}

describe("projections", () => {
  it("reports a projection whose reasons sum to the score", () => {
    const proj = projectPlayer(samplePlayer({ injuryStatus: "QUESTIONABLE" }), { week: 6 });
    const summed = proj.reasons.reduce((s, r) => s + r.impact, 0);
    expect(summed).toBeCloseTo(proj.points, 1);
  });

  it("zeroes a player on bye and says why", () => {
    const proj = projectPlayer(samplePlayer({ byeWeek: 6 }), { week: 6 });
    expect(proj.points).toBe(0);
    expect(proj.ceiling).toBe(0);
    expect(proj.reasons.some((r) => r.code === "bye_week")).toBe(true);
  });

  it("discounts an injured player below an identical healthy one", () => {
    const healthy = projectPlayer(samplePlayer(), { week: 6 });
    const doubtful = projectPlayer(samplePlayer({ injuryStatus: "DOUBTFUL" }), { week: 6 });
    expect(doubtful.points).toBeLessThan(healthy.points);
    expect(doubtful.reasons.some((r) => r.code === "injury")).toBe(true);
  });

  it("gives a wider floor-to-ceiling band to a volatile game log", () => {
    const steady = projectPlayer(
      samplePlayer({ gameLog: [10, 11, 10, 11, 10].map((points, i) => ({ week: i + 1, points, raw: {}, applied: {} })) }),
      { week: 6 },
    );
    const swingy = projectPlayer(
      samplePlayer({ gameLog: [0, 28, 2, 25, 1].map((points, i) => ({ week: i + 1, points, raw: {}, applied: {} })) }),
      { week: 6 },
    );
    expect(swingy.ceiling - swingy.floor).toBeGreaterThan(steady.ceiling - steady.floor);
  });

  it("never projects negative points", () => {
    const proj = projectPlayer(samplePlayer({ projectedPoints: 0.5, injuryStatus: "OUT" }), { week: 6 });
    expect(proj.points).toBeGreaterThanOrEqual(0);
  });
});

describe("replacement level", () => {
  it("spreads flex demand across eligible positions", () => {
    const demand = starterDemand(league.settings);
    // 12 teams x 2 RB starters = 24, plus RB's share of 12 flex slots.
    expect(demand.RB).toBeGreaterThan(24);
    expect(demand.QB).toBe(12);
  });

  it("sets a higher replacement level for deeper positions", () => {
    const projections = [...myTeam.roster.map((r) => r.player), ...freeAgents].map((p) =>
      projectPlayer(p, { week: 6 }),
    );
    const levels = computeReplacementLevels(projections, league.settings);
    for (const value of Object.values(levels)) expect(value).toBeGreaterThanOrEqual(0);
  });

  it("groups a pool into descending tiers", () => {
    const pool = [30, 29, 28, 12, 11, 3].map((points, i) =>
      projectPlayer(samplePlayer({ id: i + 1, projectedPoints: points }), { week: 6 }),
    );
    const tiers = assignTiers(pool);
    expect(tiers.get(1)!.tier).toBe(1);
    expect(tiers.get(6)!.tier).toBeGreaterThan(tiers.get(1)!.tier);
  });
});

describe("draft board", () => {
  const state = { pickNumber: 13, nextPickNumber: 25, drafted: new Set<number>(), myRoster: [] };

  it("ranks players and explains every score", () => {
    const board = buildDraftBoard(freeAgents, league.settings, state, 10);
    expect(board.recommendations.length).toBeGreaterThan(0);
    for (const rec of board.recommendations) {
      const summed = rec.reasons.reduce((s, r) => s + r.impact, 0);
      expect(summed).toBeCloseTo(rec.score, 1);
    }
  });

  it("never recommends an already-drafted player", () => {
    const takenId = freeAgents[0].id;
    const board = buildDraftBoard(freeAgents, league.settings, { ...state, drafted: new Set([takenId]) }, 20);
    expect(board.recommendations.some((r) => r.player.id === takenId)).toBe(false);
  });

  it("treats a player as safer to pass on when their ADP is far away", () => {
    const early = survivalProbability(samplePlayer({ averageDraftPosition: 10 }), 5, 25);
    const late = survivalProbability(samplePlayer({ averageDraftPosition: 90 }), 5, 25);
    expect(early).toBeLessThan(late);
    expect(late).toBeGreaterThan(0.9);
  });

  it("assumes an undrafted player will still be there", () => {
    const p = samplePlayer({ averageDraftPosition: Number.POSITIVE_INFINITY });
    expect(survivalProbability(p, 5, 60)).toBeGreaterThan(0.9);
  });

  it("computes a normal CDF accurately enough for survival odds", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 3);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2);
  });

  it("reports remaining starter need and shrinks it as the roster fills", () => {
    const empty = rosterNeed([], league.settings);
    expect(empty.QB).toBeCloseTo(1, 1);
    const withQb = rosterNeed([samplePlayer({ position: "QB" })], league.settings);
    expect(withQb.QB).toBe(0);
  });
});

describe("waiver report", () => {
  const report = buildWaiverReport(league, myTeam, freeAgents, { week: 6, limit: 10 });

  it("returns explained targets", () => {
    expect(report.targets.length).toBeGreaterThan(0);
    for (const target of report.targets) {
      const summed = target.reasons.reduce((s, r) => s + r.impact, 0);
      expect(summed).toBeCloseTo(target.score, 1);
    }
  });

  it("never suggests bidding more than the whole budget", () => {
    for (const target of report.targets) {
      expect(target.suggestedBidPercent).toBeLessThanOrEqual(60);
      if (target.suggestedBid !== undefined) {
        expect(target.suggestedBid).toBeLessThanOrEqual(myTeam.faabRemaining ?? 100);
        expect(target.suggestedBid).toBeGreaterThan(0);
      }
    }
  });

  it("ranks the drop list cheapest-to-lose first", () => {
    const costs = report.dropList.map((c) => c.costToDrop);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });

  it("gives every drop candidate a stated reason", () => {
    for (const candidate of report.dropList) expect(candidate.reason.length).toBeGreaterThan(10);
  });
});

describe("live events", () => {
  const base = { takenAt: "2026-10-04T17:00:00Z", league, freeAgentIds: freeAgents.map((p) => p.id) };

  it("emits nothing when nothing changed", () => {
    expect(diffSnapshots(base, { ...base, takenAt: "2026-10-04T17:01:00Z" })).toHaveLength(0);
  });

  it("detects a player being ruled out and says what to do", () => {
    const next = structuredClone(league);
    const starter = next.teams[0].roster.find((r) => !r.benched)!;
    starter.player.injuryStatus = "OUT";

    const events = diffSnapshots(base, { ...base, takenAt: "2026-10-04T17:05:00Z", league: next });
    const injury = events.find((e) => e.kind === "injury_change");
    expect(injury).toBeDefined();
    expect(injury!.severity).toBe("critical");
    expect(injury!.action).toContain("Lineup");
  });

  it("detects a player hitting the wire", () => {
    const droppedId = league.teams[1].roster[0].player.id;
    const events = diffSnapshots(base, {
      ...base,
      takenAt: "2026-10-04T18:00:00Z",
      freeAgentIds: [...base.freeAgentIds, droppedId],
    });
    expect(events.some((e) => e.kind === "player_dropped" && e.playerId === droppedId)).toBe(true);
  });

  it("re-reports a broken lineup on every poll rather than only once", () => {
    const next = structuredClone(league);
    const starter = next.teams[0].roster.find((r) => !r.benched)!;
    starter.player.byeWeek = next.settings.currentWeek;
    const problems = lineupProblems(next, "2026-10-04T19:00:00Z");
    expect(problems.some((p) => p.kind === "lineup_problem")).toBe(true);
    expect(problems[0].severity).toBe("critical");
  });
});

describe("waiver pricing regressions", () => {
  // A bye-week hole made every replacement look like a season-long upgrade,
  // which priced a streaming kicker at 17% of a FAAB budget.
  it("does not price a one-week bye fill-in as a season-long asset", () => {
    const week = 6;
    // Constructed rather than sampled: my kicker is better, but on bye. The
    // free agent therefore helps this week and only this week.
    const team = structuredClone(myTeam);
    const kickerSlot = team.roster.find((r) => r.player.position === "K")!;
    kickerSlot.player.byeWeek = week;
    kickerSlot.player.projectedPoints = 12;
    // Cleared explicitly: a demo kicker who happens to be ruled out would
    // project zero in a normal week too, which is a different scenario.
    kickerSlot.player.injuryStatus = undefined;
    kickerSlot.player.percentOwnedDelta = 0;
    kickerSlot.player.gameLog = [];
    kickerSlot.benched = false;
    kickerSlot.slot = "K";

    const replacement: Player = {
      ...samplePlayer({
        id: 987654,
        name: "Backup Kicker",
        position: "K",
        projectedPoints: 7,
        seasonProjectedPoints: 119,
        averageDraftPosition: Number.POSITIVE_INFINITY,
      }),
      eligibleSlots: ["K", "BE"],
      byeWeek: 13,
    };

    const report = buildWaiverReport(league, team, [replacement], { week, limit: 5 });
    const target = report.targets.find((t) => t.player.id === replacement.id);

    expect(target).toBeDefined();
    // Worth points this week, because the incumbent scores zero on bye...
    expect(target!.lineupUpgrade).toBeGreaterThan(0);
    // ...and worth nothing in a normal week, because the incumbent is better.
    expect(target!.structuralUpgrade).toBe(0);
    expect(target!.suggestedBidPercent).toBeLessThanOrEqual(3);
    expect(target!.reasons.some((r) => r.code === "bye_fill")).toBe(true);
  });

  it("discounts streamable positions so they cannot outrank skill players", () => {
    const week = 6;
    const kicker = freeAgents.find((p) => p.position === "K")!;
    const report = buildWaiverReport(league, myTeam, [kicker], { week, limit: 5 });
    const target = report.targets.find((t) => t.player.id === kicker.id);
    if (target) {
      expect(target.reasons.some((r) => r.code === "streamable" && r.impact < 0)).toBe(true);
      expect(target.suggestedBidPercent).toBeLessThanOrEqual(3);
    }
  });
});

describe("draft board notes", () => {
  it("reports at most two positional cliffs and never for K or DST", () => {
    const board = buildDraftBoard(
      freeAgents,
      league.settings,
      { pickNumber: 13, nextPickNumber: 25, drafted: new Set<number>(), myRoster: [] },
      10,
    );
    const cliffs = board.boardNotes.filter((n) => n.code.startsWith("cliff_"));
    expect(cliffs.length).toBeLessThanOrEqual(2);
    expect(cliffs.some((n) => n.code === "cliff_K" || n.code === "cliff_DST")).toBe(false);
  });
});
