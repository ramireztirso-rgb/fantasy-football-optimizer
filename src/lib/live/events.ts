import type { League, Player, Team } from "@/lib/domain/types";

/**
 * Real-time updates, defined as *things that changed and what you should do
 * about them* rather than a number that ticked.
 *
 * ESPN has no push API, so the app polls and diffs consecutive snapshots. The
 * diff is where the value is: a scoreboard refresh tells you nothing, but
 * "your RB2 was just ruled out and the best replacement on your bench is worth
 * 6 more points" is the whole product.
 */

export type LeagueEventKind =
  | "injury_change"
  | "player_dropped"
  | "player_added"
  | "projection_swing"
  | "score_update"
  | "lineup_problem"
  | "matchup_swing";

export type EventSeverity = "critical" | "warning" | "info";

export interface LeagueEvent {
  /** Stable id so the client can dedupe across reconnects. */
  id: string;
  kind: LeagueEventKind;
  severity: EventSeverity;
  /** ISO timestamp of when the change was observed. */
  at: string;
  title: string;
  detail: string;
  /** What to do about it, when there is something to do. */
  action?: string;
  playerId?: number;
  teamId?: number;
  /** True when this concerns the configured user's own team. */
  mine: boolean;
}

/** Everything the differ needs to compare two moments in time. */
export interface LeagueSnapshot {
  takenAt: string;
  league: League;
  /** Free agent pool keyed by player id, used to spot adds and drops. */
  freeAgentIds: number[];
}

const OUT_STATUSES = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION", "NOT_ACTIVE", "DOUBTFUL"]);

/**
 * Produces the events that occurred between two snapshots.
 *
 * Ordering matters for the UI: the most consequential change should be first,
 * and "your own starter is out" always outranks "someone else's bench moved".
 */
