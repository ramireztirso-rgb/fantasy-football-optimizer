import type { Position } from "@/lib/domain/types";

/**
 * ESPN stat-id vocabulary.
 *
 * Important scoping note: this map is used for *labelling and explanation*,
 * never as the authority on how many points something is worth. ESPN already
 * applies each league's own scoring rules and reports the result in
 * `appliedStats` / `appliedTotal` on every stat block, so those are treated as
 * truth. This map exists so the app can say "62% of his points came from
 * receptions" rather than showing a bare number.
 *
 * The offensive and defensive ids below are well established. Kicking ids are
 * less consistently documented, so anything unmapped degrades to
 * "stat <id>" rather than a wrong label.
 */

export interface StatMeta {
  label: string;
  category: "passing" | "rushing" | "receiving" | "turnover" | "kicking" | "defense" | "misc";
  /** Per-unit values above this are usually a deliberate league customization. */
  standard?: number;
}

export const STAT_META: Record<number, StatMeta> = {
  0: { label: "Pass attempts", category: "passing", standard: 0 },
  1: { label: "Completions", category: "passing", standard: 0 },
  2: { label: "Incompletions", category: "passing", standard: 0 },
  3: { label: "Passing yards", category: "passing", standard: 0.04 },
  4: { label: "Passing TD", category: "passing", standard: 4 },
  19: { label: "2-pt pass", category: "passing", standard: 2 },
  20: { label: "Interceptions thrown", category: "turnover", standard: -2 },

  23: { label: "Rush attempts", category: "rushing", standard: 0 },
  24: { label: "Rushing yards", category: "rushing", standard: 0.1 },
  25: { label: "Rushing TD", category: "rushing", standard: 6 },
  26: { label: "2-pt rush", category: "rushing", standard: 2 },

  42: { label: "Receiving yards", category: "receiving", standard: 0.1 },
  43: { label: "Receiving TD", category: "receiving", standard: 6 },
  44: { label: "2-pt reception", category: "receiving", standard: 2 },
  53: { label: "Receptions", category: "receiving", standard: 0 },
  58: { label: "Targets", category: "receiving", standard: 0 },

  // First downs. ESPN numbers these in its usual passing -> rushing ->
  // receiving order, and the platform pays nothing for any of them by default,
  // so a league that scores them is always doing so deliberately.
  211: { label: "Passing first downs", category: "passing", standard: 0 },
  212: { label: "Rushing first downs", category: "rushing", standard: 0 },
  213: { label: "Receiving first downs", category: "receiving", standard: 0 },

  68: { label: "Fumbles", category: "turnover", standard: 0 },
  72: { label: "Fumbles lost", category: "turnover", standard: -2 },

  83: { label: "Field goals made", category: "kicking", standard: 3 },
  84: { label: "Field goals attempted", category: "kicking", standard: 0 },
  85: { label: "Field goals missed", category: "kicking", standard: -1 },
  86: { label: "Extra points made", category: "kicking", standard: 1 },
  88: { label: "Extra points missed", category: "kicking", standard: -1 },

  89: { label: "0 points allowed", category: "defense", standard: 5 },
  90: { label: "1-6 points allowed", category: "defense", standard: 4 },
  91: { label: "7-13 points allowed", category: "defense", standard: 3 },
  92: { label: "14-17 points allowed", category: "defense", standard: 1 },
  95: { label: "Defensive interceptions", category: "defense", standard: 2 },
  96: { label: "Fumbles recovered", category: "defense", standard: 2 },
  97: { label: "Blocked kicks", category: "defense", standard: 2 },
  98: { label: "Safeties", category: "defense", standard: 2 },
  99: { label: "Sacks", category: "defense", standard: 1 },
  103: { label: "Kickoff return TD", category: "defense", standard: 6 },
  104: { label: "Punt return TD", category: "defense", standard: 6 },
  105: { label: "Interception return TD", category: "defense", standard: 6 },
  106: { label: "Fumble return TD", category: "defense", standard: 6 },
  120: { label: "Points allowed", category: "defense", standard: 0 },
  121: { label: "18-21 points allowed", category: "defense", standard: 0 },
  122: { label: "22-27 points allowed", category: "defense", standard: -1 },
  123: { label: "28-34 points allowed", category: "defense", standard: -3 },
  124: { label: "35-45 points allowed", category: "defense", standard: -5 },
  127: { label: "Yards allowed", category: "defense", standard: 0 },
};

