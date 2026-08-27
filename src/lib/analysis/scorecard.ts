/**
 * A verdict on a piece of received wisdom.
 *
 * The rule this enforces is that a claim gets three separate answers, not one.
 * Is there an effect? Is it bigger than chance? Is it big enough to change
 * what anybody does? Those come apart constantly, and collapsing them into a
 * yes or a no is how a folk belief survives being tested -- somebody finds a
 * real 0.3% edge, reports "confirmed", and the belief keeps its reputation for
 * mattering.
 *
 * So a claim can be statistically real and still rejected as a rule to draft
 * on, and this says so in those words.
 */

export type Verdict = "CONFIRMED" | "REJECTED" | "INCONCLUSIVE";

export interface Finding {
  claim: string;
  verdict: Verdict;
  /** Difference between groups, in whatever unit the claim is about. */
  effect: number;
  effectUnit: string;
  /** How many standard errors separate the groups. */
  sigmas: number;
  /** Observations behind it, both groups combined. */
  sample: number;
  /** One line a person can read without the code. */
  detail: string;
  /**
   * Named cases that show the contrast, when the caller supplied names.
   *
   * Chosen near each group's average rather than at its extremes. The extremes
   * are the most persuasive examples available and the least honest ones --
   * every group has a tail, and picking from it illustrates the tail rather
   * than the finding.
   */
  examples: string[];
}

export interface Group {
  label: string;
  values: number[];
  /** Optional labels running parallel to `values`, e.g. "Bijan Robinson 2024". */
  names?: string[];
}

export interface JudgeOptions {
  /**
   * Which way the claim says the effect should go. Without it a result that is
   * real and *backwards* reads as a confirmation, which is worse than not
   * testing at all: the first run of this reported "committee backs swing more
   * week to week" as confirmed on evidence that they swing considerably less.
   */
  expect: "increase" | "decrease";
  /**
   * The smallest effect worth acting on, in the claim's own units. Below it a
   * finding is filed as rejected however clean the statistics, because the
   * claim being tested is always "this should change your draft" and a
   * difference too small to notice does not.
   */
  practicalThreshold: number;
  /** Standard errors required before an effect is treated as real at all. */
  sigmaThreshold?: number;
  /** Smallest usable group; below it nothing is concluded either way. */
  minGroupSize?: number;
}

/**
 * Compares two groups and returns a verdict.
 *
 * `expected` names the direction the folk claim predicts, so an effect that is
 * real and *backwards* is reported as a rejection rather than a confirmation --
 * a distinction that matters, since several of these turn out to point the
 * wrong way.
 */
export function judge(
  claim: string,
  control: Group,
  treatment: Group,
  unit: string,
  options: JudgeOptions,
): Finding {
  const { expect, practicalThreshold, sigmaThreshold = 2, minGroupSize = 20 } = options;

  const sample = control.values.length + treatment.values.length;
  if (control.values.length < minGroupSize || treatment.values.length < minGroupSize) {
    return {
      claim,
      verdict: "INCONCLUSIVE",
      effect: 0,
      effectUnit: unit,
      sigmas: 0,
      sample,
      detail:
        `Not enough to say: ${control.values.length} ${control.label} against ` +
        `${treatment.values.length} ${treatment.label}, and ${minGroupSize} a side is the minimum.`,
      examples: [],
    };
  }

  const effect = mean(treatment.values) - mean(control.values);
  const se = Math.sqrt(
    variance(control.values) / control.values.length +
      variance(treatment.values) / treatment.values.length,
  );
  const sigmas = se > 0 ? Math.abs(effect) / se : 0;

  const real = sigmas >= sigmaThreshold;
  const bigEnough = Math.abs(effect) >= practicalThreshold;
  const rightWay = expect === "increase" ? effect > 0 : effect < 0;

  let verdict: Verdict;
  let detail: string;
  if (real && bigEnough && !rightWay) {
    // The most interesting outcome there is, and the easiest to misreport.
    verdict = "REJECTED";
    detail =
      `Backwards. The claim says ${expect === "increase" ? "more" : "less"}, and ` +
      `${treatment.label} ${describe(effect, unit)} against ${control.label} at ` +
      `${sigmas.toFixed(1)} times the sampling noise. Real, and the opposite of the claim.`;
  } else if (!real) {
    verdict = "REJECTED";
    detail =
      `${treatment.label} ${describe(effect, unit)} against ${control.label}, which is ` +
      `${sigmas.toFixed(1)} times the sampling noise -- close enough to chance that there is ` +
      `nothing here.`;
  } else if (!bigEnough || !rightWay) {
    verdict = "REJECTED";
    detail =
      `Real but too small to use: ${treatment.label} ${describe(effect, unit)} against ` +
      `${control.label} at ${sigmas.toFixed(1)} times the noise, where ${practicalThreshold} ` +
      `${unit} is the least that would change a decision.`;
  } else {
    verdict = "CONFIRMED";
    detail =
      `${treatment.label} ${describe(effect, unit)} against ${control.label}, ` +
      `${sigmas.toFixed(1)} times the sampling noise and past the ${practicalThreshold} ` +
      `${unit} that would change a decision.`;
  }

  return {
    claim,
    verdict,
    effect: round2(effect),
    effectUnit: unit,
    sigmas: round2(sigmas),
    sample,
    detail,
    examples: [...typicalOf(control, unit), ...typicalOf(treatment, unit)],
  };
}

