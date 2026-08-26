import { describe, expect, it } from "vitest";
import { backfieldShares, injuryRecord, findHandcuffs } from "@/lib/engine/backfield";
import type { Player } from "@/lib/domain/types";
import type { SeasonStatLine } from "@/lib/sources/nflverse";

const line = (
  gsisId: string,
  name: string,
  team: string,
  carries: number,
  games = 17,
): SeasonStatLine =>
  ({ gsisId, name, team, carries, games, position: "RB", season: 2025 }) as SeasonStatLine;

const player = (id: number, name: string, team: string, adp = 170): Player =>
  ({ id, name, proTeam: team, position: "RB", averageDraftPosition: adp }) as unknown as Player;

describe("backfieldShares", () => {
  // The distinction the whole module exists for: two backs can post identical
  // point totals, one as the only back his team uses and one as a third of a
  // committee, and those are different bets entirely.
  it("separates a workhorse from a committee back", () => {
    const shares = backfieldShares([
      line("a", "Workhorse", "DET", 300),
      line("b", "Backup", "DET", 60),
      line("c", "Split One", "TB", 150),
      line("d", "Split Two", "TB", 140),
      line("e", "Split Three", "TB", 110),
    ]);
    expect(shares.get("a")?.role).toBe("workhorse");
    expect(shares.get("c")?.role).toBe("committee");
    expect(shares.get("c")?.splitWith).toBe(3);
  });

  // Measured within a team, so a run-heavy offence does not make all its backs
  // look like workhorses.
  it("measures share within a team rather than league-wide", () => {
    const shares = backfieldShares([
      line("a", "Big Offence", "PHI", 200),
      line("b", "Also Big", "PHI", 200),
      line("c", "Small Offence", "NYJ", 120),
    ]);
    expect(shares.get("a")?.share).toBe(0.5);
    expect(shares.get("c")?.share).toBe(1);
  });

  it("ignores a backfield with too few carries to describe", () => {
    expect(backfieldShares([line("a", "Nobody", "LV", 30)]).size).toBe(0);
  });
});

describe("injuryRecord", () => {
  it("needs more than one season before calling anyone fragile", () => {
    const one = injuryRecord([line("a", "Unlucky", "SF", 100, 6)]);
    expect(one.fragile).toBe(false);
  });

  it("flags a back who repeatedly misses time", () => {
    const record = injuryRecord([
      line("a", "Fragile", "SF", 100, 11),
      line("a", "Fragile", "SF", 120, 13),
      line("a", "Fragile", "SF", 90, 12),
    ]);
    // 6 + 4 + 5 games missed over three seasons.
    expect(record.missedPerSeason).toBeCloseTo(5, 1);
    expect(record.fragile).toBe(true);
  });

  it("leaves a durable back alone", () => {
    const record = injuryRecord([
      line("a", "Iron", "BAL", 300, 17),
      line("a", "Iron", "BAL", 290, 17),
    ]);
    expect(record.fragile).toBe(false);
  });
});

describe("findHandcuffs", () => {
  const shares = backfieldShares([
    line("star", "Star", "SF", 300),
    line("deputy", "Deputy", "SF", 70),
    line("fullback", "Fullback", "SF", 2),
  ]);
  const gsisIdFor = (p: Player) => ({ 1: "star", 2: "deputy", 3: "fullback" })[p.id];

  // The fault that gave Christian McCaffrey a fullback as his handcuff: every
  // undrafted player shares the same capped draft position, so ordering by it
  // picks at random among them.
  it("picks the back who took carries, not the one with the best draft position", () => {
    const pool = [player(2, "Deputy", "SF", 171), player(3, "Fullback", "SF", 165)];
    const cuffs = findHandcuffs([player(1, "Star", "SF")], pool, shares, gsisIdFor, () => ({
      seasons: 3,
      missedPerSeason: 4,
      fragile: true,
    }));
    expect(cuffs[0].backup?.name).toBe("Deputy");
  });

  it("says so when nobody behind him took a real share", () => {
    const pool = [player(3, "Fullback", "SF", 165)];
    const cuffs = findHandcuffs([player(1, "Star", "SF")], pool, shares, gsisIdFor, () => ({
      seasons: 3,
      missedPerSeason: 1,
      fragile: false,
    }));
    expect(cuffs[0].backup).toBeNull();
    expect(cuffs[0].detail).toContain("up for grabs");
  });

  // Behind a committee back there is no job to inherit, so there is nothing to
  // handcuff -- the carries are already shared out.
  it("declines to recommend a handcuff behind a committee back", () => {
    const committee = backfieldShares([
      line("star", "Star", "SF", 120),
      line("deputy", "Deputy", "SF", 110),
      line("third", "Third", "SF", 100),
    ]);
    const pool = [player(2, "Deputy", "SF")];
    const cuffs = findHandcuffs([player(1, "Star", "SF")], pool, committee, gsisIdFor, () => ({
      seasons: 3,
      missedPerSeason: 4,
      fragile: true,
    }));
    expect(cuffs[0].detail).toContain("Not worth a pick");
  });
});
