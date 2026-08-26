import { SLOT_ELIGIBILITY } from "@/lib/espn/constants";
import type { LeagueSettings, Player, Team } from "@/lib/domain/types";
import { FORBIDDEN, minCostAssignment } from "./assignment";
import { ReasonBuilder, type Reason } from "./explain";
import { projectPlayer, type Projection, type ProjectionOptions } from "./projections";

/**
 * Start/sit optimization.
 *
 * The output is not just an optimal lineup but the *diff* against what is
 * currently set, because that is the only part a manager has to act on.
 */

export interface LineupAssignment {
  slot: string;
  projection: Projection | null;
}

export interface LineupChange {
  slot: string;
  benchPlayer: Player;
  startingPlayer: Player | null;
  /** Expected points gained by making this single swap. */
  gain: number;
  reasons: Reason[];
}

export interface LineupResult {
  week: number;
  optimal: LineupAssignment[];
  optimalPoints: number;
  currentPoints: number;
  /** Points left on the bench by the lineup as currently set. */
  pointsLeftOnBench: number;
  changes: LineupChange[];
  /** Problems that are not swaps, e.g. a starter on bye with no replacement. */
  warnings: Reason[];
}

/** Expands `2 x RB` into two independent RB slot instances. */
export function expandSlots(settings: LeagueSettings): string[] {
  const slots: string[] = [];
  for (const { slot, count } of settings.lineupSlots) {
    for (let i = 0; i < count; i++) slots.push(slot);
  }
  return slots;
}

function eligibleForSlot(player: Player, slot: string): boolean {
  // Trust ESPN's own eligibility list first -- it handles oddities like a WR
  // who is also RB-eligible. Fall back to the position table when absent.
  if (player.eligibleSlots.length) return player.eligibleSlots.includes(slot);
  return (SLOT_ELIGIBILITY[slot] ?? []).includes(player.position);
}

export function optimizeLineup(
  team: Team,
  settings: LeagueSettings,
  opts: ProjectionOptions,
): LineupResult {
  const slots = expandSlots(settings);
  // IR-slotted players are not startable and must not be offered as swaps.
  const roster = team.roster.filter((r) => r.slot !== "IR" && r.slot !== "ER");
  const projections = roster.map((r) => projectPlayer(r.player, opts));
  const byPlayerId = new Map(projections.map((p) => [p.player.id, p]));

  const result: LineupResult = {
    week: opts.week,
    optimal: [],
    optimalPoints: 0,
    currentPoints: 0,
    pointsLeftOnBench: 0,
    changes: [],
    warnings: [],
  };

  if (!slots.length || !projections.length) return result;

  // Rows are slots, columns are players. Pad columns with unfillable dummies
  // when the roster is shorter than the lineup so matching stays well-formed.
  const columns = Math.max(slots.length, projections.length);
  const cost: number[][] = slots.map((slot) =>
    Array.from({ length: columns }, (_, j) => {
      const proj = projections[j];
      if (!proj) return FORBIDDEN; // dummy player: leaves the slot empty
      if (!eligibleForSlot(proj.player, slot)) return FORBIDDEN;
      return -proj.points;
    }),
  );

  const assignment = minCostAssignment(cost);

  for (let i = 0; i < slots.length; i++) {
    const col = assignment[i];
    const proj = col >= 0 && cost[i][col] < FORBIDDEN ? projections[col] ?? null : null;
    result.optimal.push({ slot: slots[i], projection: proj });
    if (proj) result.optimalPoints += proj.points;
  }
  result.optimalPoints = round2(result.optimalPoints);

  // --- Current lineup, for comparison ---
  const currentStarters = roster.filter((r) => !r.benched);
  result.currentPoints = round2(
    currentStarters.reduce((s, r) => s + (byPlayerId.get(r.player.id)?.points ?? 0), 0),
  );
  result.pointsLeftOnBench = round2(result.optimalPoints - result.currentPoints);

  // --- The actionable diff ---
  const optimalIds = new Set(
    result.optimal.map((a) => a.projection?.player.id).filter((id): id is number => id !== undefined),
  );
  const currentIds = new Set(currentStarters.map((r) => r.player.id));

  const shouldStart = result.optimal.filter(
    (a) => a.projection && !currentIds.has(a.projection.player.id),
  );
  const shouldSit = currentStarters.filter((r) => !optimalIds.has(r.player.id));

  // Pair each promotion with the demotion it displaces, best gain first.
  const sitQueue = [...shouldSit].sort(
    (a, b) => (byPlayerId.get(a.player.id)?.points ?? 0) - (byPlayerId.get(b.player.id)?.points ?? 0),
  );

  for (const promotion of shouldStart) {
    const inProj = promotion.projection;
    if (!inProj) continue;
    const demoted = sitQueue.shift() ?? null;
    const outProj = demoted ? byPlayerId.get(demoted.player.id) ?? null : null;
    const gain = round2(inProj.points - (outProj?.points ?? 0));
    if (gain <= 0.01) continue;

    result.changes.push({
      slot: promotion.slot,
      benchPlayer: inProj.player,
      startingPlayer: demoted?.player ?? null,
      gain,
      reasons: explainSwap(inProj, outProj, promotion.slot, gain, opts.week),
    });
  }
  result.changes.sort((a, b) => b.gain - a.gain);

  // --- Warnings that are not swaps ---
  for (const starter of currentStarters) {
    const proj = byPlayerId.get(starter.player.id);
    if (!proj) continue;
    if (starter.player.byeWeek === opts.week) {
      result.warnings.push({
        code: "starter_on_bye",
        label: "Starter on bye",
        detail: `${starter.player.name} is on bye in week ${opts.week} and will score zero in your ${starter.slot} slot.`,
        impact: 0,
        direction: "negative",
      });
    } else if (isOut(starter.player.injuryStatus)) {
      result.warnings.push({
        code: "starter_out",
        label: "Starter ruled out",
        detail: `${starter.player.name} is listed ${formatStatus(starter.player.injuryStatus)} and is in your starting ${starter.slot} slot.`,
        impact: 0,
        direction: "negative",
      });
    }
  }

  return result;
}

