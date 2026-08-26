import { describe, expect, it } from "vitest";
import { expandSlots, optimizeLineup } from "@/lib/engine/lineup";
import type { LeagueSettings, Player, Position, Team } from "@/lib/domain/types";

const SETTINGS: LeagueSettings = {
  name: "Test",
  size: 10,
  currentWeek: 5,
  seasonId: 2026,
  lineupSlots: [
    { slot: "QB", count: 1 },
    { slot: "RB", count: 2 },
    { slot: "WR", count: 2 },
    { slot: "FLEX", count: 1 },
  ],
  benchSlots: 5,
  irSlots: 1,
  isPPR: true,
  pointsPerReception: 1,
  usesFaab: true,
  faabBudget: 100,
  scoringRules: [],
  draft: { type: "SNAKE", pickOrder: [], rounds: 16, keeperCount: 0 },
  playoffTeamCount: 4,
  regularSeasonWeeks: 14,
};

function player(id: number, position: Position, projectedPoints: number, extra: Partial<Player> = {}): Player {
  const slots: Record<Position, string[]> = {
    QB: ["QB", "BE"],
    RB: ["RB", "FLEX", "BE"],
    WR: ["WR", "FLEX", "BE"],
    TE: ["TE", "FLEX", "BE"],
    K: ["K", "BE"],
    DST: ["DST", "BE"],
  };
  return {
    id,
    name: `P${id}`,
    position,
    proTeam: "KC",
    eligibleSlots: slots[position],
    byeWeek: 9,
    percentOwned: 50,
    percentOwnedDelta: 0,
    percentStarted: 40,
    projectedPoints,
    seasonProjectedPoints: projectedPoints * 17,
    gameLog: [],
    seasonPoints: 0,
    averageDraftPosition: Number.POSITIVE_INFINITY,
    draftRank: Number.POSITIVE_INFINITY,
    ...extra,
  };
}

function team(roster: Array<{ slot: string; player: Player; benched: boolean }>): Team {
  return {
    id: 1,
    name: "Test Team",
    abbrev: "TT",
    owners: [],
    wins: 2,
    losses: 2,
    ties: 0,
    pointsFor: 400,
    pointsAgainst: 390,
    roster,
  };
}

describe("expandSlots", () => {
  it("expands slot counts into individual slots", () => {
    expect(expandSlots(SETTINGS)).toEqual(["QB", "RB", "RB", "WR", "WR", "FLEX"]);
  });
});

describe("optimizeLineup", () => {
  it("puts the best eligible player in every slot", () => {
    const roster = [
      { slot: "QB", player: player(1, "QB", 20), benched: false },
      { slot: "RB", player: player(2, "RB", 18), benched: false },
      { slot: "RB", player: player(3, "RB", 14), benched: false },
      { slot: "WR", player: player(4, "WR", 16), benched: false },
      { slot: "WR", player: player(5, "WR", 12), benched: false },
      { slot: "FLEX", player: player(6, "WR", 10), benched: false },
      { slot: "BE", player: player(7, "RB", 5), benched: true },
    ];
    const result = optimizeLineup(team(roster), SETTINGS, { week: 5 });
    expect(result.optimalPoints).toBeCloseTo(20 + 18 + 14 + 16 + 12 + 10, 1);
    expect(result.changes).toHaveLength(0);
  });

  it("finds points left on the bench and explains the swap", () => {
    const roster = [
      { slot: "QB", player: player(1, "QB", 20), benched: false },
      { slot: "RB", player: player(2, "RB", 18), benched: false },
      { slot: "RB", player: player(3, "RB", 4), benched: false },
      { slot: "WR", player: player(4, "WR", 16), benched: false },
      { slot: "WR", player: player(5, "WR", 12), benched: false },
      { slot: "FLEX", player: player(6, "WR", 10), benched: false },
      { slot: "BE", player: player(7, "RB", 15), benched: true },
    ];
    const result = optimizeLineup(team(roster), SETTINGS, { week: 5 });
    expect(result.pointsLeftOnBench).toBeCloseTo(11, 1);
    expect(result.changes[0].benchPlayer.id).toBe(7);
    expect(result.changes[0].gain).toBeCloseTo(11, 1);
    // The explanation must actually decompose the number it reports.
    const summed = result.changes[0].reasons.reduce((s, r) => s + r.impact, 0);
    expect(summed).toBeCloseTo(result.changes[0].gain, 1);
  });

  it("uses FLEX to hold a player who beats a same-position starter elsewhere", () => {
    // Three good RBs and weak WRs: the third RB belongs in FLEX, which greedy
    // slot-filling would give to a WR instead.
    const roster = [
      { slot: "QB", player: player(1, "QB", 20), benched: false },
      { slot: "RB", player: player(2, "RB", 18), benched: false },
      { slot: "RB", player: player(3, "RB", 17), benched: false },
      { slot: "WR", player: player(4, "WR", 9), benched: false },
      { slot: "WR", player: player(5, "WR", 8), benched: false },
      { slot: "FLEX", player: player(6, "WR", 7), benched: false },
      { slot: "BE", player: player(7, "RB", 16), benched: true },
    ];
    const result = optimizeLineup(team(roster), SETTINGS, { week: 5 });
    const flex = result.optimal.find((a) => a.slot === "FLEX");
    expect(flex?.projection?.player.id).toBe(7);
  });

  it("zeroes a player on bye and flags them when they are starting", () => {
    const roster = [
      { slot: "QB", player: player(1, "QB", 20, { byeWeek: 5 }), benched: false },
      { slot: "RB", player: player(2, "RB", 18), benched: false },
      { slot: "RB", player: player(3, "RB", 14), benched: false },
      { slot: "WR", player: player(4, "WR", 16), benched: false },
      { slot: "WR", player: player(5, "WR", 12), benched: false },
      { slot: "FLEX", player: player(6, "WR", 10), benched: false },
      { slot: "BE", player: player(7, "QB", 9), benched: true },
    ];
    const result = optimizeLineup(team(roster), SETTINGS, { week: 5 });
    expect(result.optimal.find((a) => a.slot === "QB")?.projection?.player.id).toBe(7);
    expect(result.warnings.some((w) => w.code === "starter_on_bye")).toBe(true);
  });

  it("never offers an IR-slotted player as a starter", () => {
    const roster = [
      { slot: "QB", player: player(1, "QB", 5), benched: false },
      { slot: "IR", player: player(2, "QB", 30), benched: true },
    ];
    const result = optimizeLineup(team(roster), SETTINGS, { week: 5 });
    const started = result.optimal.map((a) => a.projection?.player.id).filter(Boolean);
    expect(started).not.toContain(2);
  });

  it("leaves a slot empty rather than starting an ineligible player", () => {
    const roster = [{ slot: "QB", player: player(1, "QB", 20), benched: false }];
    const result = optimizeLineup(team(roster), SETTINGS, { week: 5 });
    expect(result.optimal.filter((a) => a.projection === null)).toHaveLength(5);
    expect(result.optimalPoints).toBeCloseTo(20, 1);
  });
});
