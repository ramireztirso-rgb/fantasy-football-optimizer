import type { LeagueSettings, Player, Position } from "@/lib/domain/types";
import { survivalGivenNeeds, type LiveDraftContext } from "./draftLive";
import { ReasonBuilder, type Reason } from "./explain";
import { projectPlayer, type Projection } from "./projections";
import {
  assignTiers,
  computeReplacementLevels,
  rosterFeasibility,
  rosterNeed,
  starterDemand,
  type ReplacementLevels,
} from "./replacement";
import { levelsAvailableLater, marginalValue } from "./marginalValue";

export { rosterNeed };

/**
 * Draft assistant.
 *
 * The ranking is opportunity-cost based rather than "best player available".
 * The question that actually decides a pick is not "who is best" but "who will
 * still be here at my next turn" -- taking a player who would have survived
 * another round is how drafts are lost. That reasoning is made explicit via
 * the survival probability derived from ADP.
 */

/**
 * A measured view of where the market drafts a player.
 *
 * Declared structurally rather than imported so the engine keeps no dependency
 * on how the data arrives. Whatever supplies it -- a live ADP board, a cached
 * file, a test fixture -- the board only asks two questions.
 */
export interface AdpSpreadSource {
  /** Measured standard deviation of a player's draft slot, in picks. */
  stdevFor(player: Player): number | undefined;
  quoteFor?(player: Player): { adp: number; stdev: number; timesDrafted: number } | undefined;
}

/**
 * How far ESPN and the wider market have to differ before it is worth saying.
 *
 * Both conditions have to hold, because either alone flags the wrong players.
 * A gap in picks alone scales with where a player goes -- six picks apart at
 * the top of the board is a chasm and twenty picks apart at the end is noise --
 * so the gap is also measured against the market's own spread. And that alone
 * would flag a three-pick difference on a player the market is unusually
 * certain about, which is real and useless. Statistically detectable and worth
 * acting on are different questions; this asks both.
 */
const MARKET_DISAGREEMENT_PICKS = 8;
const MARKET_DISAGREEMENT_SIGMA = 2;

/**
 * What a player's backfield looks like, and how durable he has been.
 *
 * Structural, like the ADP source, so the engine stays free of any knowledge of
 * where the data comes from or how it is fetched.
 */
export interface BackfieldSource {
  /** How a back was used last season, when that is known. */
  roleFor(player: Player):
    | { role: string; share: number; splitWith: number }
    | undefined;
  /** How much time he tends to miss. */
  durabilityFor(player: Player): { missedPerSeason: number; fragile: boolean } | undefined;
  /**
   * The back on your roster this player would replace, when he is the deputy in
   * a backfield you already own the starter in.
   */
  handcuffTargetFor(player: Player, myRoster: Player[]): Player | undefined;
}

/**
 * An independent read on what a player is worth, structural like the others so
 * the engine never learns where it came from.
 */
export interface SecondOpinionSource {
  for(player: Player):
    | {
        relativeGap: number;
        fromOwnProduction: number;
        gamesOfHistory: number;
        note: string | null;
        movedFrom: string | null;
      }
    | undefined;
}

export interface DraftState {
  /** Overall pick number currently on the clock. */
  pickNumber: number;
  /** My next pick after this one; in a snake draft this is often 20+ picks later. */
  nextPickNumber: number;
  /** Player ids already off the board. */
  drafted: Set<number>;
  /** Players I have already taken. */
  myRoster: Player[];
  /**
   * Live ESPN draft state, when connected. Its presence switches the survival
   * model from national ADP to what the specific teams ahead of you still need.
   */
  live?: LiveDraftContext;
  /**
   * Measured draft-slot spreads. Absent, the board estimates them, which is
   * worse but never fatal: an outside source must not be able to break a draft.
   */
  market?: AdpSpreadSource;
  /**
   * Backfield usage and durability. Absent, the board simply says less about
   * running backs; nothing depends on it.
   */
  backfield?: BackfieldSource;
  /**
   * The player's own recent production, aged and scored under this league's
   * rules, as a check on the forecast. Absent, the board simply has one
   * opinion, which is where it started.
   */
  secondOpinion?: SecondOpinionSource;
}

export interface DraftRecommendation {
  player: Player;
  projection: Projection;
  /** Final ranking score, in points-above-replacement units. */
  score: number;
  vorp: number;
  tier: number;
  /** Points lost if this tier empties before my next pick. */
  tierDropoff: number;
  /** Players left in this tier. */
  tierRemaining: number;
  /** Probability the player is still available at my next pick, 0-1. */
  survivalProbability: number;
  /** How that probability was derived. */
  survivalBasis: "adp" | "league-needs";
  reasons: Reason[];
}

