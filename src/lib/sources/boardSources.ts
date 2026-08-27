import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LeagueSettings, Player, Position } from "@/lib/domain/types";
import { fetchAdpMarket, type AdpMarket } from "./adp";
import { fetchBackfieldSource } from "./backfieldSource";
import { fetchSecondOpinion, type SecondOpinion } from "./secondOpinion";
import type { BackfieldSource } from "@/lib/engine/backfield";
import type { SecondOpinionSource } from "./secondOpinion";
import { normalizeTeam } from "@/lib/engine/teamChange";

/**
 * The board's outside sources, precomputed to a derived file and rebuilt from
 * it per request.
 *
 * The expensive work -- parsing three seasons of weekly statistics, the 2.6MB
 * id crosswalk, fitting the aging curve -- costs about three seconds, and its
 * *answers* for every player in the pool serialize to a small JSON file. A
 * request loads that and wraps cheap lookups around it: 4ms where assembly
 * cost 3,100. The win over a plain in-memory memo is that the file survives
 * server restarts, so even the first request after a deploy stays fast once
 * any process has built it.
 *
 * A debugging confession that belongs here: this was first built on the
 * theory that module state does not persist between requests in this Next
 * version, because ten consecutive polls each paid full assembly. The real
 * cause was a stale server on the port answering with pre-fix code. Module
 * state persists fine. The derived file is kept because restart-survival is
 * worth having, not because the runtime demands it.
 */

interface DerivedPlayer {
  opinion?: SecondOpinion;
  role?: { role: string; share: number; splitWith: number; snapShare?: number };
  durability?: { missedPerSeason: number; fragile: boolean };
  /** Carries taken last season in the backfield of his current team. */
  carriesHere?: number;
  team?: string;
}

interface DerivedFile {
  seasonId: number;
  builtAt: number;
  fitted: number;
  players: Record<string, DerivedPlayer>;
}

interface Assembled {
  market: AdpMarket | undefined;
  backfield: BackfieldSource | undefined;
  secondOpinion: SecondOpinionSource | undefined;
}

const TTL_MS = 6 * 60 * 60 * 1000;

function derivedPath(seasonId: number): string {
  return join(process.cwd(), ".cache", "derived", `board-sources-${seasonId}.json`);
}

export async function getBoardSources(
  settings: LeagueSettings,
  pool: Player[],
): Promise<Assembled> {
  // The market is two small JSON boards -- cheap enough to fetch per request,
  // and its disk cache absorbs the network. Not part of the derived file.
  const market = await fetchAdpMarket(settings).catch(() => undefined);

  const path = derivedPath(settings.seasonId);
  let derived: DerivedFile | null = null;
  try {
    if (Date.now() - statSync(path).mtimeMs < TTL_MS) {
      derived = JSON.parse(readFileSync(path, "utf8")) as DerivedFile;
    }
  } catch {
    // Absent or unreadable: build it.
  }

  if (!derived || derived.seasonId !== settings.seasonId) {
    derived = await buildDerived(settings, pool);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(derived), "utf8");
    } catch {
      // A cache that cannot be written is slower, not broken.
    }
  }

  return { market, ...hydrate(derived, pool) };
}

async function buildDerived(settings: LeagueSettings, pool: Player[]): Promise<DerivedFile> {
  const [backfield, secondOpinion] = await Promise.all([
    fetchBackfieldSource(settings.seasonId).catch(() => undefined),
    fetchSecondOpinion(settings).catch(() => undefined),
  ]);

  const players: Record<string, DerivedPlayer> = {};
  for (const p of pool) {
    const entry: DerivedPlayer = { team: normalizeTeam(p.proTeam) };
    const opinion = secondOpinion?.for(p);
    if (opinion) entry.opinion = opinion;
    const role = backfield?.roleFor(p);
    if (role) {
      entry.role = role;
      entry.carriesHere = role.share > 0 ? Math.round(role.share * 1000) : 0;
    }
    const durability = backfield?.durabilityFor(p);
    if (durability) entry.durability = durability;
    players[String(p.id)] = entry;
  }
  return {
    seasonId: settings.seasonId,
    builtAt: Date.now(),
    fitted: secondOpinion?.fitted ?? 0,
    players,
  };
}

function hydrate(
  derived: DerivedFile,
  pool: Player[],
): { backfield: BackfieldSource; secondOpinion: SecondOpinionSource } {
  const players = derived.players;
  const get = (p: Player) => players[String(p.id)];

  const backfield: BackfieldSource = {
    roleFor: (p) => get(p)?.role as ReturnType<BackfieldSource["roleFor"]>,
    durabilityFor: (p) => get(p)?.durability,
    // Rebuilt at request time from the tiny per-player table: the deputy is
    // the same-team back with fewer carries than the rostered starter.
    handcuffTargetFor(p, myRoster) {
      if (p.position !== "RB") return undefined;
      const mine = myRoster.filter(
        (r) => r.position === "RB" && get(r)?.team === get(p)?.team,
      );
      const candidate = get(p)?.carriesHere ?? 0;
      const ahead = mine
        .filter((r) => (get(r)?.carriesHere ?? 0) > candidate)
        .sort((a, b) => (get(b)?.carriesHere ?? 0) - (get(a)?.carriesHere ?? 0))[0];
      return ahead;
    },
  };

  const secondOpinion: SecondOpinionSource = {
    fitted: derived.fitted,
    for: (p) => get(p)?.opinion,
  };

  void pool;
  return { backfield, secondOpinion };
}

/** Positions the derived file knows about; exported for tests. */
export const DERIVED_POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];
