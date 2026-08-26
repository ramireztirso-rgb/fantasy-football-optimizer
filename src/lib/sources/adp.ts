import type { LeagueSettings, Player, Position } from "@/lib/domain/types";
import { fetchTextCached } from "./cache";

/**
 * Where the market is actually drafting players, and how much it disagrees
 * with itself.
 *
 * ESPN publishes an average draft position and nothing else. The board's
 * survival model needs a spread as much as a location -- "will he last twenty
 * more picks" is a question about the width of the distribution, not its
 * centre -- so until now that spread was invented: 28% of the player's own ADP,
 * a guess that makes early picks look far more predictable than late ones for
 * no reason beyond the arithmetic.
 *
 * Fantasy Football Calculator runs real mock drafts and publishes the measured
 * standard deviation, along with the highest and lowest pick each player has
 * gone at. That is the number the model wanted.
 *
 * The format is chosen per position from the league's own reception scoring,
 * which is the sort of thing only possible once scoring resolves per position:
 * this league pays receivers half a point per catch and backs nothing, so its
 * receivers are priced off the half-PPR board and its backs off the standard
 * one. Neither board alone describes this league.
 */

const BASE = "https://fantasyfootballcalculator.com/api/v1/adp";

export interface AdpQuote {
  name: string;
  position: string;
  team: string;
  /** Mean overall pick across the sampled drafts. */
  adp: number;
  /** Measured standard deviation of that pick, in picks. */
  stdev: number;
  high: number;
  low: number;
  timesDrafted: number;
  /** Which FFC board this quote came from. */
  format: string;
}

export interface AdpMarket {
  quoteFor(player: Pick<Player, "name" | "position" | "proTeam">): AdpQuote | undefined;
  /** Measured spread for a player, or undefined when he is unquoted. */
  stdevFor(player: Pick<Player, "name" | "position" | "proTeam">): number | undefined;
  /** Format used for each position, for reporting. */
  formats: Partial<Record<Position, string>>;
  /** Drafts behind each board. */
  sample: number;
  quoted: number;
  stale: boolean;
}

type FfcFormat = "standard" | "half-ppr" | "ppr";

/**
 * The FFC board whose scoring matches what this league pays that position per
 * catch. A position paid nothing per reception is a standard-scoring player
 * however the rest of the league is set up.
 */
function formatForPosition(settings: LeagueSettings, position: Position): FfcFormat {
  const rule = settings.scoringRules.find((r) => r.statId === 53);
  const perCatch = rule?.pointsByPosition ? (rule.pointsByPosition[position] ?? 0) : (rule?.points ?? 0);
  if (perCatch >= 0.75) return "ppr";
  if (perCatch >= 0.25) return "half-ppr";
  return "standard";
}

export async function fetchAdpMarket(
  settings: LeagueSettings,
  season = settings.seasonId,
): Promise<AdpMarket> {
  const positions: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
  const formats: Partial<Record<Position, string>> = {};
  const needed = new Set<FfcFormat>();
  for (const pos of positions) {
    const fmt = formatForPosition(settings, pos);
    formats[pos] = fmt;
    needed.add(fmt);
  }

  const boards = new Map<FfcFormat, Map<string, AdpQuote>>();
  let sample = 0;
  let stale = false;

  for (const fmt of needed) {
    try {
      const { text, stale: wasStale } = await fetchTextCached(
        `${BASE}/${fmt}?teams=${settings.size}&year=${season}`,
        `ffc-${fmt}-${settings.size}-${season}.json`,
        // Mock-draft ADP moves daily in August; hourly is pointless, weekly is stale.
        { ttlMs: 6 * 60 * 60 * 1000, timeoutSeconds: 30 },
      );
      stale = stale || wasStale;
      const parsed = JSON.parse(text) as {
        meta?: { total_drafts?: number };
        players?: Array<Record<string, unknown>>;
      };
      sample += parsed.meta?.total_drafts ?? 0;

      const board = new Map<string, AdpQuote>();
      for (const raw of parsed.players ?? []) {
        const quote: AdpQuote = {
          name: String(raw.name ?? ""),
          position: String(raw.position ?? ""),
          team: String(raw.team ?? ""),
          adp: Number(raw.adp),
          stdev: Number(raw.stdev),
          high: Number(raw.high),
          low: Number(raw.low),
          timesDrafted: Number(raw.times_drafted),
          format: fmt,
        };
        if (!quote.name || !Number.isFinite(quote.adp)) continue;
        board.set(matchKey(quote.name, quote.position, quote.team), quote);
      }
      boards.set(fmt, board);
    } catch {
      // A missing board degrades that position to ESPN's ADP alone rather than
      // failing the draft. Never let an outside source break draft night.
      boards.set(fmt, new Map());
    }
  }

  let quoted = 0;
  for (const board of boards.values()) quoted += board.size;

  const lookup = (player: Pick<Player, "name" | "position" | "proTeam">): AdpQuote | undefined => {
    const fmt = (formats[player.position] ?? "standard") as FfcFormat;
    return boards.get(fmt)?.get(matchKey(player.name, player.position, player.proTeam));
  };

  return {
    quoteFor: lookup,
    stdevFor: (player) => {
      const quote = lookup(player);
      // A player drafted in a handful of mocks has a standard deviation that is
      // itself noise, so it is not allowed to speak for him.
      if (!quote || !Number.isFinite(quote.stdev) || quote.timesDrafted < 20) return undefined;
      return quote.stdev;
    },
    formats,
    sample,
    quoted,
    stale,
  };
}

/** FFC's position vocabulary differs from ESPN's for the two team-ish slots. */
const POSITION_ALIAS: Record<string, string> = { K: "PK", PK: "PK", DST: "DEF", DEF: "DEF" };

/**
 * Join key for a source with no shared id.
 *
 * FFC does not publish a cross-platform id, so this is name-and-position
 * matching, which is exactly the approach the id crosswalk exists to avoid.
 * It is tolerable here and nowhere else: the ADP board is a few hundred
 * well-known players rather than a full roster tail, and an unmatched player
 * costs only his measured spread, falling back to the old estimate.
 */
function matchKey(name: string, position: string, team?: string): string {
  const pos = POSITION_ALIAS[position.toUpperCase()] ?? position.toUpperCase();
  // Defences are keyed on team, because the two sources do not even agree on
  // what to call them -- ESPN's "Texans D/ST" is FFC's "Houston Defense" --
  // while the team abbreviation is unambiguous and unique.
  if (pos === "DEF") return `DEF:${(team ?? "").toUpperCase()}`;

  const normalized = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z]/g, "");
  return `${pos}:${normalized}`;
}