/**
 * A group of players who are worth about the same, whatever position they play.
 *
 * The board's existing tiers are per-position, which answers "is there a cliff
 * after this tight end" and cannot answer the question a manager on the clock
 * actually asks: of everyone in front of me, who is genuinely equivalent, and
 * given that, who fits my roster best?
 *
 * Bands are cut on the score, which is what a player is worth to this roster.
 * That is a change: they used to be cut on value over replacement and then
 * ordered by fit, because value and fit were two separate numbers. They are not
 * any more. The score is the points a player adds to your lineup, so it already
 * is the fit, and grouping by anything else would be grouping by a number the
 * board no longer ranks on.
 */
export interface ValueBand {
  /** 1 is the most valuable band on the board. */
  band: number;
  /** Members, best fit for this roster first. */
  players: DraftRecommendation[];
  valueHigh: number;
  valueLow: number;
  /** Raw value given up by waiting for the next band down. */
  dropoff: number;
  /**
   * Set when fit reorders the band -- when the most valuable player in it is
   * not the one to take. This is the whole point of the grouping.
   */
  fitNote: string | null;
}

export interface DraftBoard {
  recommendations: DraftRecommendation[];
  /**
   * Recommendations grouped into bands of equivalent value, best fit first
   * within each. Empty when the board is too short to cluster meaningfully.
   */
  tiers: ValueBand[];
  /** Positional runs and cliffs worth knowing about right now. */
  boardNotes: Reason[];
  replacementLevels: ReplacementLevels;
}

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * Positions you stream off the wire all season. Their value-over-replacement
 * can look competitive in the middle rounds -- especially in a league where the
 * top defense projects far above the twelfth -- but spending a pick there is
 * still wrong, because the alternative is not "a worse defense", it is "any
 * defense, for free, every week, plus a real player with this pick".
 */
const STREAMABLE = new Set<Position>(["K", "DST"]);

/**
 * Score every locked-out player is driven beneath. Far below any real
 * value-over-replacement so the ordering question never arises.
 */
const ROSTER_LOCK_FLOOR = -1000;

/**
 * Score a second kicker or defence is driven beneath. Below every real player,
 * including the unstartable ones, and still above a roster-illegal pick.
 */
const BACKUP_STREAM_FLOOR = -500;

/**
 * Total rounds in the draft.
 *
 * Starters plus bench, and deliberately *not* IR: an injured-reserve slot is
 * filled from the wire once somebody gets hurt, not spent on draft night.
 * Counting it made the board believe it had one more pick than it did, which
 * is exactly the pick it needed for a kicker.
 */
function draftRounds(settings: LeagueSettings): number {
  const starters = settings.lineupSlots.reduce((sum, s) => sum + s.count, 0);
  return starters + settings.benchSlots || 16;
}

