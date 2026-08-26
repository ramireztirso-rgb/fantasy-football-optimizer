import { describe, expect, it } from "vitest";
import { judge, percentile, renderScorecard } from "@/lib/analysis/scorecard";

const spread = (centre: number, n = 40) =>
  Array.from({ length: n }, (_, i) => centre + ((i % 5) - 2) * 0.4);

describe("judge", () => {
  it("confirms a claim that is real, large, and points the right way", () => {
    const f = judge(
      "treatment scores more",
      { label: "control", values: spread(10) },
      { label: "treatment", values: spread(16) },
      "pts",
      { expect: "increase", practicalThreshold: 2 },
    );
    expect(f.verdict).toBe("CONFIRMED");
    expect(f.effect).toBeCloseTo(6, 1);
  });

  // The bug this exists for. Without a direction check, an effect that is real
  // and backwards reads as a confirmation -- which is worse than not testing at
  // all, because it launders a refutation into support.
  it("rejects an effect that is real but backwards", () => {
    const f = judge(
      "treatment scores more",
      { label: "control", values: spread(16) },
      { label: "treatment", values: spread(10) },
      "pts",
      { expect: "increase", practicalThreshold: 2 },
    );
    expect(f.verdict).toBe("REJECTED");
    expect(f.detail).toContain("Backwards");
  });

  it("reads a decrease claim the other way round", () => {
    const f = judge(
      "treatment swings less",
      { label: "control", values: spread(16) },
      { label: "treatment", values: spread(10) },
      "pts",
      { expect: "decrease", practicalThreshold: 2 },
    );
    expect(f.verdict).toBe("CONFIRMED");
  });

  // Statistically real and practically irrelevant is the outcome folk wisdom
  // most often actually has, and the one a plain yes/no would call a win.
  it("rejects a real effect too small to act on", () => {
    const f = judge(
      "treatment scores more",
      { label: "control", values: spread(10) },
      { label: "treatment", values: spread(10.3) },
      "pts",
      { expect: "increase", practicalThreshold: 2 },
    );
    expect(f.verdict).toBe("REJECTED");
    expect(f.detail).toContain("too small to use");
  });

  it("declines to conclude from too few observations", () => {
    const f = judge(
      "treatment scores more",
      { label: "control", values: [1, 2, 3] },
      { label: "treatment", values: [9, 9, 9] },
      "pts",
      { expect: "increase", practicalThreshold: 1 },
    );
    expect(f.verdict).toBe("INCONCLUSIVE");
  });
});

describe("percentile", () => {
  // "Floor" means the bad weeks, not the average of them.
  it("finds the bad weeks rather than the middle", () => {
    const weeks = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    expect(percentile(weeks, 0.1)).toBe(2);
    expect(percentile(weeks, 0.5)).toBe(10);
  });

  it("survives an empty series", () => {
    expect(percentile([], 0.1)).toBe(0);
  });
});

describe("renderScorecard", () => {
  it("counts the verdicts so a reader does not have to", () => {
    const findings = [
      judge("a", { label: "c", values: spread(10) }, { label: "t", values: spread(16) }, "pts", {
        expect: "increase",
        practicalThreshold: 2,
      }),
      judge("b", { label: "c", values: spread(10) }, { label: "t", values: spread(10.1) }, "pts", {
        expect: "increase",
        practicalThreshold: 2,
      }),
    ];
    expect(renderScorecard(findings)).toContain("1 confirmed, 1 rejected");
  });
});
