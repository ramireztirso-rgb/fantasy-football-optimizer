import type { League, Player, Position, Team } from "@/lib/domain/types";
import { ReasonBuilder, type Reason } from "./explain";
import { projectPlayer, recentForm, type Projection } from "./projections";
import { computeReplacementLevels, type ReplacementLevels } from "./replacement";
import { expandSlots, optimizeLineup } from "./lineup";
import { SLOT_ELIGIBILITY } from "@/lib/espn/constants";

/** Positions with a deep, self-replenishing wire; never worth real budget. */
const STREAMABLE = new Set<Position>(["K", "DST"]);

/**
 * Waiver wire strategy.
 *
 * The mistake this module exists to prevent is ranking the wire by raw
 * projected points. A 9-point WR is worthless to a team already starting three
 * better ones. What matters is the *marginal upgrade to your starting lineup*,
 * which is what `lineupUpgrade` measures, plus how likely the player is to keep
 * that value for the rest of the season.
 */

export interface WaiverTarget {
  player: Player;
  projection: Projection;
  score: number;
  /** Points this player would add to your optimal starting lineup this week. */
  lineupUpgrade: number;
  /**
   * Points they would add in a normal week, with byes neutralized. This is the
   * number a FAAB bid should be priced off -- `lineupUpgrade` can be large
   * purely because your starter happens to be on bye right now.
   */
  structuralUpgrade: number;
  /** Suggested FAAB bid as a percentage of the *original* budget. */
  suggestedBidPercent: number;
  /** Suggested FAAB bid in dollars, when the league uses a budget. */
  suggestedBid?: number;
  /** Who to drop for them, cheapest-to-lose first. */
  dropCandidates: DropCandidate[];
  /** How contested this add is likely to be, 0-1. */
  competition: number;
  reasons: Reason[];
}

export interface DropCandidate {
  player: Player;
  /** Points your lineup loses by cutting them. Usually zero for deep bench. */
  costToDrop: number;
  reason: string;
}

export interface WaiverReport {
  week: number;
  weeksRemaining: number;
  faabRemaining?: number;
  targets: WaiverTarget[];
  /** Players on your roster who are no longer earning their spot. */
  dropList: DropCandidate[];
}

export interface WaiverOptions {
  week: number;
  /** Cap on returned targets. */
  limit?: number;
}

export function buildWaiverReport(
  league: League,
  team: Team,
  freeAgents: Player[],
  opts: WaiverOptions,
): WaiverReport {
  const { week } = opts;
  const settings = league.settings;
  const weeksRemaining = Math.max(1, settings.regularSeasonWeeks - week + 1);

  const faProjections = freeAgents.map((p) => projectPlayer(p, { week }));
  const rosterProjections = team.roster.map((r) => projectPlayer(r.player, { week }));
  const replacementLevels = computeReplacementLevels(
    [...faProjections, ...rosterProjections],
    settings,
  );

  const baseline = optimizeLineup(team, settings, { week });
  // Second baseline with byes neutralized, so a one-week hole is not mistaken
  // for a season-long weakness at that position.
  const structuralBaseline = optimizeLineup(team, settings, { week, ignoreBye: true });
  const dropList = buildDropList(team, rosterProjections, replacementLevels, week);

  const targets = faProjections
    .map((proj) =>
      scoreTarget(proj, {
        league,
        team,
        baselinePoints: baseline.optimalPoints,
        structuralBaselinePoints: structuralBaseline.optimalPoints,
        replacementLevels,
        weeksRemaining,
        week,
        dropList,
      }),
    )
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 25);

  return {
    week,
    weeksRemaining,
    faabRemaining: team.faabRemaining,
    targets,
    dropList,
  };
}

interface TargetContext {
  league: League;
  team: Team;
  baselinePoints: number;
  structuralBaselinePoints: number;
  replacementLevels: ReplacementLevels;
  weeksRemaining: number;
  week: number;
  dropList: DropCandidate[];
}

