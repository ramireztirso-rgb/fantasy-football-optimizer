/**
 * Shapes of the ESPN v3 payloads we actually read.
 *
 * Deliberately loose: ESPN adds and removes fields between seasons without
 * notice, and a missing field should degrade one player's recommendation
 * rather than fail the whole request. `normalize.ts` is responsible for
 * turning these optionals into total domain values.
 */

export interface RawStatBlock {
  scoringPeriodId?: number;
  seasonId?: number;
  statSourceId?: number;
  statSplitTypeId?: number;
  appliedTotal?: number;
  appliedAverage?: number;
  stats?: Record<string, number>;
  /**
   * Raw stats already multiplied by this league's own scoring rules, keyed by
   * stat id. Present on most blocks and is the authority on where a player's
   * points came from under custom scoring.
   */
  appliedStats?: Record<string, number>;
}

export interface RawOwnership {
  percentOwned?: number;
  percentChange?: number;
  percentStarted?: number;
  averageDraftPosition?: number;
  auctionValueAverage?: number;
}

export interface RawPlayer {
  id: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId?: number;
  eligibleSlots?: number[];
  proTeamId?: number;
  injuryStatus?: string;
  injured?: boolean;
  stats?: RawStatBlock[];
  ownership?: RawOwnership;
  draftRanksByRankType?: Record<string, { rank?: number; auctionValue?: number }>;
}

export interface RawPlayerPoolEntry {
  id?: number;
  player?: RawPlayer;
  lineupLocked?: boolean;
  onTeamId?: number;
  ratings?: Record<string, unknown>;
}

export interface RawRosterEntry {
  playerId?: number;
  lineupSlotId?: number;
  acquisitionType?: string;
  playerPoolEntry?: RawPlayerPoolEntry;
}

export interface RawTeam {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  abbrev?: string;
  owners?: string[];
  record?: {
    overall?: { wins?: number; losses?: number; ties?: number; pointsFor?: number; pointsAgainst?: number };
  };
  transactionCounter?: { acquisitionBudgetSpent?: number };
  waiverRank?: number;
  roster?: { entries?: RawRosterEntry[] };
}

export interface RawMatchupSide {
  teamId?: number;
  totalPoints?: number;
  totalProjectedPointsLive?: number;
  rosterForCurrentScoringPeriod?: { entries?: RawRosterEntry[] };
}

export interface RawMatchup {
  matchupPeriodId?: number;
  winner?: string;
  home?: RawMatchupSide;
  away?: RawMatchupSide;
}

export interface RawDraftPick {
  id?: number;
  playerId?: number;
  teamId?: number;
  roundId?: number;
  roundPickNumber?: number;
  overallPickNumber?: number;
  bidAmount?: number;
  keeper?: boolean;
  reservedForKeeper?: boolean;
  memberId?: string;
  lineupSlotId?: number;
  autoDraftTypeId?: number;
}

export interface RawDraftDetail {
  drafted?: boolean;
  inProgress?: boolean;
  picks?: RawDraftPick[];
}

export interface RawSettings {
  name?: string;
  size?: number;
  draftSettings?: {
    type?: string;
    /** Team ids in round-one order. Index 0 drafts first. */
    pickOrder?: number[];
    auctionBudget?: number;
    keeperCount?: number;
    timePerSelection?: number;
    /** Epoch milliseconds. */
    date?: number;
  };
  rosterSettings?: {
    lineupSlotCounts?: Record<string, number>;
  };
  scoringSettings?: {
    scoringItems?: Array<{ statId?: number; points?: number; pointsOverrides?: Record<string, number> }>;
  };
  acquisitionSettings?: {
    acquisitionBudget?: number;
    isUsingAcquisitionBudget?: boolean;
  };
  scheduleSettings?: {
    matchupPeriodCount?: number;
    playoffTeamCount?: number;
  };
}

export interface RawLeagueResponse {
  id?: number;
  seasonId?: number;
  scoringPeriodId?: number;
  status?: {
    currentMatchupPeriod?: number;
    latestScoringPeriod?: number;
    isActive?: boolean;
  };
  settings?: RawSettings;
  draftDetail?: RawDraftDetail;
  teams?: RawTeam[];
  schedule?: RawMatchup[];
  members?: Array<{ id?: string; displayName?: string }>;
  players?: RawPlayerPoolEntry[];
}
