import type { LeagueSettings, Player, Position } from "@/lib/domain/types";
import { STAT_META, statLabel, type StatMeta } from "@/lib/espn/stats";
import { starterDemand } from "./replacement";

/**
 * What this league's rules do to player value.
 *
 * Custom scoring is usually treated as a formatting detail -- the numbers just
 * come out different. It is not. A league that pays 6 points for a passing
 * touchdown and half a point per reception has materially different positional
 * scarcity than the default, and the edge goes to whoever prices that in before
 * the draft.
 *
 * Every impact below is measured against the platform default and multiplied by
 * this league's *observed* per-game stat volume where the data supports it,
 * rather than against an assumed baseline.
 */

export interface ScoringDeviation {
  statId: number;
  label: string;
  leaguePoints: number;
  standardPoints: number;
  /** Positive means this league pays more than standard. */
  delta: number;
  /** Estimated points per game this adds to a typical starter at `position`. */
  perGameImpact: number;
  position: Position;
  detail: string;
}

export interface RosterDeviation {
  position: Position;
  /** Players started league-wide each week at this position. */
  leagueStarters: number;
  /** What a default 1QB/2RB/2WR/1TE/1FLEX league of this size would start. */
  standardStarters: number;
  detail: string;
}

/**
 * A rule the league prices differently depending on who records the stat.
 *
 * This is the format detail most likely to be missed, because nothing on the
 * league page looks unusual: the headline still reads "half PPR". Only when
 * you notice that running backs are excluded from it does the draft board
 * change shape.
 */
export interface PositionScopedRule {
  statId: number;
  label: string;
  /** Points per unit at each position that earns anything for this stat. */
  paid: Array<{ position: Position; points: number }>;
  /** Positions the league pays nothing for this stat, despite others earning. */
  excluded: Position[];
  detail: string;
}

export interface ScoringProfile {
  /** One-line characterization, e.g. "12-team, 0.5 PPR, 6-point passing TDs". */
  summary: string;
  deviations: ScoringDeviation[];
  rosterDeviations: RosterDeviation[];
  /** Rules whose value depends on the position of the player who earned it. */
  positionScoped: PositionScopedRule[];
  /** Ranked strategic consequences, most actionable first. */
  implications: string[];
  /** True when nothing meaningfully departs from the default rule set. */
  isStandard: boolean;
}

/**
 * Per-game volume for a typical weekly starter, used to convert a per-unit
 * scoring change into points. These are fallbacks: `observedVolume` replaces
 * them with this league's real data whenever the sample supports it.
 */
const BASELINE_VOLUME: Record<number, { position: Position; perGame: number }> = {
  3: { position: "QB", perGame: 250 },   // passing yards
  4: { position: "QB", perGame: 1.6 },   // passing TD
  20: { position: "QB", perGame: 0.7 },  // interceptions
  1: { position: "QB", perGame: 22 },    // completions
  24: { position: "RB", perGame: 65 },   // rushing yards
  25: { position: "RB", perGame: 0.5 },  // rushing TD
  23: { position: "RB", perGame: 14 },   // carries
  42: { position: "WR", perGame: 65 },   // receiving yards
  43: { position: "WR", perGame: 0.45 }, // receiving TD
  53: { position: "WR", perGame: 4.5 },  // receptions
  58: { position: "WR", perGame: 6.5 },  // targets
  72: { position: "RB", perGame: 0.15 }, // fumbles lost
};

export function buildScoringProfile(
  settings: LeagueSettings,
  pool: Player[] = [],
): ScoringProfile {
  const deviations: ScoringDeviation[] = [];
  const volume = observedVolume(pool);

  for (const rule of settings.scoringRules) {
    const meta = STAT_META[rule.statId];
    const standard = rule.standard ?? meta?.standard;
    if (standard === undefined) continue;

    const baseline = BASELINE_VOLUME[rule.statId];
    if (!baseline) continue;

    // Price the rule at the position whose volume we are about to multiply it
    // by. Using the representative value instead would measure a receiver's
    // catches at a quarterback's rate in any league that separates them.
    const points = rule.pointsByPosition?.[baseline.position] ?? rule.points;
    const delta = round3(points - standard);
    if (Math.abs(delta) < 0.001) continue;

    const perGame = volume.get(rule.statId) ?? baseline.perGame;
    const perGameImpact = round2(delta * perGame);
    if (Math.abs(perGameImpact) < 0.15) continue;

    deviations.push({
      statId: rule.statId,
      label: statLabel(rule.statId),
      leaguePoints: points,
      standardPoints: standard,
      delta,
      perGameImpact,
      position: baseline.position,
      detail: `${statLabel(rule.statId)} is worth ${formatPoints(points)} here versus ${formatPoints(standard)} standard. At the ${baseline.position} volume in your league that is ${perGameImpact > 0 ? "+" : ""}${perGameImpact.toFixed(1)} points per game for a typical starter.`,
    });
  }

  deviations.sort((a, b) => Math.abs(b.perGameImpact) - Math.abs(a.perGameImpact));

  const rosterDeviations = analyzeRosterShape(settings);
  const positionScoped = analyzePositionScoping(settings);
  return {
    summary: summarize(settings),
    deviations,
    rosterDeviations,
    positionScoped,
    implications: buildImplications(settings, deviations, rosterDeviations, positionScoped),
    isStandard:
      deviations.length === 0 && rosterDeviations.length === 0 && positionScoped.length === 0,
  };
}

