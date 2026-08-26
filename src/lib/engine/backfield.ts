import type { Player } from "@/lib/domain/types";
import type { SeasonStatLine } from "@/lib/sources/nflverse";
import { normalizeTeam } from "./teamChange";

/**
 * Who actually gets the ball, and who is one hamstring away from getting it.
 *
 * A projection says how many points a back is expected to score. It does not
 * say whether he got there as the only back his team uses or as one of three
 * splitting the work, and those are different bets. The sole back has a stable
 * floor; the committee back is one coaching decision from irrelevance and one
 * injury from a league-winner. Same projection, opposite risk.
 *
 * It also does not say who inherits the job. A backup behind a workhorse is
 * nearly worthless while the workhorse is upright and close to a first-round
 * back the moment he is not, and that bet is worth more the more often the
 * starter gets hurt.
 *
 * None of this is in a points total, and all of it is in the carry counts.
 */

/** Share of a team's backfield below which nobody is really the starter. */
const COMMITTEE_CEILING = 0.55;
/** Share above which a back is carrying the offence on his own. */
const WORKHORSE_FLOOR = 0.68;

export type BackfieldRole = "workhorse" | "committee" | "rotational" | "unknown";

export interface BackfieldShare {
  gsisId: string;
  name: string;
  team: string;
  carries: number;
  /** His share of his team's running back carries, 0-1. */
  share: number;
  role: BackfieldRole;
  /** Backs who took at least a tenth of the same backfield. */
  splitWith: number;
}

/**
 * Backfield shares for one season, keyed by player.
 *
 * Deliberately measured within a season and a team rather than league-wide: the
 * question is what fraction of *this* offence a back was, and a team that runs
 * often would otherwise make all its backs look like workhorses.
 */
export function backfieldShares(lines: SeasonStatLine[]): Map<string, BackfieldShare> {
  const byTeam = new Map<string, SeasonStatLine[]>();
  for (const line of lines) {
    if (line.position !== "RB" || !line.team || line.carries <= 0) continue;
    const team = normalizeTeam(line.team);
    const group = byTeam.get(team) ?? [];
    group.push(line);
    byTeam.set(team, group);
  }

  const shares = new Map<string, BackfieldShare>();
  for (const [team, group] of byTeam) {
    const total = group.reduce((sum, l) => sum + l.carries, 0);
    if (total < 100) continue; // Too few carries to describe a backfield.
    const meaningful = group.filter((l) => l.carries / total >= 0.1).length;

    for (const line of group) {
      const share = line.carries / total;
      shares.set(line.gsisId, {
        gsisId: line.gsisId,
        name: line.name,
        team,
        carries: line.carries,
        share: round3(share),
        role:
          share >= WORKHORSE_FLOOR
            ? "workhorse"
            : share >= COMMITTEE_CEILING
              ? "rotational"
              : share > 0.15
                ? "committee"
                : "unknown",
        splitWith: meaningful,
      });
    }
  }
  return shares;
}

export interface InjuryRecord {
  /** Seasons of evidence. */
  seasons: number;
  /** Average games missed per season, out of a 17-game year. */
  missedPerSeason: number;
  /** True once a back has missed enough, often enough, to plan around. */
  fragile: boolean;
}

/**
 * How much time a player tends to miss.
 *
 * Counted from games played rather than any injury report, because a report
 * says what is wrong now and this is asking what usually happens. Two seasons
 * is the minimum: one missed year is bad luck and the label should not stick
 * to somebody for it.
 */
export function injuryRecord(history: SeasonStatLine[], gamesInSeason = 17): InjuryRecord {
  const seasons = history.filter((l) => l.games > 0);
  if (seasons.length < 2) return { seasons: seasons.length, missedPerSeason: 0, fragile: false };

  const missed = seasons.reduce((sum, l) => sum + Math.max(0, gamesInSeason - l.games), 0);
  const perSeason = missed / seasons.length;
  return {
    seasons: seasons.length,
    missedPerSeason: round1(perSeason),
    // Three games a season, sustained, is a player you cannot rely on for a
    // full year -- and the number that makes his backup worth a pick.
    fragile: perSeason >= 3,
  };
}

