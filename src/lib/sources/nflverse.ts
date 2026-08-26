import { fetchTextCached } from "./cache";
import { num, parseCsv } from "./csv";

/**
 * Season stat lines from nflverse.
 *
 * This is the source that makes the league's own scoring usable. Every
 * projection and ranking published anywhere is denominated in somebody else's
 * rules -- standard, half PPR, full PPR -- and none of them price half a point
 * per first down, or receptions for receivers but not for backs. Importing
 * their *points* imports their league. Importing their *volume* and scoring it
 * here does not.
 */

const RELEASE = "https://github.com/nflverse/nflverse-data/releases/download/stats_player";

/** Component counting stats, before anybody's scoring rules are applied. */
export interface SeasonStatLine {
  gsisId: string;
  name: string;
  position: string;
  season: number;
  games: number;
  receptions: number;
  targets: number;
  receivingYards: number;
  receivingTds: number;
  receivingFirstDowns: number;
  rushingYards: number;
  rushingTds: number;
  rushingFirstDowns: number;
  passingYards: number;
  passingTds: number;
  passingFirstDowns: number;
  interceptions: number;
  fumblesLost: number;
}

/**
 * Every player's season totals, aggregated from the weekly file.
 *
 * The weekly file is used rather than the published season file because it
 * covers more recent seasons, and because summing it lets regular season and
 * postseason be separated -- postseason production is real football and
 * entirely irrelevant to fantasy value.
 */
export async function fetchSeasonStats(season: number): Promise<SeasonStatLine[]> {
  const { text } = await fetchTextCached(
    `${RELEASE}/stats_player_week_${season}.csv`,
    `stats_player_week_${season}.csv`,
    // A completed season never changes; an in-progress one changes weekly.
    { ttlMs: 24 * 60 * 60 * 1000, timeoutSeconds: 120 },
  );

  const totals = new Map<string, SeasonStatLine>();

  for (const row of parseCsv(text)) {
    if (row.season_type && row.season_type !== "REG") continue;
    const gsisId = row.player_id;
    if (!gsisId) continue;

    let line = totals.get(gsisId);
    if (!line) {
      line = {
        gsisId,
        name: row.player_display_name || row.player_name || "",
        position: row.position || "",
        season,
        games: 0,
        receptions: 0,
        targets: 0,
        receivingYards: 0,
        receivingTds: 0,
        receivingFirstDowns: 0,
        rushingYards: 0,
        rushingTds: 0,
        rushingFirstDowns: 0,
        passingYards: 0,
        passingTds: 0,
        passingFirstDowns: 0,
        interceptions: 0,
        fumblesLost: 0,
      };
      totals.set(gsisId, line);
    }

    line.games += 1;
    line.receptions += num(row.receptions) ?? 0;
    line.targets += num(row.targets) ?? 0;
    line.receivingYards += num(row.receiving_yards) ?? 0;
    line.receivingTds += num(row.receiving_tds) ?? 0;
    line.receivingFirstDowns += num(row.receiving_first_downs) ?? 0;
    line.rushingYards += num(row.rushing_yards) ?? 0;
    line.rushingTds += num(row.rushing_tds) ?? 0;
    line.rushingFirstDowns += num(row.rushing_first_downs) ?? 0;
    line.passingYards += num(row.passing_yards) ?? 0;
    line.passingTds += num(row.passing_tds) ?? 0;
    line.passingFirstDowns += num(row.passing_first_downs) ?? 0;
    line.interceptions += num(row.passing_interceptions) ?? num(row.interceptions) ?? 0;
    line.fumblesLost += num(row.rushing_fumbles_lost) ?? 0;
    line.fumblesLost += num(row.receiving_fumbles_lost) ?? 0;
  }

  return [...totals.values()];
}
