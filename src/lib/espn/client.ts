import "server-only";

/**
 * Thin transport over ESPN's read-only fantasy v3 API.
 *
 * Everything here runs on the server. `espn_s2` is a long-lived session cookie
 * for the user's whole ESPN account -- it must never be sent to the browser,
 * which is why this module is `server-only` and the UI talks to it exclusively
 * through the route handlers in `src/app/api`.
 */

const READ_HOST = "https://lm-api-reads.fantasy.espn.com";

export interface EspnCredentials {
  leagueId: string;
  seasonId: number;
  /** Both cookies are required for private leagues, optional for public ones. */
  espnS2?: string;
  swid?: string;
}

export class EspnError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "EspnError";
  }
}

/**
 * Reads credentials from the environment. Kept separate from `fetchLeague` so
 * the engine and tests can drive the client with explicit credentials.
 */
export function credentialsFromEnv(): EspnCredentials {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  if (!leagueId) {
    throw new EspnError(
      "ESPN_LEAGUE_ID is not set.",
      500,
      "Copy .env.example to .env.local and fill in your league id -- it is the `leagueId=` number in your ESPN league URL.",
    );
  }
  const seasonId = Number(process.env.ESPN_SEASON_ID) || new Date().getFullYear();
  return {
    leagueId,
    seasonId,
    espnS2: process.env.ESPN_S2,
    swid: normalizeSwid(process.env.SWID),
  };
}

/** ESPN writes SWID with surrounding braces; accept it either way. */
export function normalizeSwid(swid: string | undefined): string | undefined {
  if (!swid) return undefined;
  const trimmed = swid.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("{") ? trimmed : `{${trimmed}}`;
}

function cookieHeader(creds: EspnCredentials): string | undefined {
  const parts: string[] = [];
  if (creds.espnS2) parts.push(`espn_s2=${creds.espnS2}`);
  if (creds.swid) parts.push(`SWID=${creds.swid}`);
  return parts.length ? parts.join("; ") : undefined;
}

export interface EspnRequest {
  views: string[];
  /** Serialized into the `x-fantasy-filter` header ESPN uses for player queries. */
  filter?: unknown;
  scoringPeriodId?: number;
  signal?: AbortSignal;
}

/**
 * Issues one request against the league endpoint and returns parsed JSON.
 *
 * Retries only on transient failures (429 and 5xx). A 401 means the cookies are
 * missing or stale, which retrying will never fix, so it fails fast with a hint
 * the UI surfaces directly.
 */
export async function espnFetch<T>(
  creds: EspnCredentials,
  req: EspnRequest,
  attempt = 0,
): Promise<T> {
  const url = new URL(
    `${READ_HOST}/apis/v3/games/ffl/seasons/${creds.seasonId}/segments/0/leagues/${creds.leagueId}`,
  );
  for (const view of req.views) url.searchParams.append("view", view);
  if (req.scoringPeriodId !== undefined) {
    url.searchParams.set("scoringPeriodId", String(req.scoringPeriodId));
  }

  const headers: Record<string, string> = { accept: "application/json" };
  const cookie = cookieHeader(creds);
  if (cookie) headers.cookie = cookie;
  if (req.filter) headers["x-fantasy-filter"] = JSON.stringify(req.filter);

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: req.signal, cache: "no-store" });
  } catch (cause) {
    if (attempt < 3) return backoffRetry(creds, req, attempt);
    throw new EspnError(
      `Could not reach ESPN: ${(cause as Error).message}`,
      503,
      "Check your network connection. If you are behind a proxy or VPN, ESPN's fantasy host may be blocked.",
    );
  }

  if (res.status === 401) {
    throw new EspnError(
      "ESPN rejected the request (401).",
      401,
      "Your espn_s2 / SWID cookies are missing, expired, or belong to an account that cannot see this league. Re-copy them from your browser -- see the README.",
    );
  }
  if (res.status === 404) {
    throw new EspnError(
      `League ${creds.leagueId} was not found for season ${creds.seasonId}.`,
      404,
      "Check ESPN_LEAGUE_ID and ESPN_SEASON_ID. Seasons before the current one live at a different endpoint and are not supported yet.",
    );
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) return backoffRetry(creds, req, attempt);
    throw new EspnError(`ESPN returned ${res.status} after 4 attempts.`, res.status);
  }
  if (!res.ok) {
    throw new EspnError(`ESPN returned ${res.status}.`, res.status);
  }

  return (await res.json()) as T;
}

function backoffRetry<T>(
  creds: EspnCredentials,
  req: EspnRequest,
  attempt: number,
): Promise<T> {
  const waitMs = 2 ** attempt * 500;
  return new Promise((resolve) => setTimeout(resolve, waitMs)).then(() =>
    espnFetch<T>(creds, req, attempt + 1),
  );
}

/**
 * Builds the `x-fantasy-filter` payload for a free-agent / waiver-pool query.
 *
 * ESPN caps this server-side, so `limit` is a request, not a guarantee.
 */
export function freeAgentFilter(week: number, limit = 250) {
  return {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 23] },
      limit,
      sortPercOwned: { sortAsc: false, sortPriority: 1 },
      filterRanksForScoringPeriodIds: { value: [week] },
      filterStatsForTopScoringPeriodIds: { value: 5 },
    },
  };
}

/** Filter for the full player universe, used by the draft board. */
export function draftPoolFilter(limit = 500) {
  return {
    players: {
      filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 23] },
      limit,
      sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" },
    },
  };
}

/**
 * Fetches a prior season for this league.
 *
 * Completed seasons move to the `leagueHistory` endpoint, which differs from
 * the live one in two ways that break naive reuse: the season is passed as a
 * query parameter rather than in the path, and the response is an array of
 * seasons rather than a single object.
 */
export async function espnFetchHistory<T>(
  creds: EspnCredentials,
  seasonId: number,
  views: string[],
): Promise<T[]> {
  const url = new URL(`${READ_HOST}/apis/v3/games/ffl/leagueHistory/${creds.leagueId}`);
  url.searchParams.set("seasonId", String(seasonId));
  for (const view of views) url.searchParams.append("view", view);

  const headers: Record<string, string> = { accept: "application/json" };
  const cookie = cookieHeader(creds);
  if (cookie) headers.cookie = cookie;

  const res = await fetch(url, { headers, cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new EspnError(`ESPN history endpoint returned ${res.status}.`, res.status);
  }
  const json = await res.json();
  return (Array.isArray(json) ? json : [json]) as T[];
}

/**
 * Fetches a season-level (non-league) document. Used for the pro-team schedule,
 * which is where bye weeks live -- they are not on the player objects.
 */
export async function espnFetchSeason<T>(
  creds: EspnCredentials,
  views: string[],
): Promise<T> {
  const url = new URL(`${READ_HOST}/apis/v3/games/ffl/seasons/${creds.seasonId}`);
  for (const view of views) url.searchParams.append("view", view);

  const headers: Record<string, string> = { accept: "application/json" };
  const cookie = cookieHeader(creds);
  if (cookie) headers.cookie = cookie;

  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) {
    throw new EspnError(`ESPN season endpoint returned ${res.status}.`, res.status);
  }
  return (await res.json()) as T;
}
