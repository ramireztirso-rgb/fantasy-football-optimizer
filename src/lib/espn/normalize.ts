import {
  BENCH_SLOT_IDS,
  POSITION_BY_ID,
  PRO_TEAM_BY_ID,
  SLOT_BY_ID,
  STAT_SOURCE,
  STAT_SPLIT,
} from "./constants";
import { effectiveScoringPoints, scoringPointsByPosition, STAT_META } from "./stats";
import type {
  RawDraftDetail,
  RawLeagueResponse,
  RawMatchup,
  RawPlayer,
  RawPlayerPoolEntry,
  RawRosterEntry,
  RawTeam,
} from "./raw";
import type {
  DraftSettings,
  DraftStatus,
  DraftType,
  League,
  LeagueSettings,
  Matchup,
  Player,
  PlayerStatLine,
  Position,
  RosterSlot,
  Team,
} from "@/lib/domain/types";

/** Extra context normalization needs that does not live on the player object. */
export interface NormalizeContext {
  week: number;
  seasonId: number;
  /** proTeamId -> bye week. Empty map is fine; bye then reads as 0/unknown. */
  byeWeeks: Record<number, number>;
}

const VALID_POSITIONS = new Set<string>(["QB", "RB", "WR", "TE", "K", "DST"]);

function toPosition(id: number | undefined): Position {
  const name = id === undefined ? undefined : POSITION_BY_ID[id];
  // Defense entries occasionally arrive with an unmapped id; everything else
  // that we cannot place is bucketed as WR so it still ranks rather than throws.
  return (name && VALID_POSITIONS.has(name) ? name : "WR") as Position;
}

function playerName(p: RawPlayer): string {
  if (p.fullName) return p.fullName;
  const joined = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return joined || `Player ${p.id}`;
}

/**
 * Pulls the per-week and season stat blocks out of ESPN's flat `stats` array.
 *
 * ESPN mixes four kinds of block into one list, distinguished by
 * (statSourceId, statSplitTypeId). Getting this pairing wrong is the single
 * easiest way to silently show projections as if they were results.
 */
export function extractStats(p: RawPlayer, ctx: NormalizeContext) {
  const blocks = p.stats ?? [];
  let projectedPoints = 0;
  let seasonProjectedPoints = 0;
  let seasonPoints = 0;
  const gameLog: PlayerStatLine[] = [];

  for (const b of blocks) {
    if (b.seasonId !== undefined && b.seasonId !== ctx.seasonId) continue;
    const projected = b.statSourceId === STAT_SOURCE.PROJECTED;
    const weekly = b.statSplitTypeId === STAT_SPLIT.WEEK;
    const total = b.appliedTotal ?? 0;

    if (weekly && projected && b.scoringPeriodId === ctx.week) {
      projectedPoints = total;
    } else if (!weekly && projected) {
      seasonProjectedPoints = total;
    } else if (!weekly && !projected) {
      seasonPoints = total;
    } else if (weekly && !projected && b.scoringPeriodId !== undefined) {
      // A future week can appear with a zeroed actual block; keep only weeks
      // that have already been played.
      if (b.scoringPeriodId < ctx.week || (b.scoringPeriodId === ctx.week && total > 0)) {
        gameLog.push({
          week: b.scoringPeriodId,
          points: total,
          raw: b.stats ?? {},
          applied: b.appliedStats ?? {},
        });
      }
    }
  }

  gameLog.sort((a, b) => a.week - b.week);
  return { projectedPoints, seasonProjectedPoints, seasonPoints, gameLog };
}

