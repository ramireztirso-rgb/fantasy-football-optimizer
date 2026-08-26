import { describe, expect, it } from "vitest";
import { bestLineupPoints, marginalValue } from "@/lib/engine/marginalValue";
import type { LeagueSettings, Player } from "@/lib/domain/types";

const settings = {
  size: 12,
  lineupSlots: [
    { slot: "QB", count: 1 },
    { slot: "RB", count: 2 },
    { slot: "WR", count: 2 },
    { slot: "TE", count: 1 },
    { slot: "FLEX", count: 1 },
    { slot: "DST", count: 1 },
    { slot: "K", count: 1 },
  ],
  benchSlots: 6,
  irSlots: 1,
} as unknown as LeagueSettings;

const levels = { QB: 280, RB: 180, WR: 180, TE: 140, K: 120, DST: 100 };

const player = (id: number, position: string, name = `P${id}`): Player =>
  ({ id, name, position, eligibleSlots: [], proTeam: "SF", byeWeek: 9 }) as unknown as Player;

const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "DST", "K"];

describe("bestLineupPoints", () => {
  it("values an empty roster at what free agents would give you", () => {
    // Every slot on its floor. The flex takes the best of RB/WR/TE, so 180:
    // 280 + 180 + 180 + 180 + 180 + 140 + 180 + 100 + 120.
    expect(bestLineupPoints([], slots, levels)).toBe(1540);
  });

  it("counts only the amount a player beats a free agent by", () => {
    const withStar = bestLineupPoints([{ player: player(1, "RB"), points: 300 }], slots, levels);
    expect(withStar - 1540).toBe(120);
  });

  // The flex is what makes this more than a lookup: a third good back has
  // nowhere to go except the flex, and only if he beats what is there.
  it("puts an extra back in the flex when he is worth more than a free agent", () => {
    const roster = [
      { player: player(1, "RB"), points: 300 },
      { player: player(2, "RB"), points: 280 },
      { player: player(3, "RB"), points: 260 },
    ];
    expect(bestLineupPoints(roster, slots, levels) - 1540).toBe(120 + 100 + 80);
  });

  it("ignores a player who cannot beat a free agent anywhere", () => {
    const roster = [{ player: player(1, "RB"), points: 100 }];
    expect(bestLineupPoints(roster, slots, levels)).toBe(1540);
  });
});

describe("marginalValue", () => {
  const ctx = (roster: Array<{ player: Player; points: number }>) => ({
    settings,
    levels,
    roster,
    picksRemaining: 10,
  });

  // The whole reason for this measure: a player who cannot crack the lineup is
  // worth almost nothing, and that falls out rather than needing a penalty.
  it("values a player who cannot crack the lineup near zero", () => {
    const stacked = [
      { player: player(1, "RB"), points: 320 },
      { player: player(2, "RB"), points: 310 },
      { player: player(3, "RB"), points: 300 },
    ];
    const another = marginalValue(player(4, "RB"), 250, ctx(stacked));
    const first = marginalValue(player(5, "RB"), 250, ctx([]));
    expect(another).toBeLessThan(first * 0.35);
  });

  it("never returns a negative value", () => {
    expect(marginalValue(player(9, "RB"), 10, ctx([]))).toBeGreaterThanOrEqual(0);
    expect(marginalValue(player(9, "K"), 0, ctx([]))).toBeGreaterThanOrEqual(0);
  });

  it("gives a bench player some value as cover, but not much", () => {
    const stacked = [
      { player: player(1, "TE"), points: 220 },
      { player: player(2, "TE"), points: 210 },
    ];
    const backup = marginalValue(player(3, "TE"), 200, ctx(stacked));
    expect(backup).toBeGreaterThan(0);
    expect(backup).toBeLessThan(10);
  });
});
