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
  /**
   * Team as of the player's last game that season. Mid-season trades mean a
   * stat line can span two, and where he *ended up* is what predicts next year.
   */
  team: string;
  games: number;
  receptions: number;
  targets: number;
  receivingYards: number;
  receivingTds: number;
  receivingFirstDowns: number;
  /** Rushing attempts. Workload, as distinct from what the workload produced. */
  carries: number;
  rushingYards: number;
  rushingTds: number;
  rushingFirstDowns: number;
  passingYards: number;
  passingTds: number;
  passingFirstDowns: number;
  interceptions: number;
  fumblesLost: number;
  /**
   * Total yardage of made field goals, which is the whole basis of kicker
   * scoring in leagues that pay by distance rather than per kick.
   */
  fieldGoalYards: number;
  fieldGoalsMade: number;
  fieldGoalsMissedMedium: number;
  fieldGoalsMissedLong: number;
  extraPointsMade: number;
  extraPointsMissed: number;
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
        team: "",
        games: 0,
        receptions: 0,
        targets: 0,
        receivingYards: 0,
        receivingTds: 0,
        receivingFirstDowns: 0,
        carries: 0,
        rushingYards: 0,
        rushingTds: 0,
        rushingFirstDowns: 0,
        passingYards: 0,
        passingTds: 0,
        passingFirstDowns: 0,
        interceptions: 0,
        fumblesLost: 0,
        fieldGoalYards: 0,
        fieldGoalsMade: 0,
        fieldGoalsMissedMedium: 0,
        fieldGoalsMissedLong: 0,
        extraPointsMade: 0,
        extraPointsMissed: 0,
      };
      totals.set(gsisId, line);
    }

    // Rows arrive in week order, so the last one seen is the latest team.
    if (row.team) line.team = row.team;
    line.games += 1;
    line.receptions += num(row.receptions) ?? 0;
    line.targets += num(row.targets) ?? 0;
    line.receivingYards += num(row.receiving_yards) ?? 0;
    line.receivingTds += num(row.receiving_tds) ?? 0;
    line.receivingFirstDowns += num(row.receiving_first_downs) ?? 0;
    line.carries += num(row.carries) ?? 0;
    line.rushingYards += num(row.rushing_yards) ?? 0;
    line.rushingTds += num(row.rushing_tds) ?? 0;
    line.rushingFirstDowns += num(row.rushing_first_downs) ?? 0;
    line.passingYards += num(row.passing_yards) ?? 0;
    line.passingTds += num(row.passing_tds) ?? 0;
    line.passingFirstDowns += num(row.passing_first_downs) ?? 0;
    line.interceptions += num(row.passing_interceptions) ?? num(row.interceptions) ?? 0;
    line.fumblesLost += num(row.rushing_fumbles_lost) ?? 0;
    line.fumblesLost += num(row.receiving_fumbles_lost) ?? 0;
    line.fieldGoalYards += num(row.fg_made_distance) ?? 0;
    line.fieldGoalsMade += num(row.fg_made) ?? 0;
    line.fieldGoalsMissedMedium += num(row.fg_missed_40_49) ?? 0;
    line.fieldGoalsMissedLong +=
      (num(row.fg_missed_50_59) ?? 0) + (num(row.fg_missed_60_) ?? 0);
    line.extraPointsMade += num(row.pat_made) ?? 0;
    line.extraPointsMissed += Math.max(0, (num(row.pat_att) ?? 0) - (num(row.pat_made) ?? 0));
  }

  return [...totals.values()];
}

/** One player's line for one game, before anyone's scoring is applied. */
export interface WeeklyStatLine {
  gsisId: string;
  name: string;
  position: string;
  season: number;
  week: number;
  team: string;
  opponent: string;
  carries: number;
  rushingYards: number;
  rushingTds: number;
  rushingFirstDowns: number;
  receptions: number;
  targets: number;
  receivingYards: number;
  receivingTds: number;
  receivingFirstDowns: number;
  passingYards: number;
  passingTds: number;
  passingFirstDowns: number;
  interceptions: number;
  fumblesLost: number;
  /**
   * Total yardage of made field goals, which is the whole basis of kicker
   * scoring in leagues that pay by distance rather than per kick.
   */
  fieldGoalYards: number;
  fieldGoalsMade: number;
  fieldGoalsMissedMedium: number;
  fieldGoalsMissedLong: number;
  extraPointsMade: number;
  extraPointsMissed: number;
}

/**
 * Week-by-week lines, which is what almost every question about consistency
 * needs.
 *
 * Season totals hide the thing being asked about. "Does a workhorse have a
 * higher floor" is a question about the shape of a distribution, and a season
 * total is one number with the shape averaged out of it.
 */
export async function fetchWeeklyStats(season: number): Promise<WeeklyStatLine[]> {
  const { text } = await fetchTextCached(
    `${RELEASE}/stats_player_week_${season}.csv`,
    `stats_player_week_${season}.csv`,
    { ttlMs: 24 * 60 * 60 * 1000, timeoutSeconds: 120 },
  );

  const out: WeeklyStatLine[] = [];
  for (const row of parseCsv(text)) {
    if (row.season_type && row.season_type !== "REG") continue;
    const week = num(row.week);
    if (!row.player_id || week === undefined) continue;
    out.push({
      gsisId: row.player_id,
      name: row.player_display_name || row.player_name || "",
      position: row.position || "",
      season,
      week,
      team: row.team ?? "",
      opponent: row.opponent_team ?? "",
      carries: num(row.carries) ?? 0,
      rushingYards: num(row.rushing_yards) ?? 0,
      rushingTds: num(row.rushing_tds) ?? 0,
      rushingFirstDowns: num(row.rushing_first_downs) ?? 0,
      receptions: num(row.receptions) ?? 0,
      targets: num(row.targets) ?? 0,
      receivingYards: num(row.receiving_yards) ?? 0,
      receivingTds: num(row.receiving_tds) ?? 0,
      receivingFirstDowns: num(row.receiving_first_downs) ?? 0,
      passingYards: num(row.passing_yards) ?? 0,
      passingTds: num(row.passing_tds) ?? 0,
      passingFirstDowns: num(row.passing_first_downs) ?? 0,
      interceptions: num(row.passing_interceptions) ?? num(row.interceptions) ?? 0,
      fumblesLost: (num(row.rushing_fumbles_lost) ?? 0) + (num(row.receiving_fumbles_lost) ?? 0),
      fieldGoalYards: num(row.fg_made_distance) ?? 0,
      fieldGoalsMade: num(row.fg_made) ?? 0,
      fieldGoalsMissedMedium: num(row.fg_missed_40_49) ?? 0,
      fieldGoalsMissedLong: (num(row.fg_missed_50_59) ?? 0) + (num(row.fg_missed_60_) ?? 0),
      extraPointsMade: num(row.pat_made) ?? 0,
      extraPointsMissed: Math.max(0, (num(row.pat_att) ?? 0) - (num(row.pat_made) ?? 0)),
    });
  }
  return out;
}