export function normalizePlayer(p: RawPlayer, ctx: NormalizeContext): Player {
  const { projectedPoints, seasonProjectedPoints, seasonPoints, gameLog } = extractStats(p, ctx);
  const ownership = p.ownership ?? {};
  const proTeamId = p.proTeamId ?? 0;
  const standardRank = p.draftRanksByRankType?.STANDARD?.rank ?? p.draftRanksByRankType?.PPR?.rank;

  return {
    id: p.id,
    name: playerName(p),
    position: toPosition(p.defaultPositionId),
    proTeam: PRO_TEAM_BY_ID[proTeamId] ?? "FA",
    eligibleSlots: (p.eligibleSlots ?? [])
      .map((id) => SLOT_BY_ID[id])
      .filter((s): s is string => Boolean(s)),
    injuryStatus: p.injuryStatus ?? (p.injured ? "OUT" : undefined),
    byeWeek: ctx.byeWeeks[proTeamId] ?? 0,
    percentOwned: round2(ownership.percentOwned ?? 0),
    percentOwnedDelta: round2(ownership.percentChange ?? 0),
    percentStarted: round2(ownership.percentStarted ?? 0),
    projectedPoints: round2(projectedPoints),
    seasonProjectedPoints: round2(seasonProjectedPoints),
    seasonPoints: round2(seasonPoints),
    gameLog,
    averageDraftPosition:
      ownership.averageDraftPosition && ownership.averageDraftPosition > 0
        ? ownership.averageDraftPosition
        : Number.POSITIVE_INFINITY,
    draftRank: standardRank ?? Number.POSITIVE_INFINITY,
  };
}

export function normalizePlayerPool(
  entries: RawPlayerPoolEntry[] | undefined,
  ctx: NormalizeContext,
): Player[] {
  const out: Player[] = [];
  for (const entry of entries ?? []) {
    if (!entry.player?.id) continue;
    out.push(normalizePlayer(entry.player, ctx));
  }
  return out;
}

function normalizeRosterEntry(e: RawRosterEntry, ctx: NormalizeContext): RosterSlot | null {
  const raw = e.playerPoolEntry?.player;
  if (!raw?.id) return null;
  const slotId = e.lineupSlotId ?? 20;
  return {
    slot: SLOT_BY_ID[slotId] ?? "BE",
    player: normalizePlayer(raw, ctx),
    benched: BENCH_SLOT_IDS.has(slotId),
  };
}

export function normalizeTeam(t: RawTeam, ctx: NormalizeContext, faabBudget?: number): Team {
  const overall = t.record?.overall ?? {};
  const spent = t.transactionCounter?.acquisitionBudgetSpent ?? 0;
  const roster: RosterSlot[] = [];
  for (const e of t.roster?.entries ?? []) {
    const slot = normalizeRosterEntry(e, ctx);
    if (slot) roster.push(slot);
  }

  // ESPN splits the display name across `name` on newer seasons and
  // location+nickname on older ones.
  const name =
    t.name?.trim() ||
    [t.location, t.nickname].filter(Boolean).join(" ").trim() ||
    `Team ${t.id}`;

  return {
    id: t.id,
    name,
    abbrev: t.abbrev ?? `T${t.id}`,
    owners: t.owners ?? [],
    wins: overall.wins ?? 0,
    losses: overall.losses ?? 0,
    ties: overall.ties ?? 0,
    pointsFor: round2(overall.pointsFor ?? 0),
    pointsAgainst: round2(overall.pointsAgainst ?? 0),
    faabRemaining: faabBudget === undefined ? undefined : Math.max(0, faabBudget - spent),
    waiverPriority: t.waiverRank,
    roster,
  };
}