/** Renders findings as a table somebody can read without the code. */
export function renderScorecard(findings: Finding[]): string {
  const lines: string[] = [];
  const width = Math.min(64, Math.max(...findings.map((f) => f.claim.length), 20));

  lines.push(`  ${"claim".padEnd(width)}  verdict       effect        n`);
  lines.push(`  ${"-".repeat(width)}  ------------  ------------  -----`);
  for (const f of findings) {
    const effect = `${f.effect >= 0 ? "+" : ""}${f.effect} ${f.effectUnit}`;
    lines.push(
      `  ${f.claim.slice(0, width).padEnd(width)}  ${f.verdict.padEnd(12)}  ` +
        `${effect.slice(0, 12).padEnd(12)}  ${String(f.sample).padStart(5)}`,
    );
  }

  lines.push("");
  for (const f of findings) {
    lines.push(`  ${f.claim}\n    ${f.detail}`);
    for (const example of f.examples) lines.push(`      ${example}`);
  }

  const confirmed = findings.filter((f) => f.verdict === "CONFIRMED").length;
  const rejected = findings.filter((f) => f.verdict === "REJECTED").length;
  const unclear = findings.filter((f) => f.verdict === "INCONCLUSIVE").length;
  lines.push(
    `\n  ${confirmed} confirmed, ${rejected} rejected, ${unclear} inconclusive out of ${findings.length}.`,
  );
  return lines.join("\n");
}

/**
 * Two cases from a group that sit closest to its average.
 *
 * The point is to put names to a number a reader would otherwise have to take
 * on trust, without letting the names do work the statistics did not.
 */
function typicalOf(group: Group, unit: string, count = 2): string[] {
  if (!group.names?.length) return [];
  const centre = mean(group.values);
  return group.values
    .map((value, i) => ({ value, name: group.names?.[i] ?? "" }))
    .filter((x) => x.name)
    .sort((a, b) => Math.abs(a.value - centre) - Math.abs(b.value - centre))
    .slice(0, count)
    .map((x) => `${x.name}: ${x.value.toFixed(2)} ${unit} (typical ${group.label})`);
}

function describe(effect: number, unit: string): string {
  return `${effect >= 0 ? "gains" : "loses"} ${Math.abs(effect).toFixed(2)} ${unit}`;
}
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}
export function stdev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}
/**
 * The value at rank `p` through the sample, by the nearest-rank method.
 *
 * Used for floors, so the convention matters: asked for the worst tenth of ten
 * weeks, this returns the worst one. Rounding the other way returns the second
 * worst and quietly flatters every floor it reports.
 */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