function scoreTarget(proj: Projection, ctx: TargetContext): WaiverTarget {
  const player = proj.player;
  const b = new ReasonBuilder();

  // --- The core number: what this add does to your actual starting lineup ---
  const upgrade = lineupUpgrade(proj, ctx.team, ctx.league, ctx.week, ctx.baselinePoints);
  const structural = lineupUpgrade(
    proj,
    ctx.team,
    ctx.league,
    ctx.week,
    ctx.structuralBaselinePoints,
    true,
  );
  b.setBase(
    upgrade,
    "lineup_upgrade",
    "Starting lineup upgrade",
    upgrade > 0.1
      ? `Adding them raises your optimal week ${ctx.week} lineup by ${upgrade.toFixed(1)} points, replacing your weakest startable ${player.position}.`
      : `They do not crack your starting lineup this week, so the case for them is future value rather than immediate points.`,
  );

  // A large weekly upgrade that disappears once byes are neutralized is a
  // one-week patch, not an asset. Saying so is the difference between a $1
  // streaming claim and a $17 bid that buys nothing after Sunday.
  if (upgrade - structural > 1 && structural < 1) {
    b.note(
      "bye_fill",
      "One-week fill-in",
      `This upgrade exists only because your ${player.position} is on bye in week ${ctx.week}. In a normal week they do not crack your lineup, so bid the minimum and move on.`,
    );
  }

  // --- Rest-of-season value above replacement ---
  const ros = (proj.points - (ctx.replacementLevels[player.position] ?? 0)) * ctx.weeksRemaining;
  if (ros > 0) {
    const bonus = Math.min(ros * 0.06, 8);
    b.add(
      "ros_value",
      "Rest-of-season value",
      `Projects above replacement level at ${player.position} for each of the ${ctx.weeksRemaining} weeks left in the regular season.`,
      bonus,
    );
  }

  // --- Trend: the wire is about catching role changes early ---
  if (player.percentOwnedDelta >= 3) {
    const bonus = Math.min(player.percentOwnedDelta * 0.12, 5);
    b.add(
      "trending_up",
      "Trending up",
      `Added in ${player.percentOwnedDelta.toFixed(0)}% more leagues this week (now ${player.percentOwned.toFixed(0)}% rostered) -- the league is reacting to something.`,
      bonus,
    );
  }

  const form = recentForm(player);
  if (form && form.recentAverage > form.seasonAverage * 1.3 && form.recentAverage > 6) {
    b.add(
      "breakout",
      "Recent breakout",
      `Averaging ${form.recentAverage.toFixed(1)} over the last ${form.window} games against a ${form.seasonAverage.toFixed(1)} season average -- a real usage change, not one spike.`,
      3,
    );
  }

  // --- Low ownership plus real production is the definition of a wire win ---
  if (player.percentOwned < 40 && proj.points > 8) {
    b.add(
      "under_rostered",
      "Still widely available",
      `Only ${player.percentOwned.toFixed(0)}% rostered despite projecting ${proj.points.toFixed(1)} points, so you likely do not need to bid aggressively.`,
      2,
    );
  }

  // --- Availability and bye discounts ---
  if (player.byeWeek === ctx.week) {
    b.add(
      "on_bye_now",
      "On bye this week",
      `On bye in week ${ctx.week}, so this is a stash rather than a starter.`,
      -Math.max(1, upgrade),
    );
  }
  if (player.injuryStatus && ["OUT", "INJURY_RESERVE"].includes(player.injuryStatus.toUpperCase())) {
    b.add(
      "currently_out",
      "Currently out",
      `Listed ${player.injuryStatus.replace(/_/g, " ").toLowerCase()}; only worth a roster spot if you can afford to stash them.`,
      -3,
    );
  }

  // Kickers and defenses are streamed off the wire by everyone every week, so
  // their scarcity value is near zero however well they project. Without this,
  // a bye-week kicker outranks a genuine RB2 on the board.
  if (STREAMABLE.has(player.position)) {
    b.add(
      "streamable",
      "Streamable position",
      `${player.position} is streamed freely off the wire every week -- there is almost always a comparable option next week, so this should not outrank a real skill-position add.`,
      -b.total() * 0.6,
    );
  }

  const competition = estimateCompetition(player, ctx.league);
  if (competition > 0.6) {
    b.note(
      "contested",
      "Contested add",
      `Expect competition: ${(competition * 100).toFixed(0)}% of leagues are moving on this player, and rosters around yours have the same hole.`,
    );
  }

  const score = b.total();
  const { percent, dollars } = suggestBid(score, structural, competition, player.position, ctx);

  if (percent > 0) {
    b.note(
      "bid_guidance",
      `Bid ~${percent}%`,
      ctx.league.settings.usesFaab
        ? `Worth about ${percent}% of your original FAAB${dollars !== undefined ? ` (about $${dollars})` : ""}. Priced off a ${structural.toFixed(1)}-point-per-week upgrade sustained across ${ctx.weeksRemaining} remaining weeks, adjusted for how contested they are.`
        : `Worth using a waiver claim on if your priority is mid-pack or better; this is a ${upgrade.toFixed(1)}-point weekly upgrade.`,
    );
  }

  return {
    player,
    projection: proj,
    score,
    lineupUpgrade: round2(upgrade),
    structuralUpgrade: round2(structural),
    suggestedBidPercent: percent,
    suggestedBid: dollars,
    dropCandidates: ctx.dropList.slice(0, 3),
    competition: round2(competition),
    reasons: b.build(),
  };
}

/**
 * Marginal value of adding one player: re-run the lineup optimizer with them on
 * the roster and take the difference. Exact rather than heuristic, and cheap
 * enough because the matching problem is tiny.
 */
export function lineupUpgrade(
  proj: Projection,
  team: Team,
  league: League,
  week: number,
  baselinePoints: number,
  ignoreBye = false,
): number {
  const augmented: Team = {
    ...team,
    roster: [...team.roster, { slot: "BE", player: proj.player, benched: true }],
  };
  const withPlayer = optimizeLineup(augmented, league.settings, { week, ignoreBye });
  return round2(Math.max(0, withPlayer.optimalPoints - baselinePoints));
}

