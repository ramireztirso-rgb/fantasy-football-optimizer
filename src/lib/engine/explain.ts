/**
 * Recommendations in this app are required to be decomposable: a score is the
 * sum of its reasons, not a number with prose attached afterwards.
 *
 * Every scorer builds a `ReasonBuilder`, adds each factor as it is computed,
 * and returns `total()`. That makes the explanation shown in the UI the actual
 * arithmetic that produced the ranking, so it cannot drift away from it.
 */

export type ReasonDirection = "positive" | "negative" | "neutral";

export interface Reason {
  /** Stable identifier, useful for filtering and tests. */
  code: string;
  /** Short phrase for chips and tight layouts. */
  label: string;
  /** One sentence explaining the factor in league-specific terms. */
  detail: string;
  /** Signed contribution to the score, in the score's own units. */
  impact: number;
  direction: ReasonDirection;
}

export class ReasonBuilder {
  private readonly reasons: Reason[] = [];
  private base = 0;

  /** Sets the starting value the factors adjust, e.g. a raw projection. */
  setBase(value: number, code: string, label: string, detail: string): this {
    this.base = value;
    this.reasons.push({ code, label, detail, impact: value, direction: "neutral" });
    return this;
  }

  /** Records a factor. A zero-impact factor is dropped to keep output readable. */
  add(code: string, label: string, detail: string, impact: number): this {
    if (Math.abs(impact) < 0.005) return this;
    this.reasons.push({
      code,
      label,
      detail,
      impact: round2(impact),
      direction: impact > 0 ? "positive" : "negative",
    });
    return this;
  }

  /** Records context that matters to a human but carries no score weight. */
  note(code: string, label: string, detail: string): this {
    this.reasons.push({ code, label, detail, impact: 0, direction: "neutral" });
    return this;
  }

  /** Sum of the base and every factor. */
  total(): number {
    return round2(this.reasons.reduce((sum, r) => sum + r.impact, 0));
  }

  build(): Reason[] {
    // Base first, then factors by magnitude: the reader wants the biggest
    // swing, not the first one computed.
    const [base, ...rest] = this.reasons;
    const sorted = rest.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    return this.base !== 0 && base ? [base, ...sorted] : this.reasons.slice().sort(
      (a, b) => Math.abs(b.impact) - Math.abs(a.impact),
    );
  }
}

/** Renders reasons as a single sentence, used for tooltips and the CLI. */
export function summarize(reasons: Reason[], limit = 3): string {
  const meaningful = reasons.filter((r) => r.impact !== 0).slice(0, limit);
  if (!meaningful.length) return reasons[0]?.detail ?? "No distinguishing factors.";
  return meaningful.map((r) => r.detail).join(" ");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
