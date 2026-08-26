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
 * The point value a scoring item actually carries in this league.
 *
 * ESPN keeps the platform default in `points` and puts a league's customized
 * value in `pointsOverrides`, keyed by scoring-rule-set id. When a league
 * customizes a rule, `points` is frequently left at the default (often 0), so
 * reading `points` alone silently misreads every custom rule in the league.
 * The override wins whenever one is present.
 */
export function effectiveScoringPoints(item: {
  points?: number;
  pointsOverrides?: Record<string, number>;
}): number {
  const overrides = item.pointsOverrides;
  if (overrides) {
    // Key 16 is the head-to-head rule set ESPN uses for standard fantasy
    // football leagues; fall back to whatever single override is present.
    if (typeof overrides["16"] === "number") return overrides["16"];
    const values = Object.values(overrides).filter((v) => typeof v === "number");
    if (values.length === 1) return values[0];
  }
  return item.points ?? 0;
}
