import { fetchTextCached } from "./cache";
import { num, parseCsv } from "./csv";

/**
 * The crosswalk between ESPN's player ids and everyone else's.
 *
 * Every outside source is useless until it can be joined to the league's own
 * players, and nobody shares an id space: ESPN has its own, nflverse keys on
 * the NFL's gsis id, ADP sites invent their own. Matching on name is a trap --
 * suffixes, apostrophes, and the four active players named Michael Carter make
 * it wrong exactly where it matters, on the rookies and backups whose value is
 * least certain.
 *
 * DynastyProcess publishes a maintained mapping across all of them, which also
 * happens to carry draft capital and age. That turns out to matter as much as
 * the join: "second-year receiver" and "third-round pick" are not attributes
 * ESPN exposes, and they are the ones every piece of draft folklore is about.
 */

const SOURCE_URL = "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv";

export interface PlayerIdentity {
  espnId: number;
  /** NFL's own id, the key for nflverse statistics. */
  gsisId?: string;
  sleeperId?: string;
  fantasyprosId?: string;
  name: string;
  position?: string;
  team?: string;
  /** Season this player entered the league; undrafted players still carry one. */
  draftYear?: number;
  draftRound?: number;
  /** Overall selection. Undrafted free agents have none. */
  draftPick?: number;
  age?: number;
}

export interface PlayerIdIndex {
  byEspnId: Map<number, PlayerIdentity>;
  byGsisId: Map<string, PlayerIdentity>;
  /** True when the mapping came from a cached copy older than its TTL. */
  stale: boolean;
}

export async function fetchPlayerIdIndex(): Promise<PlayerIdIndex> {
  const { text, stale } = await fetchTextCached(SOURCE_URL, "db_playerids.csv", {
    // Ids change only when players enter the league, so a day-old copy is fine.
    ttlMs: 24 * 60 * 60 * 1000,
  });

  const byEspnId = new Map<number, PlayerIdentity>();
  const byGsisId = new Map<string, PlayerIdentity>();

  for (const row of parseCsv(text)) {
    const espnId = num(row.espn_id);
    if (espnId === undefined) continue;

    const identity: PlayerIdentity = {
      espnId,
      gsisId: clean(row.gsis_id),
      sleeperId: clean(row.sleeper_id),
      fantasyprosId: clean(row.fantasypros_id),
      name: row.name ?? "",
      position: clean(row.position),
      team: clean(row.team),
      draftYear: num(row.draft_year),
      draftRound: num(row.draft_round),
      draftPick: num(row.draft_ovr),
      age: num(row.age),
    };

    // The file carries a row per player-season; the most recent wins, which is
    // what `db_season` orders by. Later rows overwrite earlier ones.
    byEspnId.set(espnId, identity);
    if (identity.gsisId) byGsisId.set(identity.gsisId, identity);
  }

  return { byEspnId, byGsisId, stale };
}

/**
 * Seasons of NFL experience at the start of `season`.
 *
 * Zero for a rookie, one for a second-year player. Returns null when the draft
 * year is unknown rather than guessing, because every claim built on this
 * ("second-year receivers break out") is exactly the claim a silent default
 * would fabricate support for.
 */
export function experienceIn(identity: PlayerIdentity, season: number): number | null {
  if (identity.draftYear === undefined) return null;
  const years = season - identity.draftYear;
  return years >= 0 ? years : null;
}

function clean(value: string | undefined): string | undefined {
  if (!value || value === "NA" || value === "null") return undefined;
  return value;
}
