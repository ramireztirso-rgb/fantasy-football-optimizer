import { describe, expect, it } from "vitest";
import { effectiveScoringPoints } from "@/lib/espn/stats";
import { normalizeSettings } from "@/lib/espn/normalize";
import { buildScoringProfile } from "@/lib/engine/scoringProfile";
import { starterDemand } from "@/lib/engine/replacement";
import type { RawLeagueResponse } from "@/lib/espn/raw";

describe("effectiveScoringPoints", () => {
  // The bug this guards: ESPN leaves `points` at the platform default and puts
  // the league's customized value in `pointsOverrides`. Reading `points` alone
  // silently misreads every rule the league actually customized.
  it("prefers the league override over the platform default", () => {
    expect(effectiveScoringPoints({ points: 4, pointsOverrides: { "16": 6 } })).toBe(6);
  });

  it("reads an override even when the default is zero", () => {
    expect(effectiveScoringPoints({ points: 0, pointsOverrides: { "16": 0.5 } })).toBe(0.5);
  });

  it("falls back to points when there is no override", () => {
    expect(effectiveScoringPoints({ points: 4 })).toBe(4);
    expect(effectiveScoringPoints({})).toBe(0);
  });

  it("uses a lone override under an unexpected key", () => {
    expect(effectiveScoringPoints({ points: 4, pointsOverrides: { "1": 6 } })).toBe(6);
  });

  it("does not guess when several overrides disagree", () => {
    expect(effectiveScoringPoints({ points: 4, pointsOverrides: { "1": 6, "2": 5 } })).toBe(4);
  });
});

describe("custom league settings", () => {
  const raw: RawLeagueResponse = {
    seasonId: 2026,
    settings: {
      name: "Custom League",
      size: 12,
      rosterSettings: {
        // 1QB / 2RB / 3WR / 1TE / 2FLEX / 1K / 1DST, 7 bench, 2 IR
        lineupSlotCounts: { "0": 1, "2": 2, "4": 3, "6": 1, "23": 2, "16": 1, "17": 1, "20": 7, "21": 2 },
      },
      scoringSettings: {
        scoringItems: [
          { statId: 4, points: 4, pointsOverrides: { "16": 6 } },   // 6-pt passing TD
          { statId: 53, points: 0, pointsOverrides: { "16": 0.5 } }, // half PPR
          { statId: 3, points: 0.04 },
          { statId: 24, points: 0.1 },
          { statId: 42, points: 0.1 },
          { statId: 20, points: -2 },
        ],
      },
      acquisitionSettings: { acquisitionBudget: 200, isUsingAcquisitionBudget: true },
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6 },
    },
  };

  const settings = normalizeSettings(raw, 1);

  it("reads customized scoring values rather than the defaults", () => {
    expect(settings.scoringRules.find((r) => r.statId === 4)?.points).toBe(6);
    expect(settings.pointsPerReception).toBe(0.5);
    expect(settings.isPPR).toBe(true);
  });

  it("reads a non-standard roster shape", () => {
    expect(settings.size).toBe(12);
    expect(settings.benchSlots).toBe(7);
    expect(settings.irSlots).toBe(2);
    expect(settings.lineupSlots).toEqual([
      { slot: "QB", count: 1 },
      { slot: "RB", count: 2 },
      { slot: "WR", count: 3 },
      { slot: "TE", count: 1 },
      { slot: "FLEX", count: 2 },
      { slot: "DST", count: 1 },
      { slot: "K", count: 1 },
    ]);
  });

  it("scales replacement level to the custom roster, not a default one", () => {
    const demand = starterDemand(settings);
    // 12 teams x 3 WR starters = 36, plus WR's share of 24 flex slots.
    expect(demand.WR).toBeGreaterThan(36);
    expect(demand.QB).toBe(12);
  });

  it("identifies the deviations and explains what they mean", () => {
    const profile = buildScoringProfile(settings);
    expect(profile.isStandard).toBe(false);

    const passTd = profile.deviations.find((d) => d.statId === 4);
    expect(passTd?.leaguePoints).toBe(6);
    expect(passTd?.standardPoints).toBe(4);
    expect(passTd?.perGameImpact).toBeGreaterThan(0);

    const ppr = profile.deviations.find((d) => d.statId === 53);
    expect(ppr?.perGameImpact).toBeGreaterThan(0);

    // A 3WR/2FLEX build must be called out as deepening WR replacement level.
    expect(profile.rosterDeviations.some((r) => r.position === "WR")).toBe(true);
    expect(profile.implications.join(" ")).toMatch(/half-ppr/i);
  });

  it("reports a default league as standard", () => {
    const standard = normalizeSettings(
      {
        seasonId: 2026,
        settings: {
          name: "Standard",
          size: 10,
          rosterSettings: {
            lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 6 },
          },
          scoringSettings: {
            scoringItems: [
              { statId: 4, points: 4 },
              { statId: 3, points: 0.04 },
              { statId: 24, points: 0.1 },
              { statId: 25, points: 6 },
            ],
          },
        },
      },
      1,
    );
    expect(buildScoringProfile(standard).isStandard).toBe(true);
  });
});
