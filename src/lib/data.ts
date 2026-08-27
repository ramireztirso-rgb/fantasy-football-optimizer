import "server-only";
import { credentialsFromEnv, EspnError } from "@/lib/espn/client";
import {
  fetchDraftPool,
  fetchDraftStatus,
  fetchFreeAgents,
  fetchHistoricalSeason,
  fetchLeague,
} from "@/lib/espn/league";
import { normalizeLeague } from "@/lib/espn/normalize";
import { buildDemoDraft, buildDemoLeague, buildDemoPlayers } from "@/lib/demo/league";
import { mockDraftEnabled, mockDraftStatus } from "@/lib/mock/draftRoom";
import type { DraftStatus, League, Player, Position } from "@/lib/domain/types";
import type { HistoricalDraft, PlayerReference } from "@/lib/engine/tendencies";

/**
 * Single entry point for league data.
 *
 * Falls back to the demo league when no ESPN league is configured, so the app
 * is explorable before anyone goes cookie-hunting in their browser. `isDemo` is
 * surfaced all the way to the UI -- silently showing fake numbers as if they
 * were someone's real team would be worse than showing nothing.
 */

export interface DataSourceResult<T> {
  data: T;
  isDemo: boolean;
  /** Present when a real fetch failed and demo data was substituted. */
  warning?: string;
}

export function isConfigured(): boolean {
  return Boolean(process.env.ESPN_LEAGUE_ID);
}

export async function getLeague(): Promise<DataSourceResult<League>> {
  if (!isConfigured()) {
    return { data: buildDemoLeague().league, isDemo: true };
  }
  const league = await fetchLeague(credentialsFromEnv());
  return { data: league, isDemo: false };
}

export async function getFreeAgentPool(week?: number): Promise<DataSourceResult<Player[]>> {
  if (!isConfigured()) {
    return { data: buildDemoLeague({ week }).freeAgents, isDemo: true };
  }
  const players = await fetchFreeAgents(credentialsFromEnv(), week);
  return { data: players, isDemo: false };
}

export async function getDraftPoolData(): Promise<DataSourceResult<Player[]>> {
  if (!isConfigured()) {
    return { data: buildDemoPlayers(), isDemo: true };
  }
  const players = await fetchDraftPool(credentialsFromEnv());
  return { data: players, isDemo: false };
}

export async function getDraftStatus(): Promise<DataSourceResult<DraftStatus>> {
  if (!isConfigured()) {
    return { data: buildDemoDraft(), isDemo: true };
  }
  // The practice room, when MOCK_DRAFT=1. It fakes exactly this one answer --
  // what picks have been made -- and everything downstream of it runs the
  // production path against the fitted model of this league's managers. The
  // env gate is what guarantees it cannot exist on draft night by accident.
  if (mockDraftEnabled()) {
    return { data: await mockDraftStatus(), isDemo: false };
  }
  return { data: await fetchDraftStatus(credentialsFromEnv()), isDemo: false };
}

/**
 * Past drafts plus a player-id lookup, for league tendency analysis.
 *
 * Positions are resolved from each historical season's own rosters first and
 * the current player pool second. Coverage is reported rather than assumed --
 * players who left the league years ago cannot always be resolved, and a
 * tendency computed from half the picks should say so.
 */
export async function getHistoricalDrafts(
  seasonsBack = 3,
): Promise<
  DataSourceResult<{
    drafts: HistoricalDraft[];
    playerInfo: Map<number, PlayerReference>;
    teamNames: Map<number, string>;
    /** Positions of the top players by current ADP, in ADP order. */
    marketOrder: Position[];
  }>
> {
  if (!isConfigured()) {
    const demoDraft = buildDemoDraft();
    const players = buildDemoPlayers();
    const { league } = buildDemoLeague();
    return {
      data: {
        drafts: [{ seasonId: 2025, picks: demoDraft.picks }],
        playerInfo: new Map(
          players.map((p) => [
            p.id,
            {
              position: p.position,
              averageDraftPosition: p.averageDraftPosition,
              adpSeason: 2025,
            },
          ]),
        ),
        teamNames: new Map(league.teams.map((t) => [t.id, t.name])),
        marketOrder: marketOrderFrom(players),
      },
      isDemo: true,
    };
  }

  const creds = credentialsFromEnv();
  const currentSeason = creds.seasonId;
  const drafts: HistoricalDraft[] = [];
  const playerInfo = new Map<number, PlayerReference>();
  const teamNames = new Map<number, string>();

  // Seed the lookup with the current pool: most drafted players are still
  // active. The ADP is stamped with the season it belongs to, so the analyzer
  // can refuse to compare it against a pick from a different year.
  let marketOrder: Position[] = [];
  try {
    const pool = await fetchDraftPool(creds);
    for (const p of pool) {
      playerInfo.set(p.id, {
        position: p.position,
        averageDraftPosition: Number.isFinite(p.averageDraftPosition)
          ? p.averageDraftPosition
          : undefined,
        adpSeason: currentSeason,
      });
    }
    marketOrder = marketOrderFrom(pool);
  } catch {
    // The current pool is an enrichment; history is still analyzable without it.
  }

  for (let offset = 1; offset <= seasonsBack; offset++) {
    const seasonId = currentSeason - offset;
    try {
      const season = await fetchHistoricalSeason(creds, seasonId);
      if (!season || !season.draft.picks.length) continue;
      drafts.push({ seasonId, picks: season.draft.picks });

      // That season's end-of-year rosters resolve players no longer active.
      const ctx = { week: 17, seasonId, byeWeeks: {} };
      const normalized = normalizeLeague(season.raw, ctx);
      for (const team of normalized.teams) {
        if (!teamNames.has(team.id)) teamNames.set(team.id, team.name);
        for (const slot of team.roster) {
          if (playerInfo.has(slot.player.id)) continue;
          // No ADP is recorded here: a historical roster does not carry that
          // season's ADP, and borrowing this year's would be worse than none.
          playerInfo.set(slot.player.id, { position: slot.player.position });
        }
      }
    } catch {
      // A missing season is normal for a league that has not existed that long.
    }
  }

  return { data: { drafts, playerInfo, teamNames, marketOrder }, isDemo: false };
}

/** Positions of the draftable pool ordered by national ADP. */
function marketOrderFrom(pool: Player[]): Position[] {
  return [...pool]
    .filter((p) => Number.isFinite(p.averageDraftPosition))
    .sort((a, b) => a.averageDraftPosition - b.averageDraftPosition)
    .map((p) => p.position);
}

/** Maps any thrown error into a JSON body plus HTTP status for a route handler. */
export function toErrorResponse(err: unknown): { body: { error: string; hint?: string }; status: number } {
  if (err instanceof EspnError) {
    return { body: { error: err.message, hint: err.hint }, status: err.status };
  }
  return {
    body: { error: err instanceof Error ? err.message : "Unexpected error." },
    status: 500,
  };
}
