import { fetchTextCached } from "./cache";
import { num, parseCsv } from "./csv";

/**
 * Game results, and who was coaching.
 *
 * Points scored is the plainest measure of an offence there is, and unlike
 * anything derived from player stats it does not care who was healthy or how
 * the touches were shared. Coaches come attached to the same rows, which makes
 * "did changing the coach change anything" answerable rather than a matter of
 * opinion.
 */

const SOURCE_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";

export interface TeamSeasonRecord {
  team: string;
  season: number;
  games: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Coach for the most games that season, which is who the season belonged to. */
  coach: string;
  /** True when somebody else coached at least a quarter of the games. */
  midSeasonChange: boolean;
}

export async function fetchTeamSeasons(): Promise<TeamSeasonRecord[]> {
  const { text } = await fetchTextCached(SOURCE_URL, "games.csv", {
    ttlMs: 24 * 60 * 60 * 1000,
    timeoutSeconds: 90,
  });

  interface Accumulator {
    games: number;
    pointsFor: number;
    pointsAgainst: number;
    coachGames: Map<string, number>;
  }
  const acc = new Map<string, Accumulator>();

  const bump = (
    team: string,
    season: number,
    scored: number,
    allowed: number,
    coach: string,
  ) => {
    const key = `${season}:${team}`;
    const entry = acc.get(key) ?? {
      games: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      coachGames: new Map<string, number>(),
    };
    entry.games += 1;
    entry.pointsFor += scored;
    entry.pointsAgainst += allowed;
    if (coach) entry.coachGames.set(coach, (entry.coachGames.get(coach) ?? 0) + 1);
    acc.set(key, entry);
  };

  for (const row of parseCsv(text)) {
    const season = num(row.season);
    const home = num(row.home_score);
    const away = num(row.away_score);
    // Regular season only, and only games that have been played.
    if (season === undefined || home === undefined || away === undefined) continue;
    if (row.game_type && row.game_type !== "REG") continue;
    if (!row.home_team || !row.away_team) continue;

    bump(row.home_team, season, home, away, row.home_coach ?? "");
    bump(row.away_team, season, away, home, row.away_coach ?? "");
  }

  const out: TeamSeasonRecord[] = [];
  for (const [key, entry] of acc) {
    const [seasonText, team] = key.split(":");
    const ranked = [...entry.coachGames.entries()].sort((a, b) => b[1] - a[1]);
    const [coach, coachGames] = ranked[0] ?? ["", 0];
    out.push({
      team,
      season: Number(seasonText),
      games: entry.games,
      pointsFor: entry.pointsFor,
      pointsAgainst: entry.pointsAgainst,
      coach,
      midSeasonChange: entry.games > 0 && coachGames / entry.games < 0.75,
    });
  }
  return out;
}

/**
 * Who is coaching each team in a season that has not been played yet.
 *
 * Scheduled games carry their coaching assignments before anybody kicks off,
 * which is what makes the coaching-change finding usable for a draft rather
 * than only for a post-mortem. Kept separate from `fetchTeamSeasons` because
 * that one is built around results and a future season has none.
 */
export async function fetchCoaches(season: number): Promise<Map<string, string>> {
  const { text } = await fetchTextCached(SOURCE_URL, "games.csv", {
    ttlMs: 24 * 60 * 60 * 1000,
    timeoutSeconds: 90,
  });

  const counts = new Map<string, Map<string, number>>();
  const bump = (team: string, coach: string) => {
    if (!team || !coach) return;
    const inner = counts.get(team) ?? new Map<string, number>();
    inner.set(coach, (inner.get(coach) ?? 0) + 1);
    counts.set(team, inner);
  };

  for (const row of parseCsv(text)) {
    if (num(row.season) !== season) continue;
    if (row.game_type && row.game_type !== "REG") continue;
    bump(row.home_team ?? "", row.home_coach ?? "");
    bump(row.away_team ?? "", row.away_coach ?? "");
  }

  const out = new Map<string, string>();
  for (const [team, inner] of counts) {
    const [coach] = [...inner.entries()].sort((a, b) => b[1] - a[1])[0] ?? [""];
    if (coach) out.set(team, coach);
  }
  return out;
}

export interface ScheduledGame {
  season: number;
  week: number;
  home: string;
  away: string;
}

/**
 * The fixture list for a season, played or not.
 *
 * Used for the weeks that decide a fantasy season, which are known months in
 * advance even though nothing about the teams is.
 */
export async function fetchScheduledGames(season: number): Promise<ScheduledGame[]> {
  const { text } = await fetchTextCached(SOURCE_URL, "games.csv", {
    ttlMs: 24 * 60 * 60 * 1000,
    timeoutSeconds: 90,
  });

  const out: ScheduledGame[] = [];
  for (const row of parseCsv(text)) {
    if (num(row.season) !== season) continue;
    if (row.game_type && row.game_type !== "REG") continue;
    const week = num(row.week);
    if (week === undefined || !row.home_team || !row.away_team) continue;
    out.push({ season, week, home: row.home_team, away: row.away_team });
  }
  return out;
}