export function normalizeSettings(raw: RawLeagueResponse, week: number): LeagueSettings {
  const s = raw.settings ?? {};
  const counts = s.rosterSettings?.lineupSlotCounts ?? {};
  const lineupSlots: LeagueSettings["lineupSlots"] = [];
  let benchSlots = 0;
  let irSlots = 0;

  for (const [slotId, count] of Object.entries(counts)) {
    if (!count) continue;
    const id = Number(slotId);
    const slot = SLOT_BY_ID[id];
    if (!slot) continue;
    if (id === 20) benchSlots = count;
    else if (id === 21 || id === 24) irSlots += count;
    else lineupSlots.push({ slot, count });
  }
  lineupSlots.sort((a, b) => startingSlotOrder(a.slot) - startingSlotOrder(b.slot));

  const scoringItems = s.scoringSettings?.scoringItems ?? [];
  const scoringRules = scoringItems
    .filter((i) => i.statId !== undefined)
    .map((i) => {
      const statId = i.statId as number;
      return {
        statId,
        // Custom values live in pointsOverrides, not points -- see
        // effectiveScoringPoints. Reading `points` alone misses every rule the
        // league customized.
        points: effectiveScoringPoints(i),
        pointsByPosition: scoringPointsByPosition(i) ?? undefined,
        standard: STAT_META[statId]?.standard,
      };
    });
  // Stat 53 is receptions; its value is what makes a league PPR, half-PPR, or
  // standard. Read it at wide receiver specifically: a league can pay catches
  // to receivers and tight ends but not to running backs, and the headline
  // "is this PPR" question is asking about receivers.
  const receptionRule = scoringRules.find((r) => r.statId === 53);
  const reception = receptionRule?.pointsByPosition?.WR ?? receptionRule?.points ?? 0;

  return {
    name: s.name ?? "ESPN League",
    size: s.size ?? raw.teams?.length ?? 0,
    currentWeek: week,
    seasonId: raw.seasonId ?? new Date().getFullYear(),
    lineupSlots,
    benchSlots,
    irSlots,
    isPPR: reception > 0,
    pointsPerReception: reception,
    faabBudget: s.acquisitionSettings?.acquisitionBudget,
    usesFaab: Boolean(s.acquisitionSettings?.isUsingAcquisitionBudget),
    scoringRules,
    draft: normalizeDraftSettings(raw),
    playoffTeamCount: s.scheduleSettings?.playoffTeamCount ?? 4,
    regularSeasonWeeks: s.scheduleSettings?.matchupPeriodCount ?? 14,
  };
}

const STARTING_SLOT_ORDER = ["QB", "TQB", "RB", "RB/WR", "WR", "WR/TE", "TE", "FLEX", "OP", "DST", "K"];
function startingSlotOrder(slot: string): number {
  const i = STARTING_SLOT_ORDER.indexOf(slot);
  return i === -1 ? 99 : i;
}

function normalizeMatchup(m: RawMatchup, week: number): Matchup | null {
  if (m.home?.teamId === undefined) return null;
  const side = (s: NonNullable<RawMatchup["home"]>) => ({
    teamId: s.teamId as number,
    points: round2(s.totalPoints ?? 0),
    projectedPoints: round2(s.totalProjectedPointsLive ?? s.totalPoints ?? 0),
  });
  return {
    week: m.matchupPeriodId ?? week,
    home: side(m.home),
    away: m.away?.teamId === undefined ? undefined : side(m.away),
    live: !m.winner || m.winner === "UNDECIDED",
  };
}

export function normalizeLeague(
  raw: RawLeagueResponse,
  ctx: NormalizeContext,
  myTeamId?: number,
): League {
  const settings = normalizeSettings(raw, ctx.week);
  const faabBudget = settings.usesFaab ? settings.faabBudget : undefined;
  const teams = (raw.teams ?? []).map((t) => normalizeTeam(t, ctx, faabBudget));
  const matchups = (raw.schedule ?? [])
    .map((m) => normalizeMatchup(m, ctx.week))
    .filter((m): m is Matchup => m !== null);

  return {
    id: String(raw.id ?? ""),
    settings,
    teams,
    matchups,
    myTeamId,
  };
}

/**
 * Finds the team owned by the SWID-identified member.
 *
 * ESPN keys team ownership by the same GUID that the SWID cookie carries, so
 * this is exact when the cookie is present and simply absent when it is not.
 */
export function resolveMyTeamId(raw: RawLeagueResponse, swid: string | undefined): number | undefined {
  if (!swid) return undefined;
  const target = swid.toUpperCase();
  for (const team of raw.teams ?? []) {
    if ((team.owners ?? []).some((o) => o.toUpperCase() === target)) return team.id;
  }
  return undefined;
}

/** Lineup slot 21 is injured reserve, which the draft never fills. */
const IR_SLOT_ID = 21;