export function buildDraftBoard(
  pool: Player[],
  settings: LeagueSettings,
  state: DraftState,
  limit = 40,
): DraftBoard {
  // Season-long projections drive draft value; the weekly number is noise here.
  const opts = { week: 1 } as const;
  const project = (p: Player) => {
    const proj = projectPlayer(p, opts);
    // Swap in the season projection as the value being ranked.
    return { ...proj, points: p.seasonProjectedPoints || proj.points * 17 };
  };

  const projections = pool.filter((p) => !state.drafted.has(p.id)).map(project);

  // Two different baselines, doing two different jobs.
  //
  // `replacementLevels` is what a freely available player gives you, measured
  // against the whole pool so it does not slide around as the draft empties. It
  // is what the reported value-over-replacement means.
  //
  // `waitLevels` is the interesting one: the best player you can still expect
  // to get at each position at your *next* turn. That is the real alternative
  // to taking somebody now, and pricing against it is what stops the board
  // spending a fourth-round pick on a defence that will still be sitting there
  // in the fifteenth.
  const replacementLevels = computeReplacementLevels(pool.map(project), settings);
  const need = rosterNeed(state.myRoster, settings);

  // Tiers are computed per position, since a cliff is a positional idea.
  const tierByPlayer = new Map<number, { tier: number; dropoff: number; remaining: number }>();
  for (const pos of POSITIONS) {
    const posProjections = projections.filter((p) => p.player.position === pos);
    for (const [id, tier] of assignTiers(posProjections)) tierByPlayer.set(id, tier);
  }

  const picksUntilNextTurn = Math.max(0, state.nextPickNumber - state.pickNumber);

  // Value function shared with the opponent model, so the teams ahead of you
  // are simulated against the same board you are looking at.
  const pointsById = new Map(projections.map((p) => [p.player.id, p.points]));
  const valueOf = (p: Player) =>
    (pointsById.get(p.id) ?? p.seasonProjectedPoints) - (replacementLevels[p.position] ?? 0);
  const teamStates = new Map((state.live?.teams ?? []).map((t) => [t.teamId, t]));
  const availablePlayers = projections.map((p) => p.player);

  const survives = (p: Player) =>
    survivalProbability(p, state.pickNumber, state.nextPickNumber, state.market?.stdevFor(p));
  const waitLevels =
    state.nextPickNumber > state.pickNumber
      ? levelsAvailableLater(projections, replacementLevels, survives)
      : replacementLevels;

  const rosterWithPoints = state.myRoster.map((p) => ({ player: p, points: project(p).points }));

  const rounds = draftRounds(settings);
  const currentRound = Math.floor((state.pickNumber - 1) / (settings.size || 12)) + 1;

  // Picks are a resource like any other, and by the late rounds they are the
  // binding one. `slack` counts the picks not already owed to an empty
  // starting slot; when it runs out, "best player available" stops being a
  // legal answer.
  const picksRemaining = Math.max(0, rounds - currentRound + 1);
  const feasibility = rosterFeasibility(state.myRoster, settings, picksRemaining);

  // Per-team starter demand, used to measure how deep past useful a position
  // already is on this roster.
  const size = settings.size || 12;
  const leagueDemand = starterDemand(settings);
  const perTeamDemand = {} as Record<Position, number>;
  for (const pos of POSITIONS) perTeamDemand[pos] = leagueDemand[pos] / size;

  const owned = {} as Record<Position, number>;
  for (const pos of POSITIONS) owned[pos] = 0;
  for (const p of state.myRoster) owned[p.position] = (owned[p.position] ?? 0) + 1;

  // Working out a player's marginal value means solving a small lineup problem
  // twice, which is cheap individually and not cheap five hundred times a pick.
  // Only players who could plausibly be recommended get one: a shortlist by raw
  // value over replacement, several times longer than the board being returned,
  // so nobody who could have made it is cut. Everyone else keeps a value of
  // zero, which is very nearly true of them anyway.
  const overReplacement = (proj: Projection) =>
    proj.points - (replacementLevels[proj.player.position] ?? 0);
  const byValue = [...projections].sort((a, b) => overReplacement(b) - overReplacement(a));

  const shortlist = new Set(byValue.slice(0, Math.max(90, limit * 3)).map((p) => p.player.id));

  // Plus the best few at every position, without which the shortlist quietly
  // decides the answer. Kickers and defences sit near the bottom on value over
  // replacement always, including in the final rounds when an empty slot makes
  // them the most valuable pick on the board -- shortlisting on the old measure
  // cut them before the new one could ever see them, and they disappeared from
  // the end of the draft entirely.
  for (const pos of POSITIONS) {
    for (const proj of byValue.filter((p) => p.player.position === pos).slice(0, 8)) {
      shortlist.add(proj.player.id);
    }
  }

  const marginalCtx = {
    settings,
    levels: waitLevels,
    roster: rosterWithPoints,
    picksRemaining,
  };
  const marginalById = new Map<number, number>();
  for (const proj of projections) {
    if (!shortlist.has(proj.player.id)) continue;
    marginalById.set(proj.player.id, marginalValue(proj.player, proj.points, marginalCtx));
  }

  const recommendations = projections
    .map((proj) =>
      score(proj, {
        marginal: marginalById.get(proj.player.id) ?? 0,
        settings,
        state,
        replacementLevels,
        need,
        feasibility,
        perTeamDemand,
        owned,
        picksRemaining,
        tierByPlayer,
        picksUntilNextTurn,
        rounds,
        currentRound,
        valueOf,
        availablePlayers,
        teamStates,
      }),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    recommendations,
    tiers: bandByValue(recommendations),
    boardNotes: buildBoardNotes(projections, tierByPlayer, state, picksUntilNextTurn),
    replacementLevels,
  };
}

interface ScoreContext {
  settings: LeagueSettings;
  state: DraftState;
  replacementLevels: ReplacementLevels;
  /** Points this player adds to the best lineup the roster could field. */
  marginal: number;
  need: Record<Position, number>;
  feasibility: ReturnType<typeof rosterFeasibility>;
  perTeamDemand: Record<Position, number>;
  owned: Record<Position, number>;
  picksRemaining: number;
  tierByPlayer: Map<number, { tier: number; dropoff: number; remaining: number }>;
  picksUntilNextTurn: number;
  rounds: number;
  currentRound: number;
  valueOf: (p: Player) => number;
  availablePlayers: Player[];
  teamStates: Map<number, LiveDraftContext["teams"][number]>;
}

