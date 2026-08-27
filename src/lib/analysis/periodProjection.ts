import type { LeagueSettings, Position } from "@/lib/domain/types";
import type { SeasonStatLine } from "@/lib/sources/nflverse";
import { componentProjection, positionalBaselines } from "@/lib/engine/componentProjection";
import { buildAgeCurve, type AgeObservation } from "@/lib/engine/aging";
import { scoreStatLine } from "@/lib/engine/scoreFromStats";
import { ageAtSeason, type PlayerIdentity } from "@/lib/sources/playerIds";

/**
 * A projection for a past season built only from what August of that season
 * knew.
 *
 * This exists so the draft board can be judged against reality. Judging it
 * needs a board that could have existed at the time, and ESPN's projections
 * for past Augusts are not retrievable -- so this rebuilds the next-best
 * thing from first principles: each player's own prior production, scored
 * under this league's rules, aged forward on a curve fitted only to seasons
 * already played, shrunk by the calibrated amount. No number in here can see
 * past the season being projected; that is the entire point, and the reason
 * this module takes a hard cutoff season everywhere.
 *
 * Players with no usable history -- rookies above all -- get the market's
 * implied expectation instead: what players drafted at that slot and position
 * historically went on to score, fitted from prior seasons only. That is
 * honest about what an August drafter actually knows about a rookie, which is
 * his price.
 */

export interface PeriodProjection {
  points: number;
  /** "component" from his own record, "market" from his draft slot. */
  basis: "component" | "market";
}

export interface PeriodProjector {
  project(args: {
    gsisId: string | undefined;
    identity: PlayerIdentity | undefined;
    position: Position;
    adp: number;
  }): PeriodProjection;
}

/** Realized points by draft slot, the market-implied fallback. */
interface AdpOutcome {
  position: Position;
  adp: number;
  points: number;
}

export function buildPeriodProjector(
  targetSeason: number,
  history: Map<string, SeasonStatLine[]>,
  settings: LeagueSettings,
  adpOutcomes: AdpOutcome[],
): PeriodProjector {
  // Everything below filters to seasons strictly before the target. A single
  // leak here invalidates the whole evaluation, so the filter happens once,
  // at the entrance.
  const prior = new Map<string, SeasonStatLine[]>();
  for (const [gsisId, lines] of history) {
    const kept = lines.filter((l) => l.season < targetSeason);
    if (kept.length) prior.set(gsisId, kept);
  }

  const byPosition = new Map<Position, SeasonStatLine[]>();
  const rateByKey = new Map<string, number>();
  for (const lines of prior.values()) {
    for (const line of lines) {
      if (!["QB", "RB", "WR", "TE"].includes(line.position)) continue;
      byPosition.set(line.position as Position, [
        ...(byPosition.get(line.position as Position) ?? []),
        line,
      ]);
      if (line.games >= 8) {
        const rate = scoreStatLine(line, settings, line.position as Position).pointsPerGame;
        if (rate > 0) rateByKey.set(`${line.season}:${line.gsisId}`, rate);
      }
    }
  }
  const baselines = positionalBaselines(byPosition, settings);

  // The aging curve, fitted only on pairs that finished before the target.
  const observations: AgeObservation[] = [];
  const identityByGsis = new Map<string, PlayerIdentity>();
  const curve = {
    holder: buildAgeCurve(observations),
  };
  const fitCurve = (identities: Map<string, PlayerIdentity>) => {
    for (const [key, rate] of rateByKey) {
      const [seasonText, gsisId] = key.split(":");
      const season = Number(seasonText);
      if (season + 1 >= targetSeason) continue;
      const next = rateByKey.get(`${season + 1}:${gsisId}`);
      if (next === undefined) continue;
      const identity = identities.get(gsisId);
      if (!identity?.position) continue;
      const age = ageAtSeason(identity, season);
      if (age === null) continue;
      observations.push({ position: identity.position as Position, age, delta: next - rate });
    }
    curve.holder = buildAgeCurve(observations);
  };

  // Market-implied expectation: median realized points by ADP band and
  // position, from prior seasons only. Bands rather than a fit, because a
  // handful of samples per exact slot would make a fit hallucinate.
  const bands = new Map<string, number[]>();
  for (const outcome of adpOutcomes) {
    const band = `${outcome.position}:${Math.min(12, Math.ceil(outcome.adp / 12))}`;
    bands.set(band, [...(bands.get(band) ?? []), outcome.points]);
  }
  const marketExpectation = (position: Position, adp: number): number => {
    for (let band = Math.min(12, Math.ceil(adp / 12)); band <= 12; band++) {
      const values = bands.get(`${position}:${band}`);
      if (values && values.length >= 5) {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      }
    }
    return 0;
  };

  return {
    project({ gsisId, identity, position, adp }) {
      if (identity && gsisId && !identityByGsis.has(gsisId)) {
        identityByGsis.set(gsisId, identity);
        // Refit lazily once identities are known; cheap relative to the sims.
        if (identityByGsis.size % 50 === 1) fitCurve(identityByGsis);
      }
      const lines = gsisId ? prior.get(gsisId) : undefined;
      if (lines?.length && identity) {
        const ageBySeason = new Map<number, number>();
        for (const line of lines) {
          const was = ageAtSeason(identity, line.season);
          if (was !== null) ageBySeason.set(line.season, was);
        }
        const targetAge = ageAtSeason(identity, targetSeason);
        const own = componentProjection(
          lines,
          settings,
          position,
          (baselines[position] as number | undefined) ?? 0,
          targetAge !== null && ageBySeason.size
            ? {
                ageBySeason,
                targetAge,
                between: (from, to) => curve.holder.between(position, from, to),
              }
            : undefined,
        );
        if (own && own.gamesOfHistory >= 8) {
          return { points: own.points, basis: "component" };
        }
      }
      return { points: marketExpectation(position, adp), basis: "market" };
    },
  };
}