export function diffSnapshots(prev: LeagueSnapshot, next: LeagueSnapshot): LeagueEvent[] {
  const events: LeagueEvent[] = [];
  const at = next.takenAt;
  const myTeamId = next.league.myTeamId;

  const prevPlayers = indexPlayers(prev.league);
  const nextPlayers = indexPlayers(next.league);
  const prevOwner = ownerIndex(prev.league);
  const nextOwner = ownerIndex(next.league);

  // --- Availability changes on any rostered player ---
  for (const [id, player] of nextPlayers) {
    const before = prevPlayers.get(id);
    if (!before) continue;
    const wasOut = isOut(before.injuryStatus);
    const isNowOut = isOut(player.injuryStatus);
    if (before.injuryStatus === player.injuryStatus) continue;

    const ownerTeamId = nextOwner.get(id);
    const mine = ownerTeamId !== undefined && ownerTeamId === myTeamId;
    const starting = mine && isStarting(next.league, myTeamId, id);

    if (isNowOut && !wasOut) {
      events.push({
        id: `injury:${id}:${player.injuryStatus}:${at}`,
        kind: "injury_change",
        severity: starting ? "critical" : mine ? "warning" : "info",
        at,
        title: `${player.name} is now ${format(player.injuryStatus)}`,
        detail: `${player.name} (${player.position}, ${player.proTeam}) moved from ${format(before.injuryStatus)} to ${format(player.injuryStatus)}.`,
        action: starting
          ? `They are in your starting lineup. Open the Lineup tab for the best replacement before kickoff.`
          : mine
            ? `On your bench, so no immediate action -- but their handcuff may be worth a waiver claim.`
            : `Rostered by another team. If their backup is a free agent, that is a waiver target right now.`,
        playerId: id,
        teamId: ownerTeamId,
        mine,
      });
    } else if (!isNowOut && wasOut) {
      events.push({
        id: `return:${id}:${at}`,
        kind: "injury_change",
        severity: mine ? "warning" : "info",
        at,
        title: `${player.name} is back to ${format(player.injuryStatus)}`,
        detail: `${player.name} upgraded from ${format(before.injuryStatus)} to ${format(player.injuryStatus)}.`,
        action: mine
          ? `Re-check your lineup -- they may be startable again.`
          : `Their replacement just lost value; consider dropping any handcuff you were holding.`,
        playerId: id,
        teamId: ownerTeamId,
        mine,
      });
    }
  }

  // --- Roster moves by other managers ---
  const prevFa = new Set(prev.freeAgentIds);
  const nextFa = new Set(next.freeAgentIds);

  for (const id of nextFa) {
    if (prevFa.has(id)) continue;
    const player = prevPlayers.get(id) ?? nextPlayers.get(id);
    if (!player) continue;
    const formerTeam = prevOwner.get(id);
    events.push({
      id: `dropped:${id}:${at}`,
      kind: "player_dropped",
      severity: player.percentOwned > 50 ? "warning" : "info",
      at,
      title: `${player.name} was dropped`,
      detail: `${player.name} (${player.position}, ${player.proTeam}, ${player.percentOwned.toFixed(0)}% rostered) is now a free agent${formerTeam !== undefined ? ` after being cut by ${teamName(prev.league, formerTeam)}` : ""}.`,
      action: `Check the Waivers tab -- a widely rostered player hitting the wire is the cheapest upgrade you will get.`,
      playerId: id,
      mine: false,
    });
  }

  for (const id of prevFa) {
    if (nextFa.has(id)) continue;
    const player = nextPlayers.get(id) ?? prevPlayers.get(id);
    if (!player) continue;
    const newTeam = nextOwner.get(id);
    if (newTeam === undefined) continue;
    events.push({
      id: `added:${id}:${at}`,
      kind: "player_added",
      severity: newTeam === myTeamId ? "info" : "info",
      at,
      title: `${player.name} was claimed`,
      detail: `${teamName(next.league, newTeam)} picked up ${player.name} (${player.position}, ${player.proTeam}).`,
      action:
        newTeam === myTeamId
          ? `Your claim went through. Set your lineup to account for them.`
          : `Off the board. If they were on your waiver list, the Waivers tab has the next-best fit.`,
      playerId: id,
      teamId: newTeam,
      mine: newTeam === myTeamId,
    });
  }

  // --- Projection swings on your own players ---
  for (const [id, player] of nextPlayers) {
    const before = prevPlayers.get(id);
    if (!before) continue;
    const ownerTeamId = nextOwner.get(id);
    if (ownerTeamId === undefined || ownerTeamId !== myTeamId) continue;
    const delta = player.projectedPoints - before.projectedPoints;
    if (Math.abs(delta) < 3) continue;
    events.push({
      id: `proj:${id}:${round1(player.projectedPoints)}:${at}`,
      kind: "projection_swing",
      severity: Math.abs(delta) >= 6 ? "warning" : "info",
      at,
      title: `${player.name}'s projection moved ${delta > 0 ? "up" : "down"} ${Math.abs(delta).toFixed(1)}`,
      detail: `Now projected ${player.projectedPoints.toFixed(1)} points, was ${before.projectedPoints.toFixed(1)}.`,
      action:
        delta < 0
          ? `A drop this size usually means a role or game-script change. Re-run the lineup optimizer.`
          : `They may now beat someone you have starting ahead of them.`,
      playerId: id,
      teamId: ownerTeamId,
      mine: true,
    });
  }

  // --- Live scoring on your matchup ---
  if (myTeamId !== undefined) {
    const before = findMatchup(prev.league, myTeamId);
    const after = findMatchup(next.league, myTeamId);
    if (before && after) {
      const myBefore = sideFor(before, myTeamId);
      const myAfter = sideFor(after, myTeamId);
      const oppBefore = otherSide(before, myTeamId);
      const oppAfter = otherSide(after, myTeamId);

      const myDelta = (myAfter?.points ?? 0) - (myBefore?.points ?? 0);
      const oppDelta = (oppAfter?.points ?? 0) - (oppBefore?.points ?? 0);

      if (Math.abs(myDelta) > 0.1 || Math.abs(oppDelta) > 0.1) {
        const margin = (myAfter?.points ?? 0) - (oppAfter?.points ?? 0);
        events.push({
          id: `score:${round1(myAfter?.points ?? 0)}:${round1(oppAfter?.points ?? 0)}:${at}`,
          kind: "score_update",
          severity: "info",
          at,
          title: `${(myAfter?.points ?? 0).toFixed(1)} - ${(oppAfter?.points ?? 0).toFixed(1)}`,
          detail: `You scored ${myDelta.toFixed(1)}, your opponent scored ${oppDelta.toFixed(1)}. You are ${margin >= 0 ? "up" : "down"} ${Math.abs(margin).toFixed(1)}.`,
          teamId: myTeamId,
          mine: true,
        });
      }

      // Lead changes are worth calling out separately from every scoring play.
      const marginBefore = (myBefore?.points ?? 0) - (oppBefore?.points ?? 0);
      const marginAfter = (myAfter?.points ?? 0) - (oppAfter?.points ?? 0);
      if (Math.sign(marginBefore) !== Math.sign(marginAfter) && Math.abs(marginAfter) > 0.5) {
        events.push({
          id: `swing:${round1(marginAfter)}:${at}`,
          kind: "matchup_swing",
          severity: "warning",
          at,
          title: marginAfter > 0 ? "You just took the lead" : "You just lost the lead",
          detail: `Your matchup flipped: you are now ${marginAfter > 0 ? "ahead" : "behind"} by ${Math.abs(marginAfter).toFixed(1)}.`,
          action:
            marginAfter < 0
              ? `If you still have players yet to play, the high-ceiling option is now the right call over the safe one.`
              : undefined,
          teamId: myTeamId,
          mine: true,
        });
      }
    }
  }

  return events.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/** Standing problems with the current lineup, recomputed on every poll. */
export function lineupProblems(league: League, at: string): LeagueEvent[] {
  const myTeamId = league.myTeamId;
  if (myTeamId === undefined) return [];
  const team = league.teams.find((t) => t.id === myTeamId);
  if (!team) return [];
  const week = league.settings.currentWeek;
  const problems: LeagueEvent[] = [];

  for (const slot of team.roster) {
    if (slot.benched) continue;
    const p = slot.player;
    if (p.byeWeek === week) {
      problems.push({
        id: `bye:${p.id}:${week}`,
        kind: "lineup_problem",
        severity: "critical",
        at,
        title: `${p.name} is on bye and starting`,
        detail: `${p.name} occupies your ${slot.slot} slot but ${p.proTeam} does not play in week ${week}.`,
        action: `Swap them out. The Lineup tab has the best available replacement.`,
        playerId: p.id,
        teamId: myTeamId,
        mine: true,
      });
    } else if (isOut(p.injuryStatus)) {
      problems.push({
        id: `out:${p.id}:${week}:${p.injuryStatus}`,
        kind: "lineup_problem",
        severity: "critical",
        at,
        title: `${p.name} is ${format(p.injuryStatus)} and starting`,
        detail: `${p.name} is listed ${format(p.injuryStatus)} in your ${slot.slot} slot.`,
        action: `Replace them before kickoff or you are starting a zero.`,
        playerId: p.id,
        teamId: myTeamId,
        mine: true,
      });
    }
  }
  return problems;
}

function indexPlayers(league: League): Map<number, Player> {
  const map = new Map<number, Player>();
  for (const team of league.teams) {
    for (const slot of team.roster) map.set(slot.player.id, slot.player);
  }
  return map;
}

function ownerIndex(league: League): Map<number, number> {
  const map = new Map<number, number>();
  for (const team of league.teams) {
    for (const slot of team.roster) map.set(slot.player.id, team.id);
  }
  return map;
}

function isStarting(league: League, teamId: number | undefined, playerId: number): boolean {
  if (teamId === undefined) return false;
  const team = league.teams.find((t) => t.id === teamId);
  return Boolean(team?.roster.some((r) => r.player.id === playerId && !r.benched));
}

function findMatchup(league: League, teamId: number) {
  return league.matchups.find(
    (m) => m.week === league.settings.currentWeek && (m.home.teamId === teamId || m.away?.teamId === teamId),
  );
}

function sideFor(matchup: NonNullable<ReturnType<typeof findMatchup>>, teamId: number) {
  return matchup.home.teamId === teamId ? matchup.home : matchup.away;
}

function otherSide(matchup: NonNullable<ReturnType<typeof findMatchup>>, teamId: number) {
  return matchup.home.teamId === teamId ? matchup.away : matchup.home;
}

function teamName(league: League, teamId: number): string {
  return league.teams.find((t) => t.id === teamId)?.name ?? `Team ${teamId}`;
}

function isOut(status: string | undefined): boolean {
  return Boolean(status && OUT_STATUSES.has(status.toUpperCase()));
}

function format(status: string | undefined): string {
  return (status ?? "active").replace(/_/g, " ").toLowerCase();
}

function severityRank(s: EventSeverity): number {
  return s === "critical" ? 0 : s === "warning" ? 1 : 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
