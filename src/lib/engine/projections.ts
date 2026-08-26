import { availabilityMultiplier } from "@/lib/espn/constants";
import type { Player, Position } from "@/lib/domain/types";
import { ReasonBuilder, type Reason } from "./explain";

/**
 * ESPN's own weekly projection is the starting point -- it already encodes the
 * league's scoring settings, which is worth more than any model we could fit
 * from the outside. What it does *not* encode well is availability, recent
 * usage, and role change, so this module adjusts for those and reports each
 * adjustment as a reason.
 */

export interface Projection {
  player: Player;
  /** Adjusted expected points for the target week. */
  points: number;
  /** ~20th percentile outcome. */
  floor: number;
  /** ~80th percentile outcome. */
  ceiling: number;
  /** Standard deviation used to derive floor/ceiling. */
  volatility: number;
  reasons: Reason[];
}

/**
 * Typical week-to-week coefficient of variation by position, used when a player
 * has too short a game log to measure their own volatility.
 */
const DEFAULT_CV: Record<Position, number> = {
  QB: 0.32,
  RB: 0.52,
  WR: 0.58,
  TE: 0.62,
  K: 0.45,
  DST: 0.68,
};

export interface ProjectionOptions {
  week: number;
  /** How strongly recent form is allowed to move the projection, 0-1. */
  formWeight?: number;
  /**
   * Treats a bye week as a normal week.
   *
   * Used to answer "is this player better than mine in general", separately
   * from "is this player better than mine *this* week". Without the split, a
   * replacement-level fill-in for a bye looks like a season-long upgrade.
   */
  ignoreBye?: boolean;
}

export function projectPlayer(player: Player, opts: ProjectionOptions): Projection {
  const formWeight = opts.formWeight ?? 0.25;
  const b = new ReasonBuilder();
  const base = player.projectedPoints;

  b.setBase(
    base,
    "espn_projection",
    "ESPN projection",
    `ESPN projects ${base.toFixed(1)} points in week ${opts.week} under this league's scoring.`,
  );

  // --- Bye week: a hard zero, not a discount. ---
  if (player.byeWeek === opts.week && !opts.ignoreBye) {
    b.add(
      "bye_week",
      "On bye",
      `${player.proTeam} is on bye in week ${opts.week}, so this player cannot score.`,
      -base,
    );
    const reasons = b.build();
    return { player, points: 0, floor: 0, ceiling: 0, volatility: 0, reasons };
  }

  // --- Availability ---
  const availability = availabilityMultiplier(player.injuryStatus);
  if (availability < 1) {
    const loss = base * (1 - availability);
    b.add(
      "injury",
      `Listed ${formatStatus(player.injuryStatus)}`,
      `Listed ${formatStatus(player.injuryStatus)}, which historically costs about ${Math.round((1 - availability) * 100)}% of expected production once you account for missed and limited games.`,
      -loss,
    );
  }

  // --- Recent form, regressed toward the projection ---
  const form = recentForm(player);
  if (form) {
    const delta = (form.recentAverage - form.seasonAverage) * formWeight;
    if (Math.abs(delta) >= 0.05) {
      const trending = delta > 0 ? "above" : "below";
      b.add(
        "recent_form",
        delta > 0 ? "Trending up" : "Trending down",
        `Averaging ${form.recentAverage.toFixed(1)} over the last ${form.window} games versus ${form.seasonAverage.toFixed(1)} on the season, ${trending} their own baseline.`,
        delta,
      );
    }
  }

  // --- Role change, read from league-wide start rate ---
  // A player whose ownership is climbing fast is usually absorbing snaps that
  // the projection has not caught up to yet.
  if (player.percentOwnedDelta >= 5) {
    const bump = Math.min(1.5, base * 0.04 * (player.percentOwnedDelta / 10));
    b.add(
      "rising_role",
      "Role expanding",
      `Rostered in ${player.percentOwnedDelta.toFixed(0)}% more leagues than a week ago, which usually means a role change the projection has not fully priced in.`,
      bump,
    );
  } else if (player.percentOwnedDelta <= -5 && player.percentOwned > 20) {
    const drop = Math.min(1.5, base * 0.04 * (Math.abs(player.percentOwnedDelta) / 10));
    b.add(
      "shrinking_role",
      "Role shrinking",
      `Being dropped across the league (${player.percentOwnedDelta.toFixed(0)}% this week), a common early signal of lost snaps.`,
      -drop,
    );
  }

  const points = Math.max(0, b.total());
  const volatility = estimateVolatility(player, points);

  return {
    player,
    points: round2(points),
    // 20th/80th percentile under a normal approximation is roughly +/- 0.84 sd.
    floor: round2(Math.max(0, points - 0.84 * volatility)),
    ceiling: round2(points + 0.84 * volatility),
    volatility: round2(volatility),
    reasons: b.build(),
  };
}

export function projectAll(players: Player[], opts: ProjectionOptions): Projection[] {
  return players.map((p) => projectPlayer(p, opts));
}

interface RecentForm {
  recentAverage: number;
  seasonAverage: number;
  window: number;
}

/** Trailing-3 versus season average. Null until there is enough of a log to mean anything. */
export function recentForm(player: Player, window = 3): RecentForm | null {
  const log = player.gameLog;
  if (log.length < window + 1) return null;
  const recent = log.slice(-window);
  const recentAverage = recent.reduce((s, g) => s + g.points, 0) / recent.length;
  const seasonAverage = log.reduce((s, g) => s + g.points, 0) / log.length;
  return { recentAverage, seasonAverage, window };
}

/**
 * Standard deviation of weekly scoring. Uses the player's own log once it is
 * long enough to be meaningful, otherwise a position-typical spread.
 */
export function estimateVolatility(player: Player, mean: number): number {
  const log = player.gameLog;
  if (log.length >= 4) {
    const avg = log.reduce((s, g) => s + g.points, 0) / log.length;
    const variance = log.reduce((s, g) => s + (g.points - avg) ** 2, 0) / (log.length - 1);
    return Math.sqrt(variance);
  }
  return mean * DEFAULT_CV[player.position];
}

function formatStatus(status: string | undefined): string {
  if (!status) return "active";
  return status.replace(/_/g, " ").toLowerCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