function score(proj: Projection, ctx: ScoreContext): DraftRecommendation {
  const player = proj.player;
  const pos = player.position;
  const b = new ReasonBuilder();

  const replacement = ctx.replacementLevels[pos] ?? 0;
  const vorpValue = round2(proj.points - replacement);

  /**
   * What the player is actually worth: the points he adds to the best starting
   * lineup this roster could field, priced against the best player you could
   * still expect to get for that slot at your next turn.
   *
   * This replaces value over replacement as the thing being ranked. The old
   * measure graded the player in isolation and then corrected for the roster
   * with a stack of percentage adjustments, which is what kept going wrong:
   * percentages of a number that can be negative turn penalties into rewards,
   * and percentages of a number near zero stop mattering at all. Asking what he
   * adds to the lineup answers the roster question directly, in points, and
   * cannot come out negative.
   *
   * Value over replacement is still reported, because it is a familiar and
   * useful thing to see. It just no longer decides anything.
   */
  const value = ctx.marginal;
  const scale = value;

  b.setBase(
    value,
    "marginal_value",
    "Points added to your lineup",
    `Adding ${player.name} improves the best lineup this roster can field by about ${value.toFixed(0)} points over the season, measured against the best ${pos} you could still expect to get at pick ${ctx.state.nextPickNumber}.`,
  );

  b.note(
    "vorp",
    "Value over replacement",
    `Projected ${proj.points.toFixed(0)} points on the season, ${vorpValue.toFixed(0)} more than the last startable ${pos} in a ${ctx.settings.size}-team league.`,
  );

  // Roster need and positional saturation used to live here as percentage
  // adjustments. Both are now inside the base: a player who fills a hole
  // improves the lineup a lot, and a sixth running back improves it by nothing,
  // without anybody having to choose a coefficient for either.

  // --- Survival: will they be there at my next turn? ---
  const measuredSd = ctx.state.market?.stdevFor(player);
  const adpSurvival = survivalProbability(
    player,
    ctx.state.pickNumber,
    ctx.state.nextPickNumber,
    measuredSd,
  );
  const intervening = ctx.state.live?.interveningTeams ?? [];

  // When connected to a live draft, what the teams ahead of you actually need
  // beats national ADP -- but ADP still carries real information about consensus
  // value, so it stays in as a prior rather than being discarded.
  let survival = adpSurvival;
  let survivalBasis: DraftRecommendation["survivalBasis"] = "adp";
  if (intervening.length) {
    const needsSurvival = survivalGivenNeeds(
      player,
      ctx.valueOf,
      ctx.availablePlayers,
      intervening,
      ctx.teamStates,
    );
    survival = round2(0.65 * needsSurvival + 0.35 * adpSurvival);
    survivalBasis = "league-needs";
  }

  const tier = ctx.tierByPlayer.get(player.id) ?? { tier: 1, dropoff: 0, remaining: 1 };

  if (survivalBasis === "league-needs") {
    const hungry = intervening.filter(
      (id) => (ctx.teamStates.get(id)?.need[player.position] ?? 0) > 0,
    ).length;
    b.note(
      "needs_model",
      hungry ? `${hungry} of ${intervening.length} teams ahead need ${player.position}` : `Nobody ahead needs ${player.position}`,
      hungry
        ? `${hungry} of the ${intervening.length} teams picking before your next turn still have a starting ${player.position} slot open, which is what drives the ${(survival * 100).toFixed(0)}% survival estimate rather than national ADP.`
        : `None of the ${intervening.length} teams picking before you still need a starting ${player.position}, so ${player.name} is likelier to fall than ADP alone suggests.`,
    );
  }

  // Both of these were score adjustments and are now notes, because the base
  // already prices them. A player likely to last is compared against himself,
  // so his value collapses on its own; discounting him again would count the
  // same fact twice.
  if (ctx.picksUntilNextTurn > 0) {
    if (survival > 0.6) {
      b.note(
        "likely_to_last",
        "Can wait",
        `About a ${(survival * 100).toFixed(0)}% chance they are still on the board at pick ${ctx.state.nextPickNumber}, so you can likely take a scarcer position first and still get them.`,
      );
    } else if (survival < 0.25) {
      b.note(
        "last_chance",
        "Now or never",
        `Only about a ${(survival * 100).toFixed(0)}% chance they last until pick ${ctx.state.nextPickNumber}. If you want them, this is the turn.`,
      );
    }
  }

  // --- Tier cliff, and price against the market ---
  //
  // All notes, carrying no score. Each of these was a flat bonus in points --
  // up to twelve for a cliff, eight for a player falling past his usual draft
  // slot -- which was noise beside a base in the hundreds and is decisive
  // beside a base that is correctly zero. That is exactly how this change first
  // went wrong: backup quarterbacks scored nothing on merit, collected twenty
  // points of flat bonuses, and the board took eight of them.
  //
  // The information is still worth showing. It just cannot be allowed to
  // outrank whether the player improves your lineup at all.
  if (tier.remaining <= 2 && tier.dropoff >= 8) {
    b.note(
      "tier_cliff",
      "Last of the tier",
      `Only ${tier.remaining} player${tier.remaining === 1 ? "" : "s"} left in this ${pos} tier, and the next tier down is about ${tier.dropoff.toFixed(0)} points worse over the season.`,
    );
  }

  if (Number.isFinite(player.averageDraftPosition)) {
    const adp = player.averageDraftPosition;
    const slip = adp - ctx.state.pickNumber;
    if (slip >= 8) {
      b.note(
        "adp_value",
        "Falling",
        `Typically drafted around pick ${adp.toFixed(0)} but still available at ${ctx.state.pickNumber} -- ${slip.toFixed(0)} picks of surplus value.`,
      );
    } else if (slip <= -12) {
      b.note(
        "adp_reach",
        "A reach",
        `Usually goes around pick ${adp.toFixed(0)}; taking them at ${ctx.state.pickNumber} is roughly ${Math.abs(slip).toFixed(0)} picks early.`,
      );
    }
  }

  // --- Bye congestion ---
  const byeClash = ctx.state.myRoster.filter(
    (p) => p.byeWeek && p.byeWeek === player.byeWeek && isStartingPosition(p.position),
  ).length;
  if (player.byeWeek && byeClash >= 2) {
    b.add(
      "bye_stack",
      "Bye week pileup",
      `You already have ${byeClash} starters on a week ${player.byeWeek} bye; adding another means a thin lineup that week.`,
      -Math.min(3, byeClash),
    );
  }

  // --- Where the wider market disagrees with the platform ---
  //
  // Carried as information and not as score. The market view comes from
  // thousands of drafts and is a fair second opinion on what a player is worth,
  // but every number this board ranks on is ESPN's, so moving the score on this
  // would be betting against ESPN's own projection using ESPN's own projection
  // to keep score. It cannot be validated here, and a manager reading the board
  // is better placed to judge it than an unvalidated coefficient.
  //
  // It matters most in this specific league because everyone in it drafts
  // inside ESPN's room looking at ESPN's board: a player the market rates far
  // higher than ESPN does is one who will likely still be sitting there.
  const quote = ctx.state.market?.quoteFor?.(player);
  if (quote && Number.isFinite(player.averageDraftPosition)) {
    const gap = round2(player.averageDraftPosition - quote.adp);
    // Floored: a spread the market reports as near zero would divide a trivial
    // gap into a huge number of standard deviations.
    const sigmas = Math.abs(gap) / Math.max(quote.stdev, 1.5);
    if (Math.abs(gap) >= MARKET_DISAGREEMENT_PICKS && sigmas >= MARKET_DISAGREEMENT_SIGMA) {
      b.note(
        "market_disagreement",
        gap > 0 ? "The market likes him more than ESPN" : "ESPN likes him more than the market",
        gap > 0
          ? `ESPN has him going around pick ${player.averageDraftPosition.toFixed(0)}, the wider market around ${quote.adp.toFixed(0)} across ${quote.timesDrafted} drafts. Your league drafts inside ESPN's room off ESPN's board, so he is likelier to be sitting there than his real price suggests.`
          : `ESPN has him going around pick ${player.averageDraftPosition.toFixed(0)} against ${quote.adp.toFixed(0)} in the wider market across ${quote.timesDrafted} drafts. Your leaguemates see ESPN's number, so expect him to go earlier here than he would anywhere else -- and ask what the market knows that ESPN does not.`,
      );
    }
  }

  // --- Where the forecast and the player's own record disagree ---
  //
  // Notes, not score, and for a sharper reason than the others: the board
  // ranks on ESPN's projection, so scoring its disagreement with ESPN would be
  // betting against the forecast while using the same forecast to keep score.
  // The disagreement cannot be adjudicated here -- a gap on a young player is
  // usually a role change the history has not seen, and often right. What can
  // be done is to stop it being invisible on the clock.
  const opinion = ctx.state.secondOpinion?.for(player);
  if (opinion?.note) {
    b.note(
      "second_opinion",
      opinion.relativeGap >= 0 ? "Forecast outruns his record" : "His record outruns the forecast",
      opinion.note,
    );
  }
  if (opinion?.movedFrom) {
    b.note(
      "changed_teams",
      `New team (was ${opinion.movedFrom})`,
      `${player.name} has moved from ${opinion.movedFrom}, which makes his own history the least reliable guide on this board: the targets and carries it extrapolates belonged to a different offence. Weigh the projection over the track record here.`,
    );
  }

  // --- How the backfield is shared, and who inherits it ---
  //
  // Notes rather than score, for the same reason the market disagreement is.
  // A projection already contains the touches a back is expected to get; what
  // it cannot show is how fragile that arrangement is. Two backs projected for
  // the same points, one taking eighty-seven percent of his team's carries and
  // one splitting three ways, are the same number and opposite bets -- and
  // which bet suits a roster is a judgement about the rest of the roster, not
  // a coefficient.
  //
  // Scoring it would also be unverifiable here. The seat sweep grades rosters
  // on projected points, which cannot see an injury that has not happened, so
  // it would rate a handcuff at zero no matter how sound the reasoning.
  const role = ctx.state.backfield?.roleFor(player);
  if (role) {
    if (role.role === "workhorse") {
      b.note(
        "backfield_workhorse",
        "Owns the backfield",
        `Took ${(role.share * 100).toFixed(0)}% of his team's carries last season. That is about as secure as a running back's workload gets, and it is the part of a projection that usually holds up.`,
      );
    } else if (role.role === "committee") {
      b.note(
        "backfield_committee",
        "Shares the backfield",
        `Took only ${(role.share * 100).toFixed(0)}% of his team's carries last season, split ${role.splitWith} ways. The projection may be right on average and still swing hard either way, because a coaching preference decides it rather than his ability.`,
      );
    }
  }

  const durability = ctx.state.backfield?.durabilityFor(player);
  if (durability?.fragile) {
    b.note(
      "durability",
      "Misses time",
      `Has missed about ${durability.missedPerSeason} games a season. Worth planning around rather than avoiding -- it is the reason to spend a late pick on whoever plays when he does not.`,
    );
  }

  const handcuffTarget = ctx.state.backfield?.handcuffTargetFor(player, ctx.state.myRoster);
  if (handcuffTarget) {
    const targetDurability = ctx.state.backfield?.durabilityFor(handcuffTarget);
    b.note(
      "handcuff",
      `Handcuff for ${handcuffTarget.name}`,
      targetDurability?.fragile
        ? `The back behind ${handcuffTarget.name}, who has missed about ${targetDurability.missedPerSeason} games a season. This is not depth -- it is the same workload you already paid for, insured.`
        : `The back behind ${handcuffTarget.name}, already on your roster. Worth a late pick to protect a starter you are relying on.`,
    );
  }

  if (player.injuryStatus && player.injuryStatus.toUpperCase() !== "ACTIVE") {
    b.note(
      "injury_flag",
      `Listed ${player.injuryStatus.replace(/_/g, " ").toLowerCase()}`,
      `Currently listed ${player.injuryStatus.replace(/_/g, " ").toLowerCase()} -- confirm the timeline before spending this pick.`,
    );
  }

  // Applied last so it scales against everything else the player earned.
  if (STREAMABLE.has(pos)) {
    const running = b.total();

    if (!ctx.feasibility.mustFill.has(pos) && running > 0) {
      // A second kicker is not depth, it is nothing. Every other position keeps
      // some value as injury cover; these two are refilled off waivers in the
      // minute it takes to notice, so once the slot is covered the next one is
      // worth as close to zero as the board can say. Timing does not enter into
      // it -- this holds in the final round as much as the first.
      // Driven below zero rather than merely shrunk. Trimming a positive value
      // by any percentage leaves a positive value, and late in a draft every
      // real player left is below replacement and therefore negative -- so a
      // heavily discounted backup kicker still wins. This is a "never", so it
      // is expressed the same way the roster lock is.
      b.add(
        "stream_backup",
        `You already have a ${pos}`,
        `${pos} is the one position with no depth value at all: if yours has a bad matchup or a bye you take a different one off the wire that week, for free. A second ${pos} spends a pick on something waivers give away.`,
        BACKUP_STREAM_FLOOR + running * 0.001 - running,
      );
    } else {
      // Full value only in the last two rounds; near zero before that.
      const roundsLeft = ctx.rounds - ctx.currentRound;
      const readiness = roundsLeft <= 1 ? 1 : roundsLeft <= 2 ? 0.6 : 0.03;
      if (readiness < 1 && running > 0) {
        b.add(
          "stream_position",
          "Draft this last",
          `${pos} is streamed off the wire every week, so drafting one in round ${ctx.currentRound} of ${ctx.rounds} costs you a real player for a spot you can fill for free later. Take one in the final two rounds.`,
          -running * (1 - readiness),
        );
      }
    }
  }

  // Applied dead last, because this is a constraint rather than a preference:
  // no amount of value elsewhere on the board can outrank it.
  const { slack, mustFill, outstanding } = ctx.feasibility;
  if (!mustFill.has(pos) && slack <= 2 && outstanding > 0) {
    const running = b.total();
    const empty = [...mustFill].join(", ");
    if (slack <= 0) {
      // Every remaining pick is owed to a slot that would otherwise be empty on
      // week one. Taking anyone else is not a worse pick, it is an illegal
      // roster, so the player leaves the top of the board entirely. The
      // surviving thousandth keeps the locked-out players in sensible order
      // relative to each other rather than collapsing them into a tie.
      b.add(
        "roster_lock",
        `No pick left to spend on ${pos}`,
        `You have ${ctx.picksRemaining} pick${ctx.picksRemaining === 1 ? "" : "s"} left and ${outstanding} starting slot${outstanding === 1 ? "" : "s"} still empty (${empty}). Every one of those picks is already spoken for, so another ${pos} would leave you unable to field a legal lineup.`,
        ROSTER_LOCK_FLOOR + running * 0.001 - running,
      );
    } else {
      b.add(
        "roster_crunch",
        `${outstanding} starting slot${outstanding === 1 ? "" : "s"} still empty`,
        `With ${ctx.picksRemaining} pick${ctx.picksRemaining === 1 ? "" : "s"} left you have only ${slack} to spare before ${empty} must be filled. Depth is getting expensive.`,
        -running * (1 - slack / 3),
      );
    }
  }

  return {
    player,
    projection: proj,
    score: b.total(),
    vorp: vorpValue,
    tier: tier.tier,
    tierDropoff: tier.dropoff,
    tierRemaining: tier.remaining,
    survivalProbability: round2(survival),
    survivalBasis,
    reasons: b.build(),
  };
}

