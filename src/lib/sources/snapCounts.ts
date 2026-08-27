import { fetchTextCached } from "./cache";
import { num, parseCsv } from "./csv";

/**
 * How much of his team's offensive snaps a player was on the field for.
 *
 * Carries say what a back produced; snaps say what he was trusted with, and
 * the two disagree in an informative way. A back with most of the carries but
 * barely half the snaps leaves the field on passing downs -- a real warning in
 * a league that pays backs per catch, and close to a free pass in one that
 * does not. Neither number alone can tell those apart.
 */

const RELEASE = "https://github.com/nflverse/nflverse-data/releases/download/snap_counts";

export interface SnapShare {
  /** Mean share of team offensive snaps across games he played, 0-1. */
  share: number;
  games: number;
}

/** Season snap shares keyed by Pro-Football-Reference player id. */
export async function fetchSnapShares(season: number): Promise<Map<string, SnapShare>> {
  const { text } = await fetchTextCached(
    `${RELEASE}/snap_counts_${season}.csv`,
    `snap_counts_${season}.csv`,
    { ttlMs: 24 * 60 * 60 * 1000, timeoutSeconds: 90 },
  );

  const totals = new Map<string, { sum: number; games: number }>();
  for (const row of parseCsv(text)) {
    if (row.game_type && row.game_type !== "REG") continue;
    const id = row.pfr_player_id;
    const pct = num(row.offense_pct);
    const snaps = num(row.offense_snaps) ?? 0;
    // A zero-snap week is a healthy scratch or injury, not a role observation.
    if (!id || pct === undefined || snaps <= 0) continue;
    const entry = totals.get(id) ?? { sum: 0, games: 0 };
    entry.sum += pct;
    entry.games += 1;
    totals.set(id, entry);
  }

  const out = new Map<string, SnapShare>();
  for (const [id, entry] of totals) {
    out.set(id, { share: entry.sum / entry.games, games: entry.games });
  }
  return out;
}