const DRAFT_TYPES = new Set<DraftType>(["SNAKE", "AUCTION", "OFFLINE"]);

export function normalizeDraftSettings(raw: RawLeagueResponse): DraftSettings {
  const d = raw.settings?.draftSettings ?? {};
  const roster = raw.settings?.rosterSettings?.lineupSlotCounts ?? {};
  // Rounds equal the roster spots the draft actually fills. Injured-reserve
  // slots are roster spots but are never drafted into, so counting them
  // invents a final round and, with it, a phantom last pick that the
  // "can I wait a round" call would treat as a real fallback.
  const rounds = Object.entries(roster).reduce(
    (sum, [slotId, n]) => (Number(slotId) === IR_SLOT_ID ? sum : sum + (n ?? 0)),
    0,
  );
  const rawType = (d.type ?? "").toUpperCase() as DraftType;

  return {
    type: DRAFT_TYPES.has(rawType) ? rawType : "UNKNOWN",
    pickOrder: d.pickOrder ?? [],
    rounds: rounds || 16,
    auctionBudget: d.auctionBudget,
    keeperCount: d.keeperCount ?? 0,
    timePerSelectionSeconds: d.timePerSelection,
    startsAt: d.date ? new Date(d.date).toISOString() : undefined,
  };
}

/**
 * Draft board state.
 *
 * ESPN publishes picks on `mDraftDetail` as they are made, which is what lets
 * the app follow a live draft instead of asking the user to type picks in.
 * Pick numbers are recomputed from position in the list when ESPN omits them,
 * which it does for keepers in some leagues.
 */
/**
 * Draft length read off the published pick grid, which outranks any count
 * derived from roster settings because it is what ESPN will actually run.
 *
 * Only a pre-published grid qualifies. ESPN marks unmade picks with a
 * non-positive `playerId`, so the presence of one proves every slot is listed;
 * without that, the list is just the picks made so far and dividing it by the
 * league size would report a draft that is two rounds long.
 */
function roundsFromSkeleton(
  detail: RawDraftDetail | undefined,
  leagueSize: number,
): number | undefined {
  const picks = detail?.picks ?? [];
  if (!leagueSize || picks.length === 0 || picks.length % leagueSize !== 0) return undefined;
  const hasPlaceholder = picks.some((p) => typeof p.playerId === "number" && p.playerId <= 0);
  return hasPlaceholder ? picks.length / leagueSize : undefined;
}

export function normalizeDraftStatus(
  detail: RawDraftDetail | undefined,
  settings: DraftSettings,
  leagueSize: number,
): DraftStatus {
  const picks = (detail?.picks ?? [])
    // Once the draft order is set -- days before the draft itself -- ESPN
    // publishes the complete pick skeleton, one placeholder per slot, with
    // `playerId: -1`. Those are scheduled picks, not made ones, so a presence
    // check on playerId would read an undrafted league as fully drafted.
    .filter((p) => typeof p.playerId === "number" && p.playerId > 0 && p.teamId !== undefined)
    .map((p, index) => {
      const overallPick = p.overallPickNumber && p.overallPickNumber > 0 ? p.overallPickNumber : index + 1;
      const size = leagueSize || 1;
      return {
        overallPick,
        round: p.roundId && p.roundId > 0 ? p.roundId : Math.floor((overallPick - 1) / size) + 1,
        roundPick:
          p.roundPickNumber && p.roundPickNumber > 0
            ? p.roundPickNumber
            : ((overallPick - 1) % size) + 1,
        teamId: p.teamId as number,
        playerId: p.playerId as number,
        keeper: Boolean(p.keeper || p.reservedForKeeper),
        bidAmount: p.bidAmount && p.bidAmount > 0 ? p.bidAmount : undefined,
      };
    })
    .sort((a, b) => a.overallPick - b.overallPick);

  return {
    settings: { ...settings, rounds: roundsFromSkeleton(detail, leagueSize) ?? settings.rounds },
    completed: Boolean(detail?.drafted),
    inProgress: Boolean(detail?.inProgress),
    picks,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