/**
 * Probability a player is undrafted at `targetPick`, modeled as a normal
 * around their ADP.
 *
 * The spread scales with ADP because early picks are far more predictable than
 * late ones -- pick 3 goes to the consensus player, pick 103 is a coin flip.
 */
export function survivalProbability(
  player: Player,
  currentPick: number,
  targetPick: number,
  measuredSd?: number,
): number {
  const adp = player.averageDraftPosition;
  if (!Number.isFinite(adp)) return 0.95; // undrafted in ESPN's data: almost certainly lasts
  if (targetPick <= currentPick) return 1;
  // A measured spread beats a modelled one. The fallback -- 28% of the
  // player's own ADP -- says a player going 100th is drafted within a
  // 28-pick band and one going 10th within three, purely because the
  // arithmetic scales with the mean. Real boards do not behave that way:
  // consensus is tight at the very top, widens through the middle rounds
  // where opinion actually differs, and is anyone's guess at the end.
  const sd = measuredSd !== undefined ? Math.max(1.5, measuredSd) : Math.max(4, adp * 0.28);
  // P(drafted after targetPick) = 1 - CDF(targetPick)
  return clamp01(1 - normalCdf((targetPick - adp) / sd));
}

/**
 * Cuts the board into bands of equivalent value.
 *
 * A break is declared where the drop in value from one player to the next is
 * unusually large for this board -- the same cliff-finding idea the positional
 * tiers use, applied across positions. `sensitivity` is in standard deviations
 * of the typical gap.
 */
