import type { LeagueSettings, Player } from "@/lib/domain/types";
import {
  compareToForecast,
  componentProjection,
  positionalBaselines,
} from "@/lib/engine/componentProjection";
import { buildAgeCurve, type AgeObservation } from "@/lib/engine/aging";
import { detectTeamChange } from "@/lib/engine/teamChange";
import { scoreStatLine } from "@/lib/engine/scoreFromStats";
import { fetchSeasonStats, type SeasonStatLine } from "./nflverse";
import { fetchPlayerIdIndex, ageAtSeason } from "./playerIds";

/**
 * The board's second opinion on every player, assembled once per request.
 *
 * Everything ranking players comes from one ESPN number, so when ESPN is wrong
 * about somebody the board is wrong in the same direction with no way to
 * notice. This is the way to notice: each player's own recent production,
 * scored under this league's rules, aged forward to the season being drafted,
 * and set beside the forecast. Where the two part company by a lot, the board
 * says so.
 *
 * It also carries the one warning the history-based model owes its readers:
 * that a player who changed teams is precisely the case where his own history
 * says the least, because the targets it extrapolates belonged to a different
 * offence.
 *
 * This module previously existed only inside the `compare` script, which meant
 * the analysis ran when somebody remembered to run it. A disagreement that has
 * to be looked up is one nobody sees on the clock.
 */

export interface SecondOpinion {
  /** ESPN's forecast minus the player's own aged production, as a share. */
  relativeGap: number;
  /** What his own production projects to, in this league's points. */
  fromOwnProduction: number;
  gamesOfHistory: number;
  /** Points a game the aging curve added or removed. */
  ageAdjustment: number;
  /** Plain-language read of the gap, or null when the two broadly agree. */
  note: string | null;
  /** Set when he is somewhere new, naming where he came from. */
  movedFrom: string | null;
}

export interface SecondOpinionSource {
  for(player: Player): SecondOpinion | undefined;
  /** Player-seasons behind the aging curve, for reporting. */
  fitted: number;
}

/** A season of football is the least history worth comparing against. */
const MIN_GAMES = 16;

export async function fetchSecondOpinion(
  settings: LeagueSettings,
  seasonsBack = 3,
): Promise<SecondOpinionSource> {
  const ids = await fetchPlayerIdIndex();
  const lastSeason = settings.seasonId - 1;

  const history = new Map<string, SeasonStatLine[]>();
  const byPosition = new Map<string, SeasonStatLine[]>();
  for (let season = lastSeason - seasonsBack + 1; season <= lastSeason; season++) {
    try {
      for (const line of await fetchSeasonStats(season)) {
        if (!["QB", "RB", "WR", "TE"].includes(line.position)) continue;
        history.set(line.gsisId, [...(history.get(line.gsisId) ?? []), line]);
        byPosition.set(line.position, [...(byPosition.get(line.position) ?? []), line]);
      }
    } catch {
      // A season that will not download is less history, not a failure.
    }
  }

  // The aging curve, fitted from the same seasons. Without it the disagreement
  // sorts almost perfectly by age, which is a curve showing through rather
  // than anything a manager can act on.
  const rateByKey = new Map<string, number>();
  for (const [gsisId, lines] of history) {
    for (const line of lines) {
      if (line.games < 8) continue;
      const rate = scoreStatLine(line, settings, line.position as never).pointsPerGame;
      if (rate > 0) rateByKey.set(`${line.season}:${gsisId}`, rate);
    }
  }
  const observations: AgeObservation[] = [];
  for (const [key, rate] of rateByKey) {
    const [seasonText, gsisId] = key.split(":");
    const next = rateByKey.get(`${Number(seasonText) + 1}:${gsisId}`);
    if (next === undefined) continue;
    const identity = ids.byGsisId.get(gsisId);
    if (!identity?.position) continue;
    const age = ageAtSeason(identity, Number(seasonText));
    if (age === null) continue;
    observations.push({ position: identity.position as never, age, delta: next - rate });
  }
  const curve = buildAgeCurve(observations);
  const baselines = positionalBaselines(byPosition as never, settings);

  // Per-player answers are deterministic for the life of this source, and the
  // board asks about hundreds of players per request, every eight seconds.
  // Recomputing the projection each time was most of the CPU between a tapped
  // pick and the board reacting.
  const memo = new Map<number, SecondOpinion | undefined>();

  return {
    fitted: observations.length,
    for(player) {
      if (memo.has(player.id)) return memo.get(player.id);
      const answer = compute(player);
      memo.set(player.id, answer);
      return answer;
    },
  };

  function compute(player: Player): SecondOpinion | undefined {
    {
      if (!["QB", "RB", "WR", "TE"].includes(player.position)) return undefined;
      const identity = ids.byEspnId.get(player.id);
      const lines = identity?.gsisId ? history.get(identity.gsisId) : undefined;
      if (!identity || !lines?.length) return undefined;

      const ageBySeason = new Map<number, number>();
      for (const line of lines) {
        const was = ageAtSeason(identity, line.season);
        if (was !== null) ageBySeason.set(line.season, was);
      }
      const targetAge = ageAtSeason(identity, settings.seasonId);
      const aging =
        targetAge !== null && ageBySeason.size
          ? {
              ageBySeason,
              targetAge,
              between: (from: number, to: number) =>
                curve.between(player.position as never, from, to),
            }
          : undefined;

      const own = componentProjection(
        lines,
        settings,
        player.position,
        (baselines[player.position as never] as number | undefined) ?? 0,
        aging,
      );
      if (!own || own.gamesOfHistory < MIN_GAMES) return undefined;

      const comparison = compareToForecast(player.seasonProjectedPoints, own, player.name);
      const move = detectTeamChange(player, lines);
      return {
        relativeGap: comparison.relativeGap,
        fromOwnProduction: own.points,
        gamesOfHistory: own.gamesOfHistory,
        ageAdjustment: own.ageAdjustment,
        note: comparison.note,
        movedFrom: move?.changed ? move.from : null,
      };
    }
  }
}