export interface Handcuff {
  starter: Player;
  /** Null when nobody behind him took enough of the backfield to count. */
  backup: Player | null;
  /** The starter's share of the backfield last season, when known. */
  starterShare: number | null;
  starterMissedPerSeason: number;
  /** Why this pairing is worth a pick, or null when it is not. */
  detail: string | null;
}

/**
 * The back who inherits the job, for each of your running backs.
 *
 * Identified by current team and draft position rather than last season's
 * usage, because a backfield's pecking order is a fact about this year and the
 * carries are evidence about last one. The most-drafted back on a team is
 * treated as the starter and the next one as his handcuff.
 */
export function findHandcuffs(
  myRoster: Player[],
  pool: Player[],
  shares: Map<string, BackfieldShare>,
  gsisIdFor: (player: Player) => string | undefined,
  injuryFor: (player: Player) => InjuryRecord,
  isRookie: (player: Player) => boolean = () => false,
): Handcuff[] {
  const out: Handcuff[] = [];

  for (const starter of myRoster) {
    if (starter.position !== "RB") continue;
    const team = normalizeTeam(starter.proTeam);

    // Ranked by who actually took carries in this backfield, not by draft
    // position. Everybody undrafted shares the same capped average draft
    // position, so ordering by it picks essentially at random among them -- and
    // it picked a fullback as Christian McCaffrey's handcuff, which is how the
    // fault announced itself. A rookie has no carries and is judged separately,
    // because the reason a team drafts a back is precisely that he will get
    // some.
    const candidates = pool
      .filter((p) => p.position === "RB" && p.id !== starter.id && normalizeTeam(p.proTeam) === team)
      .map((p) => {
        const gsis = gsisIdFor(p);
        const share = gsis ? shares.get(gsis) : undefined;
        // Carries only count as evidence about this backfield if they were
        // taken in it.
        const here = share && share.team === team ? share : undefined;
        return { player: p, carries: here?.carries ?? 0, rookie: isRookie(p) };
      })
      .filter((c) => c.carries >= 20 || c.rookie)
      .sort((a, b) => b.carries - a.carries || a.player.averageDraftPosition - b.player.averageDraftPosition);

    const gsis = gsisIdFor(starter);
    const share = gsis ? (shares.get(gsis)?.share ?? null) : null;
    const injury = injuryFor(starter);
    const best = candidates[0];

    if (!best) {
      out.push({
        starter,
        backup: null,
        starterShare: share,
        starterMissedPerSeason: injury.missedPerSeason,
        detail: `No back behind ${starter.name} took a meaningful share of this backfield last season, so there is nobody obvious to handcuff. That is worth knowing on its own -- the carries would be up for grabs rather than going to a known deputy.`,
      });
      continue;
    }

    // A handcuff is only worth a pick when the job it inherits is worth having
    // and there is a real chance of inheriting it. Behind a committee back
    // there is no job to inherit: the carries are already split.
    const worthHaving = share === null || share >= COMMITTEE_CEILING;
    const detail = !worthHaving
      ? `${starter.name} only took ${((share ?? 0) * 100).toFixed(0)}% of this backfield, so there is no full job for ${best.player.name} to inherit -- the carries are already shared out. Not worth a pick.`
      : injury.fragile
        ? `${starter.name} took ${share === null ? "most" : `${(share * 100).toFixed(0)}%`} of his backfield and has missed about ${injury.missedPerSeason} games a season across ${injury.seasons} years. ${best.player.name} inherits a real workload the week that happens, which is what makes him worth a late pick rather than a curiosity.`
        : `${best.player.name} is the back behind ${starter.name}${best.rookie ? ", drafted into the role this year" : ` on ${best.carries} carries last season`}. ${starter.name} has been durable, so this is insurance rather than a priority -- but it is a whole workload if it is ever needed.`;

    out.push({
      starter,
      backup: best.player,
      starterShare: share,
      starterMissedPerSeason: injury.missedPerSeason,
      detail,
    });
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
