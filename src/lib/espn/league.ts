import "server-only";
import {
  credentialsFromEnv,
  draftPoolFilter,
  espnFetch,
  espnFetchHistory,
  espnFetchSeason,
  freeAgentFilter,
  type EspnCredentials,
} from "./client";
import {
  normalizeDraftSettings,
  normalizeDraftStatus,
  normalizeLeague,
  normalizePlayerPool,
  resolveMyTeamId,
  type NormalizeContext,
} from "./normalize";
import type { RawLeagueResponse } from "./raw";
import type { DraftStatus, League, Player } from "@/lib/domain/types";

interface SeasonScheduleResponse {
  settings?: { proTeams?: Array<{ id?: number; byeWeek?: number }> };
}

/** Bye weeks change once a year; cache them for the process lifetime. */
let byeWeekCache: { seasonId: number; map: Record<number, number> } | null = null;

export async function fetchByeWeeks(creds: EspnCredentials): Promise<Record<number, number>> {
  if (byeWeekCache?.seasonId === creds.seasonId) return byeWeekCache.map;
  try {
    const data = await espnFetchSeason<SeasonScheduleResponse>(creds, ["proTeamSchedules_wl"]);
    const map: Record<number, number> = {};
    for (const team of data.settings?.proTeams ?? []) {
      if (team.id !== undefined && team.byeWeek) map[team.id] = team.byeWeek;
    }
    byeWeekCache = { seasonId: creds.seasonId, map };
    return map;
  } catch {
    // Bye weeks are an enrichment, not a requirement. Losing them costs one
    // reason string on a recommendation; failing the whole request would cost
    // the page.
    return {};
  }
}

/**
 * The single league snapshot everything else is derived from: settings, all
 * teams and rosters, the schedule, and the current week.
 */
export async function fetchLeague(creds = credentialsFromEnv()): Promise<League> {
  const raw = await espnFetch<RawLeagueResponse>(creds, {
    views: ["mTeam", "mRoster", "mSettings", "mMatchupScore", "mStandings", "mNav"],
  });
  const week = currentWeek(raw);
  const byeWeeks = await fetchByeWeeks(creds);
  const ctx: NormalizeContext = { week, seasonId: raw.seasonId ?? creds.seasonId, byeWeeks };
  return normalizeLeague(raw, ctx, resolveMyTeamId(raw, creds.swid));
}

/** Everyone on waivers or free agency, with ownership trend data attached. */
export async function fetchFreeAgents(
  creds = credentialsFromEnv(),
  week?: number,
  limit = 250,
): Promise<Player[]> {
  const scoringPeriodId = week ?? (await fetchCurrentWeek(creds));
  const byeWeeks = await fetchByeWeeks(creds);
  const raw = await espnFetch<RawLeagueResponse>(creds, {
    views: ["kona_player_info"],
    filter: freeAgentFilter(scoringPeriodId, limit),
    scoringPeriodId,
  });
  return normalizePlayerPool(raw.players, {
    week: scoringPeriodId,
    seasonId: raw.seasonId ?? creds.seasonId,
    byeWeeks,
  });
}

/** The draftable player universe, ordered by ESPN's own draft ranks. */
export async function fetchDraftPool(
  creds = credentialsFromEnv(),
  limit = 500,
): Promise<Player[]> {
  const byeWeeks = await fetchByeWeeks(creds);
  const raw = await espnFetch<RawLeagueResponse>(creds, {
    views: ["kona_player_info"],
    filter: draftPoolFilter(limit),
    scoringPeriodId: 1,
  });
  return normalizePlayerPool(raw.players, {
    week: 1,
    seasonId: raw.seasonId ?? creds.seasonId,
    byeWeeks,
  });
}

/** Live scoring for a single week, refreshed on every poll. */
export async function fetchScoreboard(
  creds = credentialsFromEnv(),
  week?: number,
): Promise<League> {
  const scoringPeriodId = week ?? (await fetchCurrentWeek(creds));
  const byeWeeks = await fetchByeWeeks(creds);
  const raw = await espnFetch<RawLeagueResponse>(creds, {
    views: ["mMatchupScore", "mLiveScoring", "mRoster", "mTeam", "mSettings"],
    scoringPeriodId,
  });
  const ctx: NormalizeContext = {
    week: scoringPeriodId,
    seasonId: raw.seasonId ?? creds.seasonId,
    byeWeeks,
  };
  return normalizeLeague(raw, ctx, resolveMyTeamId(raw, creds.swid));
}

/**
 * Live draft state: settings, order, and every pick made so far.
 *
 * Polled during a draft so the board can react to picks as they land. Kept
 * separate from `fetchLeague` because it is polled far more aggressively while
 * a draft is running and not at all outside one.
 */
export async function fetchDraftStatus(creds = credentialsFromEnv()): Promise<DraftStatus> {
  const raw = await espnFetch<RawLeagueResponse>(creds, {
    views: ["mDraftDetail", "mSettings", "mTeam"],
  });
  const settings = normalizeDraftSettings(raw);
  const size = raw.settings?.size ?? raw.teams?.length ?? 0;
  return normalizeDraftStatus(raw.draftDetail, settings, size);
}

/**
 * A completed prior season, used for league-tendency and head-to-head analysis.
 * Returns null when the league did not exist that year.
 */
export async function fetchHistoricalSeason(
  creds: EspnCredentials,
  seasonId: number,
): Promise<{ raw: RawLeagueResponse; draft: DraftStatus } | null> {
  const seasons = await espnFetchHistory<RawLeagueResponse>(creds, seasonId, [
    "mTeam",
    "mSettings",
    "mDraftDetail",
    "mMatchupScore",
  ]);
  const raw = seasons.find((s) => s.seasonId === seasonId) ?? seasons[0];
  if (!raw) return null;
  const settings = normalizeDraftSettings(raw);
  const size = raw.settings?.size ?? raw.teams?.length ?? 0;
  return { raw, draft: normalizeDraftStatus(raw.draftDetail, settings, size) };
}

export async function fetchCurrentWeek(creds = credentialsFromEnv()): Promise<number> {
  const raw = await espnFetch<RawLeagueResponse>(creds, { views: ["mNav"] });
  return currentWeek(raw);
}

/**
 * ESPN reports the week in three places that disagree during Tuesday rollover.
 * `scoringPeriodId` is the one that matches what the site shows.
 */
export function currentWeek(raw: RawLeagueResponse): number {
  return (
    raw.scoringPeriodId ??
    raw.status?.latestScoringPeriod ??
    raw.status?.currentMatchupPeriod ??
    1
  );
}