/**
 * Per-game stat volume actually observed in this league's data.
 *
 * Uses the median rather than the mean so one 300-yard outlier does not set the
 * baseline, and only trusts a stat once enough games carry it.
 */
function observedVolume(pool: Player[], minSample = 25): Map<number, number> {
  const samples = new Map<number, number[]>();
  for (const player of pool) {
    for (const game of player.gameLog) {
      for (const [statId, value] of Object.entries(game.raw)) {
        if (!value) continue;
        const id = Number(statId);
        if (!(id in BASELINE_VOLUME)) continue;
        const list = samples.get(id) ?? [];
        list.push(value);
        samples.set(id, list);
      }
    }
  }

  const out = new Map<number, number>();
  for (const [statId, values] of samples) {
    if (values.length < minSample) continue;
    // Starters, not everyone: take the median of the upper half, which
    // approximates the volume of a player you would actually start.
    const sorted = values.sort((a, b) => a - b);
    const upper = sorted.slice(Math.floor(sorted.length / 2));
    out.set(statId, upper[Math.floor(upper.length / 2)]);
  }
  return out;
}

/** Compares the starting-lineup shape to a conventional one of the same size. */
function analyzeRosterShape(settings: LeagueSettings): RosterDeviation[] {
  const size = settings.size || 12;
  const actual = starterDemand(settings);

  const standardSettings: LeagueSettings = {
    ...settings,
    lineupSlots: [
      { slot: "QB", count: 1 },
      { slot: "RB", count: 2 },
      { slot: "WR", count: 2 },
      { slot: "TE", count: 1 },
      { slot: "FLEX", count: 1 },
      { slot: "DST", count: 1 },
      { slot: "K", count: 1 },
    ],
  };
  const standard = starterDemand(standardSettings);

  const out: RosterDeviation[] = [];
  for (const pos of ["QB", "RB", "WR", "TE"] as Position[]) {
    const diff = actual[pos] - standard[pos];
    if (Math.abs(diff) < size * 0.15) continue;
    out.push({
      position: pos,
      leagueStarters: round1(actual[pos]),
      standardStarters: round1(standard[pos]),
      detail:
        diff > 0
          ? `Your league starts about ${round1(actual[pos])} ${pos}s every week versus ${round1(standard[pos])} in a standard build. That pushes ${pos} replacement level ${Math.abs(diff).toFixed(0)} players deeper, so the position is scarcer than its raw projections suggest.`
          : `Your league starts only about ${round1(actual[pos])} ${pos}s versus ${round1(standard[pos])} standard, so ${pos} is deeper than usual and waiting on it costs less.`,
    });
  }
  return out;
}