/**
 * Converts value into a FAAB bid.
 *
 * Anchored on the idea that a marginal weekly starter is worth a few percent
 * and a genuine league-winner is worth a third of the budget. Contested adds
 * get a premium because losing a bid by a dollar wastes the whole claim.
 */
function suggestBid(
  score: number,
  structuralUpgrade: number,
  competition: number,
  position: Position,
  ctx: TargetContext,
): { percent: number; dollars?: number } {
  if (score <= 1) return { percent: 0 };

  // Priced off the upgrade that survives bye-week neutralization, because that
  // is the part you actually keep. A one-week patch is worth a minimum bid.
  const seasonImpact = structuralUpgrade * ctx.weeksRemaining + score;
  const base = Math.min(40, (seasonImpact / 60) * 40);
  // Late-season budget is use-it-or-lose-it, so spend more freely.
  const urgencyMultiplier = ctx.weeksRemaining <= 4 ? 1.35 : 1;
  const contested = 1 + competition * 0.5;

  // Streamable positions are capped hard: there is another one next week.
  const cap = STREAMABLE.has(position) ? 3 : 60;
  const percent = Math.round(Math.min(cap, base * urgencyMultiplier * contested));
  if (percent < 1) return { percent: 0 };

  const budget = ctx.league.settings.faabBudget;
  const dollars =
    ctx.league.settings.usesFaab && budget
      ? Math.max(1, Math.min(ctx.team.faabRemaining ?? budget, Math.round((percent / 100) * budget)))
      : undefined;

  return { percent, dollars };
}

/**
 * How contested an add is. `percentOwnedDelta` is a direct read on how many
 * managers league-wide are already moving, and a player who is nearly fully
 * rostered elsewhere is one your leaguemates have also noticed.
 */
export function estimateCompetition(player: Player, league: League): number {
  const trend = Math.min(1, Math.max(0, player.percentOwnedDelta / 25));
  const scarcity = Math.min(1, player.percentOwned / 70);
  const leagueDepth = Math.min(1, league.settings.size / 14);
  return round2(Math.min(1, trend * 0.55 + scarcity * 0.3 + leagueDepth * 0.15));
}

/**
 * Ranks your own roster from most to least expendable.
 *
 * Cost to drop is measured the same way as an add: what your optimal lineup
 * loses without them. A high-projection player who is buried behind two better
 * ones costs nothing to cut, and that is exactly the insight a raw points sort
 * hides.
 */
export function buildDropList(
  team: Team,
  projections: Projection[],
  levels: ReplacementLevels,
  week: number,
): DropCandidate[] {
  const byId = new Map(projections.map((p) => [p.player.id, p]));
  const candidates: DropCandidate[] = [];

  for (const slot of team.roster) {
    const proj = byId.get(slot.player.id);
    if (!proj) continue;
    const player = slot.player;
    const overReplacement = proj.points - (levels[player.position] ?? 0);

    let reason: string;
    if (player.byeWeek === week) {
      reason = `On bye this week and ${overReplacement > 0 ? "only just" : "not"} above replacement level at ${player.position}.`;
    } else if (player.injuryStatus && ["OUT", "INJURY_RESERVE"].includes(player.injuryStatus.toUpperCase())) {
      reason = `Listed ${player.injuryStatus.replace(/_/g, " ").toLowerCase()} and occupying a roster spot you could use now.`;
    } else if (overReplacement <= 0) {
      reason = `Projects ${Math.abs(overReplacement).toFixed(1)} points below the last startable ${player.position}, so the wire has better.`;
    } else if (player.percentOwnedDelta < -4) {
      reason = `Being dropped across the league (${player.percentOwnedDelta.toFixed(0)}% this week), usually a sign the role is gone.`;
    } else {
      reason = `Startable but redundant: you have better options at ${player.position} every week.`;
    }

    candidates.push({
      player,
      // Only starters cost anything to drop; bench players are free by definition.
      costToDrop: round2(Math.max(0, slot.benched ? 0 : overReplacement)),
      reason,
    });
  }

  // Never suggest cutting someone in your optimal starting lineup first.
  return candidates
    .sort((a, b) => a.costToDrop - b.costToDrop || projPoints(byId, a) - projPoints(byId, b))
    .slice(0, 8);
}

function projPoints(byId: Map<number, Projection>, c: DropCandidate): number {
  return byId.get(c.player.id)?.points ?? 0;
}

/** Positions a team can still slot a new player into without cutting a starter. */
export function openStartingSlots(team: Team, league: League): Position[] {
  const slots = expandSlots(league.settings);
  const filled = new Set(team.roster.filter((r) => !r.benched).map((r) => r.slot));
  const open = new Set<Position>();
  for (const slot of slots) {
    if (filled.has(slot)) continue;
    for (const pos of SLOT_ELIGIBILITY[slot] ?? []) open.add(pos as Position);
  }
  return [...open];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
