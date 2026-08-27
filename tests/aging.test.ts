import { describe, expect, it } from "vitest";
import { buildAgeCurve, type AgeObservation } from "@/lib/engine/aging";

const many = (position: string, age: number, delta: number, n = 20): AgeObservation[] =>
  Array.from({ length: n }, () => ({ position: position as never, age, delta }));

describe("buildAgeCurve", () => {
  const curve = buildAgeCurve([
    ...many("WR", 24, 0.5),
    ...many("WR", 25, 0),
    ...many("WR", 26, -0.5),
    ...many("WR", 27, -1),
    ...many("RB", 26, -0.2),
    ...many("RB", 27, -2),
  ]);

  it("fits a separate curve per position", () => {
    expect(curve.step("WR", 27)).toBeCloseTo(-1, 2);
    expect(curve.step("RB", 27)).toBeCloseTo(-2, 2);
  });

  it("compounds the steps between two ages", () => {
    // 25 -> 27 crosses the 25 and 26 steps: 0 + (-0.5).
    expect(curve.between("WR", 25, 27)).toBeCloseTo(-0.5, 2);
  });

  it("returns nothing for a player who is not getting older", () => {
    expect(curve.between("WR", 27, 27)).toBe(0);
    expect(curve.between("WR", 28, 26)).toBe(0);
  });

  // Extrapolating a trend off the end of the data is the model talking to
  // itself: a thirty-eight-year-old receiver is rare enough that the curve has
  // nothing to say about him, so it holds the nearest edge instead.
  it("holds the nearest observed age rather than extrapolating", () => {
    expect(curve.step("WR", 38)).toBeCloseTo(curve.step("WR", 27), 2);
    expect(curve.step("WR", 19)).toBeCloseTo(curve.step("WR", 24), 2);
  });

  it("ignores ages with too few observations to mean anything", () => {
    const thin = buildAgeCurve([
      ...many("TE", 25, 0.4),
      { position: "TE" as never, age: 31, delta: -9 },
    ]);
    expect(thin.coverage("TE" as never)).toEqual([25]);
    // The lone 31-year-old must not drag the curve; it falls back to 25.
    expect(thin.step("TE" as never, 31)).toBeCloseTo(0.4, 2);
  });

  it("says nothing for a position it never saw", () => {
    expect(curve.step("QB" as never, 27)).toBe(0);
    expect(curve.between("QB" as never, 25, 30)).toBe(0);
  });
});