function buildImplications(
  settings: LeagueSettings,
  deviations: ScoringDeviation[],
  rosterDeviations: RosterDeviation[],
  positionScoped: PositionScopedRule[] = [],
): string[] {
  const out: string[] = [];

  const passingBoost = deviations
    .filter((d) => d.position === "QB")
    .reduce((s, d) => s + d.perGameImpact, 0);
  if (passingBoost >= 1.5) {
    out.push(
      `Quarterbacks gain roughly ${passingBoost.toFixed(1)} points per game over standard scoring here. That compresses the gap between an elite QB and a streamed one only if the whole position rises together -- check the QB tier cliff on the draft board before deciding whether to pay up.`,
    );
  } else if (passingBoost <= -1.5) {
    out.push(
      `Quarterbacks lose roughly ${Math.abs(passingBoost).toFixed(1)} points per game versus standard. Push QB down your board and stream the position.`,
    );
  }

  // Receptions scoped away from running backs changes the advice completely,
  // so it is checked before the headline PPR bands below.
  const receptionScope = positionScoped.find((r) => r.statId === 53);
  if (receptionScope?.excluded.includes("RB")) {
    out.push(
      `Receptions pay ${receptionScope.paid.map((p) => `${p.position} ${formatPoints(p.points)}`).join(", ")} but nothing to running backs. This is the single most important thing about this league's scoring: pass-catching backs carry none of the PPR premium every ranking list prices into them, while possession receivers and tight ends carry all of it.`,
    );
  }

  const reception = settings.pointsPerReception;
  if (receptionScope?.excluded.includes("RB")) {
    // Already covered above, and the generic bands would contradict it.
  } else if (reception >= 0.9) {
    out.push(
      `Full PPR: volume receivers and pass-catching backs are worth materially more than their yardage suggests. Target share is the stat to draft.`,
    );
  } else if (reception > 0 && reception < 0.9) {
    out.push(
      `Half-PPR (${reception} per catch): the gap between a possession receiver and a big-play one narrows but does not close. Do not price these players as if it were full PPR -- that is the most common mistake in this format.`,
    );
  } else if (reception === 0) {
    out.push(
      `Standard scoring, no PPR: touchdown-dependent backs and deep threats hold their value, and high-reception low-yardage players are traps.`,
    );
  }

  for (const ps of positionScoped) {
    if (ps.statId !== 53) out.push(ps.detail);
  }

  for (const rd of rosterDeviations) out.push(rd.detail);

  if (settings.usesFaab && settings.faabBudget) {
    out.push(
      `FAAB league with a $${settings.faabBudget} budget. Budget is a season-long resource: spending 30% in week 2 on a hot pickup is usually worse than holding for the injury replacement that decides your playoff run.`,
    );
  }

  const totalStarters = settings.lineupSlots.reduce((s, x) => s + x.count, 0);
  const rosterSize = totalStarters + settings.benchSlots;
  if (settings.benchSlots >= 7) {
    out.push(
      `${settings.benchSlots} bench spots on a ${rosterSize}-man roster is deep. Deep benches reward stashing upside and handcuffs, and they thin the waiver wire -- expect fewer useful free agents than a shallow league.`,
    );
  } else if (settings.benchSlots <= 4) {
    out.push(
      `Only ${settings.benchSlots} bench spots. Shallow benches mean a rich waiver wire and no room for stashes; prioritize players who start for you now over lottery tickets.`,
    );
  }

  return out;
}

/**
 * Rules that pay one position differently from another.
 *
 * Only positions that can plausibly record the stat are considered: every
 * league on earth pays a kicker zero receiving yards, and reporting that as a
 * league quirk would bury the one rule that actually matters.
 */
const CAN_RECORD: Partial<Record<StatMeta["category"], Position[]>> = {
  passing: ["QB"],
  rushing: ["QB", "RB", "WR"],
  receiving: ["RB", "WR", "TE"],
  kicking: ["K"],
  defense: ["DST"],
};

function analyzePositionScoping(settings: LeagueSettings): PositionScopedRule[] {
  const out: PositionScopedRule[] = [];

  for (const rule of settings.scoringRules) {
    const byPosition = rule.pointsByPosition;
    if (!byPosition) continue;

    const category = STAT_META[rule.statId]?.category;
    const candidates = category ? CAN_RECORD[category] : undefined;
    if (!candidates || candidates.length < 2) continue;

    const paid = candidates
      .filter((pos) => (byPosition[pos] ?? 0) !== 0)
      .map((pos) => ({ position: pos, points: byPosition[pos] as number }));
    const excluded = candidates.filter((pos) => (byPosition[pos] ?? 0) === 0);

    // Uniform across everyone who could record it is not a quirk.
    if (!paid.length || (!excluded.length && new Set(paid.map((p) => p.points)).size === 1)) {
      continue;
    }

    const paidText = paid.map((p) => `${p.position} ${formatPoints(p.points)}`).join(", ");
    const detail = excluded.length
      ? `${statLabel(rule.statId)} pays ${paidText}, and nothing at all to ${excluded.join(" or ")}. Rankings built for this format's headline scoring will misprice ${excluded.join(" and ")} here.`
      : `${statLabel(rule.statId)} is not worth the same to everyone: ${paidText}.`;

    out.push({ statId: rule.statId, label: statLabel(rule.statId), paid, excluded, detail });
  }
  return out;
}

function summarize(settings: LeagueSettings): string {
  const parts = [`${settings.size}-team`];
  if (settings.pointsPerReception === 1) parts.push("full PPR");
  else if (settings.pointsPerReception > 0) parts.push(`${settings.pointsPerReception} PPR`);
  else parts.push("standard scoring");

  const passTd = settings.scoringRules.find((r) => r.statId === 4)?.points;
  if (passTd !== undefined && passTd !== 4) parts.push(`${passTd}-point passing TDs`);

  parts.push(settings.lineupSlots.map((s) => `${s.count}${s.slot}`).join("/"));
  if (settings.usesFaab && settings.faabBudget) parts.push(`$${settings.faabBudget} FAAB`);
  return parts.join(", ");
}

function formatPoints(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
