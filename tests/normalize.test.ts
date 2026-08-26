import { describe, expect, it } from "vitest";
import fixture from "./fixtures/league.json";
import { normalizeLeague, extractStats, resolveMyTeamId, normalizeDraftSettings } from "@/lib/espn/normalize";
import { currentWeek } from "@/lib/espn/league";
import { normalizeSwid } from "@/lib/espn/client";
import { availabilityMultiplier } from "@/lib/espn/constants";
import type { RawLeagueResponse, RawPlayer } from "@/lib/espn/raw";

const raw = fixture as RawLeagueResponse;
const ctx = { week: 6, seasonId: 2026, byeWeeks: { 12: 10, 33: 14 } };
const league = normalizeLeague(raw, ctx, resolveMyTeamId(raw, "{ABC-123}"));

describe("normalizeLeague", () => {
  it("reads league settings including the PPR value", () => {
    expect(league.settings.name).toBe("Fixture League");
    expect(league.settings.isPPR).toBe(true);
    expect(league.settings.pointsPerReception).toBe(1);
    expect(league.settings.usesFaab).toBe(true);
    expect(league.settings.faabBudget).toBe(100);
  });

  it("separates starting slots from bench and IR", () => {
    expect(league.settings.benchSlots).toBe(6);
    expect(league.settings.irSlots).toBe(1);
    expect(league.settings.lineupSlots).toEqual([
      { slot: "QB", count: 1 },
      { slot: "RB", count: 2 },
      { slot: "WR", count: 2 },
      { slot: "TE", count: 1 },
      { slot: "FLEX", count: 1 },
      { slot: "DST", count: 1 },
      { slot: "K", count: 1 },
    ]);
  });

  it("builds team names from either naming scheme", () => {
    expect(league.teams[0].name).toBe("Fixture One");
    expect(league.teams[1].name).toBe("Fixture Two");
  });

  it("computes remaining FAAB from budget minus spend", () => {
    expect(league.teams[0].faabRemaining).toBe(65);
    expect(league.teams[1].faabRemaining).toBe(100);
  });

  it("maps position, pro team, and slot ids to names", () => {
    const qb = league.teams[0].roster[0];
    expect(qb.player.position).toBe("QB");
    expect(qb.player.proTeam).toBe("KC");
    expect(qb.slot).toBe("QB");
    expect(qb.benched).toBe(false);
  });

  it("marks bench and IR entries as benched", () => {
    expect(league.teams[0].roster[1].benched).toBe(true);
    expect(league.teams[0].roster[2].slot).toBe("IR");
    expect(league.teams[0].roster[2].benched).toBe(true);
  });

  it("falls back to first + last name when fullName is absent", () => {
    expect(league.teams[0].roster[1].player.name).toBe("Fixture Runningback");
  });

  it("derives an injury status from the boolean injured flag", () => {
    expect(league.teams[0].roster[2].player.injuryStatus).toBe("OUT");
  });

  it("attaches bye weeks from the pro-team schedule", () => {
    expect(league.teams[0].roster[0].player.byeWeek).toBe(10);
    expect(league.teams[0].roster[1].player.byeWeek).toBe(14);
  });

  it("identifies the user's own team from the SWID", () => {
    expect(league.myTeamId).toBe(1);
    expect(resolveMyTeamId(raw, "{def-456}")).toBe(2);
    expect(resolveMyTeamId(raw, undefined)).toBeUndefined();
  });

  it("normalizes the live matchup", () => {
    expect(league.matchups).toHaveLength(1);
    expect(league.matchups[0].home.points).toBe(62.4);
    expect(league.matchups[0].away?.projectedPoints).toBe(112.3);
    expect(league.matchups[0].live).toBe(true);
  });
});

describe("extractStats", () => {
  const player = raw.teams![0].roster!.entries![0].playerPoolEntry!.player as RawPlayer;
  const stats = extractStats(player, ctx);

  it("picks the weekly projection for the target week", () => {
    expect(stats.projectedPoints).toBe(21.7);
  });

  it("keeps season projection and season actual apart", () => {
    expect(stats.seasonProjectedPoints).toBe(355.2);
    expect(stats.seasonPoints).toBe(118.6);
  });

  it("builds a game log from played weeks only", () => {
    // Weeks 1 and 2 were played; week 9 is a zeroed future block and must not
    // be counted as a real game.
    expect(stats.gameLog.map((g) => g.week)).toEqual([1, 2]);
  });

  it("ignores blocks from other seasons", () => {
    expect(stats.seasonPoints).not.toBe(410.9);
  });
});

describe("client helpers", () => {
  it("normalizes SWID with or without braces", () => {
    expect(normalizeSwid("ABC-123")).toBe("{ABC-123}");
    expect(normalizeSwid("{ABC-123}")).toBe("{ABC-123}");
    expect(normalizeSwid("  ")).toBeUndefined();
    expect(normalizeSwid(undefined)).toBeUndefined();
  });

  it("prefers scoringPeriodId when reading the current week", () => {
    expect(currentWeek(raw)).toBe(6);
    expect(currentWeek({ status: { latestScoringPeriod: 4 } })).toBe(4);
    expect(currentWeek({})).toBe(1);
  });

  it("discounts availability by injury severity", () => {
    expect(availabilityMultiplier("ACTIVE")).toBe(1);
    expect(availabilityMultiplier(undefined)).toBe(1);
    expect(availabilityMultiplier("OUT")).toBe(0);
    expect(availabilityMultiplier("QUESTIONABLE")).toBeCloseTo(0.75, 2);
  });
});

describe("draft round count", () => {
  it("excludes injured-reserve slots, which are never drafted into", () => {
    // 1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX, 1 DST, 1 K, 6 BE, 1 IR -> a 15-round
    // draft, not 16.
    const settings = normalizeDraftSettings({
      settings: {
        draftSettings: { type: "SNAKE", pickOrder: [1, 2] },
        rosterSettings: {
          lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 6, 21: 1, 23: 1 },
        },
      },
    } as never);
    expect(settings.rounds).toBe(15);
  });
});
