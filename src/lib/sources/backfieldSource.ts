import type { Player } from "@/lib/domain/types";
import type { BackfieldSource } from "@/lib/engine/backfield";
import { backfieldShares, injuryRecord } from "@/lib/engine/backfield";
import { normalizeTeam } from "@/lib/engine/teamChange";
import { fetchSeasonStats, type SeasonStatLine } from "./nflverse";
import { fetchPlayerIdIndex } from "./playerIds";

/**
 * Assembles the backfield reading the draft board asks for.
 *
 * Kept out of the engine so the engine keeps no idea where any of this comes
 * from. Everything here degrades: a season that will not download, a player
 * with no crosswalk entry, a rookie with no history -- each just means the
 * board says less about that player, never that it fails.
 */
export async function fetchBackfieldSource(
  seasonId: number,
  seasonsOfHistory = 3,
): Promise<BackfieldSource> {
  const lastSeason = seasonId - 1;
  const ids = await fetchPlayerIdIndex();

  const history = new Map<string, SeasonStatLine[]>();
  let latest: SeasonStatLine[] = [];
  for (let season = lastSeason - seasonsOfHistory + 1; season <= lastSeason; season++) {
    try {
      const lines = await fetchSeasonStats(season);
      if (season === lastSeason) latest = lines;
      for (const line of lines) {
        const prior = history.get(line.gsisId) ?? [];
        prior.push(line);
        history.set(line.gsisId, prior);
      }
    } catch {
      // One missing season is less history, not an error.
    }
  }

  const shares = backfieldShares(latest);
  const gsisFor = (player: Player) => ids.byEspnId.get(player.id)?.gsisId;

  const carriesFor = (player: Player): number => {
    const gsis = gsisFor(player);
    return gsis ? (shares.get(gsis)?.carries ?? 0) : 0;
  };

  return {
    roleFor(player) {
      if (player.position !== "RB") return undefined;
      const gsis = gsisFor(player);
      const share = gsis ? shares.get(gsis) : undefined;
      if (!share || share.role === "unknown") return undefined;
      return { role: share.role, share: share.share, splitWith: share.splitWith };
    },

    durabilityFor(player) {
      const gsis = gsisFor(player);
      const lines = gsis ? history.get(gsis) : undefined;
      if (!lines?.length) return undefined;
      const record = injuryRecord(lines);
      if (record.seasons < 2) return undefined;
      return { missedPerSeason: record.missedPerSeason, fragile: record.fragile };
    },

    handcuffTargetFor(player, myRoster) {
      if (player.position !== "RB") return undefined;
      const team = normalizeTeam(player.proTeam);
      if (!team || team === "FA") return undefined;

      const mine = myRoster.filter(
        (p) => p.position === "RB" && normalizeTeam(p.proTeam) === team,
      );
      if (!mine.length) return undefined;

      // Only a handcuff if the player on the roster is the one ahead. Where the
      // candidate took more carries it is the roster player who is the backup,
      // and calling that a handcuff would have it exactly backwards.
      const candidateCarries = carriesFor(player);
      const ahead = mine
        .filter((p) => carriesFor(p) > candidateCarries)
        .sort((a, b) => carriesFor(b) - carriesFor(a))[0];
      return ahead;
    },
  };
}