export function bandByValue(
  recommendations: DraftRecommendation[],
  maxBands = 6,
): ValueBand[] {
  if (recommendations.length < 3) return [];

  const byValue = [...recommendations].sort((a, b) => b.score - a.score);
  const groups: DraftRecommendation[][] = [];

  for (const rec of byValue) {
    const current = groups[groups.length - 1];
    const leader = current?.[0];
    // Membership is judged against the band's leader rather than the previous
    // player. Chaining neighbour-to-neighbour lets a long shallow slope walk a
    // band from elite to replacement level one small step at a time, which is
    // how a "tier" ends up spanning sixty points and meaning nothing.
    if (leader && rec.score >= leader.score - bandTolerance(leader.score) && groups.length <= maxBands) {
      current.push(rec);
    } else {
      groups.push([rec]);
    }
  }

  return groups.slice(0, maxBands).map((members, i, all) => {
    const values = members.map((m) => m.score);
    const valueHigh = Math.max(...values);
    const valueLow = Math.min(...values);
    const nextBandTop = all[i + 1]?.[0]?.score;

    const byFit = [...members].sort((a, b) => b.score - a.score);
    const bestFit = byFit[0];

    // The note now says something sharper than it used to. Everyone in a band
    // is worth the same *to this roster*, so when the pick is not the
    // best-projected player in the group, the projection is not the reason --
    // the roster is.
    const bestProjected = [...members].sort(
      (a, b) => b.projection.points - a.projection.points,
    )[0];
    let fitNote: string | null = null;
    const projectionGap = bestProjected.projection.points - bestFit.projection.points;
    // Only worth remarking on when the projections genuinely disagree. A point
    // or two apart is the same player twice and saying so is noise.
    if (members.length > 1 && bestFit.player.id !== bestProjected.player.id && projectionGap >= 10) {
      fitNote =
        `${bestFit.player.name} and ${bestProjected.player.name} are worth about the same to this ` +
        `roster, even though ${bestProjected.player.name} is projected for ` +
        `${projectionGap.toFixed(0)} more points over the season. Take ${bestFit.player.name}: the ` +
        `extra projection lands somewhere your lineup cannot use it.`;
    }

    return {
      band: i + 1,
      players: byFit,
      valueHigh: round2(valueHigh),
      valueLow: round2(valueLow),
      dropoff: nextBandTop === undefined ? 0 : round2(valueLow - nextBandTop),
      fitNote,
    };
  });
}

