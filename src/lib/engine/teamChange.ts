import type { Player } from "@/lib/domain/types";
import type { SeasonStatLine } from "@/lib/sources/nflverse";

/**
 * Whether a player is somewhere new.
 *
 * This exists because it is the precise blind spot of any projection built
 * from a player's own history. Such a model reads three years of production
 * and extrapolates, and it cannot see that the targets it is extrapolating
 * belonged to a different offence, behind a different line, with a different
 * quarterback deciding where the ball goes. It will be confidently wrong in
 * exactly the cases a manager most wants help with.
 *
 * Detecting the move does not fix the projection. It marks it as untrustworthy,
 * which is the honest thing a backward-looking model can do about a change it
 * cannot see.
 */

/**
 * The two sources disagree on two franchises and agree on the other thirty.
 * Left unhandled, every Rams and Commanders player reads as having been traded.
 */
const TEAM_ALIASES: Record<string, string> = {
  LAR: "LA",
  WSH: "WAS",
  JAC: "JAX",
  LVR: "LV",
  ARZ: "ARI",
};

export function normalizeTeam(abbrev: string | undefined): string {
  if (!abbrev) return "";
  const upper = abbrev.toUpperCase();
  return TEAM_ALIASES[upper] ?? upper;
}

export interface TeamChange {
  changed: boolean;
  from: string;
  to: string;
  /** Season the `from` team was observed. */
  lastSeason: number;
}

/**
 * Compares where a player finished last season against where he is now.
 *
 * Returns null when there is nothing to compare -- no history, or a free agent
 * with no current team -- rather than reporting a move that may not exist. A
 * false positive here would discredit the flag everywhere it appears.
 */
export function detectTeamChange(
  player: Pick<Player, "proTeam">,
  history: SeasonStatLine[],
): TeamChange | null {
  const current = normalizeTeam(player.proTeam);
  if (!current || current === "FA") return null;

  const latest = [...history]
    .filter((line) => line.team)
    .sort((a, b) => b.season - a.season)[0];
  if (!latest) return null;

  const previous = normalizeTeam(latest.team);
  if (!previous) return null;

  return {
    changed: previous !== current,
    from: previous,
    to: current,
    lastSeason: latest.season,
  };
}