function explainSwap(
  incoming: Projection,
  outgoing: Projection | null,
  slot: string,
  gain: number,
  week: number,
): Reason[] {
  const b = new ReasonBuilder();
  b.setBase(
    gain,
    "swap_gain",
    "Net gain",
    outgoing
      ? `Starting ${incoming.player.name} over ${outgoing.player.name} in your ${slot} slot is worth about ${gain.toFixed(1)} points this week.`
      : `${incoming.player.name} fills an empty ${slot} slot, worth about ${gain.toFixed(1)} points.`,
  );

  if (outgoing) {
    if (outgoing.player.byeWeek === week) {
      b.note(
        "out_on_bye",
        "Replaces a bye",
        `${outgoing.player.name} is on bye, so the slot is currently scoring nothing.`,
      );
    }
    if (isOut(outgoing.player.injuryStatus)) {
      b.note(
        "out_injured",
        "Replaces an injured starter",
        `${outgoing.player.name} is listed ${formatStatus(outgoing.player.injuryStatus)}.`,
      );
    }
    if (incoming.floor > outgoing.ceiling) {
      b.note(
        "dominates",
        "Strictly safer",
        `${incoming.player.name}'s floor (${incoming.floor.toFixed(1)}) is above ${outgoing.player.name}'s ceiling (${outgoing.ceiling.toFixed(1)}), so this is not a close call.`,
      );
    } else if (incoming.volatility > outgoing.volatility * 1.5) {
      b.note(
        "higher_variance",
        "Higher variance",
        `${incoming.player.name} is the boom-or-bust option here (floor ${incoming.floor.toFixed(1)}, ceiling ${incoming.ceiling.toFixed(1)}); prefer them when you need upside, not when protecting a lead.`,
      );
    }
  }

  // Surface the strongest driver from the underlying projection so the swap
  // explains *why* the projection moved, not just that it did.
  const driver = incoming.reasons.find((r) => r.impact !== 0 && r.code !== "espn_projection");
  if (driver) {
    b.note(
      `driver_${driver.code}`,
      `${incoming.player.name}: ${driver.label.toLowerCase()}`,
      driver.detail,
    );
  }

  return b.build();
}

function isOut(status: string | undefined): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s === "OUT" || s === "INJURY_RESERVE" || s === "SUSPENSION" || s === "NOT_ACTIVE";
}

function formatStatus(status: string | undefined): string {
  return (status ?? "active").replace(/_/g, " ").toLowerCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
