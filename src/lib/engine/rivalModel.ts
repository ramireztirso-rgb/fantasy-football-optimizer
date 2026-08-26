import type { LeagueSettings, Player, Position } from "@/lib/domain/types";
import { rosterNeed } from "./replacement";
import type { DraftTendencies } from "./tendencies";

/**
 * A model of how the other eleven people in *this* league draft.
 *
 * National ADP describes the average of millions of drafters. Simulating your
 * league against it answers a question nobody asked: what would happen if you
 * drafted against strangers. The eleven managers you actually play have four
 * years of recorded behaviour, and they do not draft like the market -- this
 * league spends 39% of its early picks on running backs against a market rate
 * of 29%, and punts tight end almost entirely.
 *
 * So the model starts from ADP, because real drafters do mostly follow it, and
 * then bends it by what this league measurably does: how its position mix
 * departs from the market round by round, and how each manager departs from
 * their own league.
 *
 * It is a behavioural model, not a prediction. Nobody can say who team 7 takes
 * at pick 40. What it can say is that team 7 has taken a quarterback in the
 * first three rounds in three of four drafts, so a board that assumes the
 * quarterbacks last is going to be wrong in a specific, repeatable direction.
 */

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/** Rounds for which the historical sample reports a position mix. */
const PROFILED_ROUNDS = 6;

/**
 * How far a single manager's history is allowed to move a pick.
 *
 * Four drafts is a real sample for "does this person reach for quarterbacks"
 * and a hopeless one for anything finer. The clamp keeps a manager who
 * happened to take two tight ends in 2023 from being modelled as a tight end
 * fanatic for eternity.
 */
const MAX_MANAGER_TILT = 2.2;
const MIN_MANAGER_TILT = 0.35;

/** Candidates considered at each pick, in ADP order. */
const CONSIDERATION_WINDOW = 10;

export interface RivalModel {
  /** Position mix this league drafts in each of the profiled rounds. */
  roundMix: Array<Partial<Record<Position, number>>>;
  /** Per-manager multiplier against the league's own early-round baseline. */
  managerTilt: Map<number, Partial<Record<Position, number>>>;
  /** Picks the model was fitted on. */
  sample: number;
  /** True when the sample was too thin to bend ADP at all. */
  isNaive: boolean;
  pick(args: RivalPickArgs): Player | undefined;
}

export interface RivalPickArgs {
  available: Player[];
  teamId: number;
  round: number;
  roster: Player[];
  settings: LeagueSettings;
  rand: () => number;
}

export function buildRivalModel(tendencies: DraftTendencies): RivalModel {
  const sample = tendencies.totalPicks;

  // Position mix by round, straight from the league's own drafts.
  const roundMix: Array<Partial<Record<Position, number>>> = [];
  for (let round = 0; round < PROFILED_ROUNDS; round++) {
    const counts: Partial<Record<Position, number>> = {};
    let total = 0;
    for (const p of tendencies.positions) {
      const n = p.byRound[round] ?? 0;
      counts[p.position] = n;
      total += n;
    }
    const mix: Partial<Record<Position, number>> = {};
    for (const pos of POSITIONS) mix[pos] = total > 0 ? (counts[pos] ?? 0) / total : 0;
    roundMix.push(mix);
  }

  // Each manager measured against their own league rather than the market: the
  // question is who is unusual *here*, in a league that is already unusual.
  const leagueEarly: Partial<Record<Position, number>> = {};
  for (const p of tendencies.positions) leagueEarly[p.position] = p.earlyShare;

  const managerTilt = new Map<number, Partial<Record<Position, number>>>();
  for (const m of tendencies.managers) {
    if (!m.earlyPattern.length) continue;
    const tilt: Partial<Record<Position, number>> = {};
    for (const pos of POSITIONS) {
      const theirs = m.earlyPattern.filter((p) => p === pos).length / m.earlyPattern.length;
      const league = leagueEarly[pos] ?? 0;
      if (league <= 0) continue;
      // Smoothed toward 1: with a dozen early picks per manager, a raw ratio
      // swings far too hard on one or two picks.
      const raw = theirs / league;
      const smoothed = 1 + (raw - 1) * 0.6;
      tilt[pos] = Math.min(MAX_MANAGER_TILT, Math.max(MIN_MANAGER_TILT, smoothed));
    }
    managerTilt.set(m.teamId, tilt);
  }

  // One draft is a coincidence. Below that, decline to bend ADP at all rather
  // than dress a guess up as a measurement.
  const isNaive = tendencies.seasonsAnalyzed.length < 2 || sample < 100;

  return {
    roundMix,
    managerTilt,
    sample,
    isNaive,
    pick({ available, teamId, round, roster, settings, rand }) {
      if (!available.length) return undefined;

      const byAdp = [...available].sort(
        (a, b) => a.averageDraftPosition - b.averageDraftPosition,
      );
      const window = byAdp.slice(0, Math.min(CONSIDERATION_WINDOW, byAdp.length));
      if (isNaive) return window[Math.floor(rand() * window.length)];

      const need = rosterNeed(roster, settings);
      const mix = roundMix[Math.min(round, PROFILED_ROUNDS) - 1];
      const tilt = managerTilt.get(teamId) ?? {};

      // The market's own mix over the same window, used as the denominator so
      // the multiplier expresses departure from ADP rather than raw frequency.
      const marketMix: Partial<Record<Position, number>> = {};
      for (const p of window) marketMix[p.position] = (marketMix[p.position] ?? 0) + 1 / window.length;

      const weights = window.map((player) => {
        const pos = player.position;
        let w = 1;

        if (round <= PROFILED_ROUNDS && mix) {
          const league = mix[pos] ?? 0;
          const market = marketMix[pos] ?? 0;
          // Both near zero means the position is simply not in play here.
          if (market > 0) w *= clamp(league / market, 0.15, 3);
        }

        w *= tilt[pos] ?? 1;

        // Everybody, in every league, prefers a player they can actually start.
        w *= (need[pos] ?? 0) > 0 ? 1.35 : 0.75;

        return Math.max(w, 0.001);
      });

      const total = weights.reduce((a, b) => a + b, 0);
      let roll = rand() * total;
      for (let i = 0; i < window.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return window[i];
      }
      return window[window.length - 1];
    },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
