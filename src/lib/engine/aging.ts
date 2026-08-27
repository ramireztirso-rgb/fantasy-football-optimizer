import type { Position } from "@/lib/domain/types";

/**
 * How players gain and lose scoring with age, measured rather than assumed.
 *
 * This exists to make a backward-looking projection usable. Extrapolating a
 * player's own recent seasons carries a defect: it silently assumes he is the
 * same age next year, which is the one thing certain to be false. Left alone it
 * over-rates every thirty-year-old and under-rates every twenty-three-year-old,
 * and the disagreement between it and a real forecast then sorts almost
 * perfectly by age -- which is an aging curve showing through, not an edge.
 *
 * The curve is fitted from the data each time rather than baked in, so it moves
 * with the era. Positions age differently enough that a single curve would be
 * worse than none: receivers decline smoothly from about twenty-five, backs
 * fall off a shelf at twenty-seven, and quarterbacks barely age at all inside
 * the range anyone drafts.
 */

export interface AgeObservation {
  position: Position;
  /** Age during the first of the two seasons. */
  age: number;
  /** Points per game the following season minus this one. */
  delta: number;
}

export interface AgeCurve {
  /** Expected change in points a game between `age` and the season after. */
  step(position: Position, age: number): number;
  /**
   * Expected change between two ages, compounded over the years between.
   * Returns zero when the ages are equal or the direction is backwards.
   */
  between(position: Position, fromAge: number, toAge: number): number;
  /** Ages with enough observations to speak for themselves, by position. */
  coverage(position: Position): number[];
}

/** Ages below this many observations borrow from their neighbours. */
const MIN_OBSERVATIONS = 12;

export function buildAgeCurve(observations: AgeObservation[]): AgeCurve {
  const byPosition = new Map<Position, Map<number, number[]>>();
  for (const o of observations) {
    if (!Number.isFinite(o.age) || !Number.isFinite(o.delta)) continue;
    const forPosition = byPosition.get(o.position) ?? new Map<number, number[]>();
    const bucket = Math.round(o.age);
    forPosition.set(bucket, [...(forPosition.get(bucket) ?? []), o.delta]);
    byPosition.set(o.position, forPosition);
  }

  const curve = new Map<Position, Map<number, number>>();
  for (const [position, byAge] of byPosition) {
    const fitted = new Map<number, number>();
    for (const [age, deltas] of byAge) {
      if (deltas.length < MIN_OBSERVATIONS) continue;
      fitted.set(age, deltas.reduce((a, b) => a + b, 0) / deltas.length);
    }
    curve.set(position, fitted);
  }

  const step = (position: Position, age: number): number => {
    const fitted = curve.get(position);
    if (!fitted?.size) return 0;
    const bucket = Math.round(age);
    const exact = fitted.get(bucket);
    if (exact !== undefined) return exact;
    // Outside the observed range, hold the nearest edge rather than
    // extrapolating a trend off the end of the data -- a receiver of
    // thirty-eight is rare enough that the curve has nothing to say, and
    // inventing a number for him would be the model talking to itself.
    const ages = [...fitted.keys()].sort((a, b) => a - b);
    const nearest = ages.reduce((best, a) =>
      Math.abs(a - bucket) < Math.abs(best - bucket) ? a : best,
    );
    return fitted.get(nearest) ?? 0;
  };

  return {
    step,
    between(position, fromAge, toAge) {
      if (!(toAge > fromAge)) return 0;
      let total = 0;
      for (let age = Math.round(fromAge); age < Math.round(toAge); age++) {
        total += step(position, age);
      }
      return Math.round(total * 100) / 100;
    },
    coverage(position) {
      return [...(curve.get(position)?.keys() ?? [])].sort((a, b) => a - b);
    },
  };
}
