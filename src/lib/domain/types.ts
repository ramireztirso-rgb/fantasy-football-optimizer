/**
 * The app's internal vocabulary. Nothing downstream of `espn/normalize.ts`
 * should ever see an ESPN numeric ID.
 */

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DST";

export interface PlayerStatLine {
  /** NFL week; 0 means a season-long aggregate. */
  week: number;
  /** Fantasy points under *this league's* scoring settings. */
  points: number;
  /** Raw ESPN stat map, keyed by stat id. Kept for usage-trend analysis. */
  raw: Record<string, number>;
  /**
   * Points contributed by each stat under this league's rules, keyed by stat
   * id. This is what makes custom scoring explainable: it shows that a
   * player's value comes from receptions or passing volume rather than from
   * a projection the app cannot account for.
   */
  applied: Record<string, number>;
}

export interface Player {
  id: number;
  name: string;
  position: Position;
  proTeam: string;
  /** Slot ids ESPN says this player is eligible for. */
  eligibleSlots: string[];
  injuryStatus?: string;
  /** NFL week this player's team is off. 0 when unknown. */
  byeWeek: number;
  /** Percentage of ESPN leagues rostering this player, 0-100. */
  percentOwned: number;
  /** Change in `percentOwned` over the last week. The waiver-wire tell. */
  percentOwnedDelta: number;
  /** Percentage of ESPN leagues *starting* this player, 0-100. */
  percentStarted: number;
  /** ESPN's projection for the current week, in league-scoring points. */
  projectedPoints: number;
  /** ESPN's projection for the full season. */
  seasonProjectedPoints: number;
  /** Actual weekly results so far this season, most recent last. */
  gameLog: PlayerStatLine[];
  /** Season-to-date actual total. */
  seasonPoints: number;
  /** ESPN's average draft position, if known. Infinity when undrafted. */
  averageDraftPosition: number;
  /** ESPN's positional rank in its own preseason rankings. */
  draftRank: number;
}

export interface RosterSlot {
  slot: string;
  player: Player;
  /** True when the player occupies a bench/IR slot rather than a starting one. */
  benched: boolean;
}

export interface Team {
  id: number;
  name: string;
  abbrev: string;
  owners: string[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Remaining FAAB budget, when the league uses one. */
  faabRemaining?: number;
  waiverPriority?: number;
  roster: RosterSlot[];
}

export interface LineupSlotCount {
  slot: string;
  count: number;
}

export interface ScoringRule {
  statId: number;
  /**
   * Points per unit as this league actually scores it, overrides applied.
   * Representative only when `pointsByPosition` is set -- see that field.
   */
  points: number;
  /**
   * Present when the league pays different positions differently for this
   * stat, which ESPN allows and some leagues use heavily: half a point per
   * reception for receivers and tight ends but nothing for running backs, say.
   * A position reading 0 here earns nothing for the stat; it is a rule, not a
   * gap in the data.
   */
  pointsByPosition?: Partial<Record<Position, number>>;
  /** The platform default, for spotting what this league customized. */
  standard?: number;
}

export type DraftType = "SNAKE" | "AUCTION" | "OFFLINE" | "UNKNOWN";

export interface DraftSettings {
  type: DraftType;
  /** Team ids in round-one order; index 0 picks first. Empty when unpublished. */
  pickOrder: number[];
  /** Total rounds, derived from roster size. */
  rounds: number;
  auctionBudget?: number;
  keeperCount: number;
  timePerSelectionSeconds?: number;
  /** ISO timestamp of the scheduled draft, when set. */
  startsAt?: string;
}

export interface DraftPick {
  overallPick: number;
  round: number;
  roundPick: number;
  teamId: number;
  playerId: number;
  keeper: boolean;
  /** Auction leagues only. */
  bidAmount?: number;
}

export interface DraftStatus {
  settings: DraftSettings;
  completed: boolean;
  inProgress: boolean;
  /** Picks made so far, in draft order. */
  picks: DraftPick[];
}

export interface LeagueSettings {
  name: string;
  size: number;
  currentWeek: number;
  seasonId: number;
  /** Starting-lineup shape, e.g. 1 QB / 2 RB / 2 WR / 1 TE / 1 FLEX / ... */
  lineupSlots: LineupSlotCount[];
  benchSlots: number;
  irSlots: number;
  /** True when receptions are worth anything at all. */
  isPPR: boolean;
  pointsPerReception: number;
  /** FAAB budget per team, when acquisitions are bid-based. */
  faabBudget?: number;
  usesFaab: boolean;
  scoringRules: ScoringRule[];
  draft: DraftSettings;
  playoffTeamCount: number;
  regularSeasonWeeks: number;
}

export interface MatchupTeam {
  teamId: number;
  points: number;
  projectedPoints: number;
}

export interface Matchup {
  week: number;
  home: MatchupTeam;
  away?: MatchupTeam;
  /** True while the games in this matchup are still being played. */
  live: boolean;
}

export interface League {
  id: string;
  settings: LeagueSettings;
  teams: Team[];
  matchups: Matchup[];
  /** The team belonging to the configured user, when identifiable. */
  myTeamId?: number;
}