export function statLabel(statId: number): string {
  return STAT_META[statId]?.label ?? `Stat ${statId}`;
}

/**
 * ESPN position ids, which are what `pointsOverrides` is keyed by.
 *
 * This is the crux of the whole module. An override map like
 * `{"1": 6, "2": 5.5, "3": 5.5, "4": 5.5}` is not one value under an opaque
 * key -- it is a league saying a rushing touchdown pays a quarterback six
 * points and everybody else five and a half. Key 16 is D/ST, which is why
 * defensive rules appear to have a single override: only one position can
 * record a sack.
 */
const POSITION_ID: Record<Position, number> = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DST: 16 };

/**
 * The position a stat category belongs to, used to pick a representative value
 * when a caller asks what a rule is worth without naming a position.
 */
const HOME_POSITION: Partial<Record<StatMeta["category"], Position>> = {
  passing: "QB",
  rushing: "RB",
  receiving: "WR",
  kicking: "K",
  defense: "DST",
};

/**
 * Every position-specific value a scoring item carries, or null when the rule
 * pays the same regardless of who records it.
 *
 * A position absent from the map is not missing data: it is the league
 * declining to pay that position for this stat at all. Leagues that give
 * receivers half a point per catch but running backs nothing express it
 * exactly this way, and reading it as "unknown, assume the default" inverts
 * the rule.
 */
export function scoringPointsByPosition(item: {
  points?: number;
  pointsOverrides?: Record<string, number>;
}): Partial<Record<Position, number>> | null {
  const overrides = item.pointsOverrides;
  if (!overrides) return null;

  const byPosition: Partial<Record<Position, number>> = {};
  let sawAny = false;
  for (const [pos, id] of Object.entries(POSITION_ID) as Array<[Position, number]>) {
    const value = overrides[String(id)];
    if (typeof value === "number") {
      byPosition[pos] = value;
      sawAny = true;
    } else {
      byPosition[pos] = 0;
    }
  }
  return sawAny ? byPosition : null;
}

/**
 * The point value a scoring item actually carries in this league.
 *
 * ESPN keeps the platform default in `points` and puts a league's customized
 * value in `pointsOverrides`. When a league customizes a rule, `points` is
 * frequently left at the default (often 0), so reading `points` alone silently
 * misreads every custom rule in the league.
 *
 * Pass `position` whenever the answer could depend on it -- which, in a league
 * that scores by position, is every offensive rule. Without one this returns a
 * representative value: the shared value if the positions agree, otherwise
 * whatever the stat's home position earns, since "what is a rushing touchdown
 * worth" most usefully means "worth to a running back".
 */
export function effectiveScoringPoints(
  item: {
    statId?: number;
    points?: number;
    pointsOverrides?: Record<string, number>;
  },
  position?: Position,
): number {
  const byPosition = scoringPointsByPosition(item);
  if (!byPosition) return item.points ?? 0;

  if (position) return byPosition[position] ?? 0;

  const present = Object.values(item.pointsOverrides ?? {}).filter((v) => typeof v === "number");
  if (present.length && present.every((v) => v === present[0])) return present[0];

  const category = item.statId === undefined ? undefined : STAT_META[item.statId]?.category;
  const home = category ? HOME_POSITION[category] : undefined;
  if (home && byPosition[home] !== undefined) return byPosition[home] as number;

  return item.points ?? 0;
}
