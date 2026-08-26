/**
 * ESPN's fantasy API speaks entirely in numeric IDs. These maps are the
 * Rosetta Stone for the rest of the app -- everything past `normalize.ts`
 * works in human-readable strings.
 */

/** `player.defaultPositionId` -> position. */
export const POSITION_BY_ID: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "DST",
};

/**
 * `lineupSlotId` -> slot. A slot is *where a player can be started*, which is
 * deliberately not the same thing as their position (FLEX accepts three).
 */
export const SLOT_BY_ID: Record<number, string> = {
  0: "QB",
  1: "TQB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  8: "DT",
  9: "DE",
  10: "LB",
  11: "DL",
  12: "CB",
  13: "S",
  14: "DB",
  15: "DP",
  16: "DST",
  17: "K",
  18: "P",
  19: "HC",
  20: "BE",
  21: "IR",
  23: "FLEX",
  24: "ER",
};

export const BENCH_SLOT_IDS = new Set([20, 21, 24]);

/** Which positions each startable slot will accept. */
export const SLOT_ELIGIBILITY: Record<string, string[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DST: ["DST"],
  FLEX: ["RB", "WR", "TE"],
  "RB/WR": ["RB", "WR"],
  "WR/TE": ["WR", "TE"],
  OP: ["QB", "RB", "WR", "TE"], // superflex
  TQB: ["QB"],
};

export const PRO_TEAM_BY_ID: Record<number, string> = {
  0: "FA",
  1: "ATL",
  2: "BUF",
  3: "CHI",
  4: "CIN",
  5: "CLE",
  6: "DAL",
  7: "DEN",
  8: "DET",
  9: "GB",
  10: "TEN",
  11: "IND",
  12: "KC",
  13: "LV",
  14: "LAR",
  15: "MIA",
  16: "MIN",
  17: "NE",
  18: "NO",
  19: "NYG",
  20: "NYJ",
  21: "PHI",
  22: "ARI",
  23: "PIT",
  24: "LAC",
  25: "SF",
  26: "SEA",
  27: "TB",
  28: "WSH",
  29: "CAR",
  30: "JAX",
  33: "BAL",
  34: "HOU",
};

/**
 * ESPN reports availability on the *player* (`injuryStatus`) and sometimes on
 * the roster entry. Anything not in this map is treated as ACTIVE.
 */
export const INJURY_SEVERITY: Record<string, number> = {
  ACTIVE: 0,
  NORMAL: 0,
  PROBABLE: 0.02,
  QUESTIONABLE: 0.25,
  DOUBTFUL: 0.6,
  OUT: 1,
  INJURY_RESERVE: 1,
  SUSPENSION: 1,
  DAY_TO_DAY: 0.15,
  NOT_ACTIVE: 1,
};

/** Fraction of projected points a player is expected to retain, by status. */
export function availabilityMultiplier(status: string | undefined): number {
  if (!status) return 1;
  const severity = INJURY_SEVERITY[status.toUpperCase()] ?? 0;
  return 1 - severity;
}

/** `statSourceId` on a stat block. */
export const STAT_SOURCE = { ACTUAL: 0, PROJECTED: 1 } as const;
/** `statSplitTypeId` on a stat block. */
export const STAT_SPLIT = { SEASON: 0, WEEK: 1 } as const;

/** ESPN transaction/availability status strings used by the player filter. */
export const AVAILABILITY = {
  FREEAGENT: "FREEAGENT",
  WAIVERS: "WAIVERS",
  ONTEAM: "ONTEAM",
} as const;