/**
 * How far below a band's leader still counts as the same band.
 *
 * Proportional, with a floor: eight percent of an elite player's value is a
 * meaningful gap, while eight percent of a marginal one is rounding error, and
 * late in a draft almost everyone would otherwise collapse into a single band.
 */
function bandTolerance(leaderValue: number): number {
  return Math.max(6, Math.abs(leaderValue) * 0.08);
}

function buildBoardNotes(
  projections: Projection[],
  tierByPlayer: Map<number, { tier: number; dropoff: number; remaining: number }>,
  state: DraftState,
  picksUntilNextTurn: number,
): Reason[] {
  const notes: Reason[] = [];

  // Cliffs at every position is not a signal, it is noise -- a board that
  // flags six positions has told you nothing about which one to act on. Only
  // the two steepest are kept, and kicker/defense are excluded outright since
  // nobody drafts around them.
  const cliffs: Array<Reason & { dropoff: number }> = [];
  for (const pos of POSITIONS) {
    if (pos === "K" || pos === "DST") continue;
    const posPlayers = projections
      .filter((p) => p.player.position === pos)
      .sort((a, b) => b.points - a.points);
    if (!posPlayers.length) continue;

    const tier = tierByPlayer.get(posPlayers[0].player.id);
    if (tier && tier.remaining <= 2 && tier.dropoff >= 10) {
      cliffs.push({
        code: `cliff_${pos}`,
        label: `${pos} cliff`,
        detail: `${tier.remaining} ${pos}${tier.remaining === 1 ? "" : "s"} left before a ${tier.dropoff.toFixed(0)}-point drop to the next tier. This is the position under real pressure right now.`,
        impact: 0,
        direction: "negative",
        dropoff: tier.dropoff,
      });
    }
  }
  cliffs.sort((a, b) => b.dropoff - a.dropoff);
  for (const { dropoff: _dropoff, ...note } of cliffs.slice(0, 2)) notes.push(note);

  if (picksUntilNextTurn > 0) {
    const atRisk = projections
      .filter((p) => survivalProbability(p.player, state.pickNumber, state.nextPickNumber) < 0.2)
      .sort((a, b) => b.points - a.points)
      .slice(0, 3);
    if (atRisk.length) {
      notes.push({
        code: "wont_last",
        label: "Gone by your next turn",
        detail: `${atRisk.map((p) => p.player.name).join(", ")} are all very unlikely to survive the ${picksUntilNextTurn} picks until you are back on the clock.`,
        impact: 0,
        direction: "neutral",
      });
    }
  }

  return notes;
}

function isStartingPosition(pos: Position): boolean {
  return pos !== "K" && pos !== "DST";
}

/**
 * Need is a soft count -- flex demand is spread fractionally across eligible
 * positions -- so it must not be rounded up. A league that starts one tight end
 * shows TE need of about 1.1 once flex is spread in, and reporting that as
 * "2 more starting TEs" is simply false.
 */
function formatNeed(n: number): string {
  if (n >= 1.6) return String(Math.round(n));
  if (n >= 0.6) return "1";
  return "part of a flex spot's worth of";
}

/** Abramowitz & Stegun 7.1.26 error-function approximation. */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
