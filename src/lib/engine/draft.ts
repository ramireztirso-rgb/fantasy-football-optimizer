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

export interface DraftBoard {
  recommendations: DraftRecommendation[];
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
  const replacementLevels = computeReplacementLevels(projections, settings);
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

  const recommendations = projections
    .map((proj) =>
      score(proj, {
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
    boardNotes: buildBoardNotes(projections, tierByPlayer, state, picksUntilNextTurn),
    replacementLevels,
  };
}

interface ScoreContext {
  settings: LeagueSettings;
  state: DraftState;
  replacementLevels: ReplacementLevels;
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

  b.setBase(
    vorpValue,
    "vorp",
    "Value over replacement",
    `Projected ${proj.points.toFixed(0)} points on the season, ${vorpValue.toFixed(0)} more than the last startable ${pos} in a ${ctx.settings.size}-team league.`,
  );

  // --- Roster need ---
  const needFactor = ctx.need[pos] ?? 0;
  if (needFactor > 0) {
    const bonus = vorpValue * 0.15 * needFactor;
    b.add(
      "roster_need",
      "Fills a need",
      needFactor >= 0.6
        ? `You still need ${formatNeed(needFactor)} more starting ${pos}${needFactor >= 1.6 ? "s" : ""}, so this pick goes straight into your lineup.`
        : `Your ${pos} starters are set, but flex demand means there is still ${formatNeed(needFactor)} ${pos} value left to fill.`,
      bonus,
    );
  } else {
    // Not a penalty for depth exactly -- a penalty for depth you cannot start,
    // and it has to escalate. A flat haircut prices the fourth running back and
    // the eleventh identically, which is how a board talks itself into eleven
    // running backs: the position's raw value-over-replacement stays the
    // highest on the board long after the roster has stopped being able to use
    // it. The surplus term is what makes each additional one worth less than
    // the last.
    // Measured against the position's own demand, not in absolute players. A
    // second quarterback in a one-quarterback league is a whole surplus
    // starter; a fourth running back where you start two and a half is a
    // fifth of one. Penalising them equally is what leaves the board rostering
    // three quarterbacks it can never start two of.
    const demand = Math.max(0.5, ctx.perTeamDemand[pos] ?? 1);
    const surplus = Math.max(0, ctx.owned[pos] - demand);
    // Each surplus starter's worth of depth halves what the next one is worth.
    // A first backup is insurance and holds real value; a fourth is a roster
    // spot you set on fire. A fixed rate, however steep, cannot express that,
    // and a capped one leaves the deepest position on the roster still winning
    // picks.
    const depth = Math.ceil(surplus / demand);
    const rate = 1 - 0.88 * Math.pow(0.5, depth);
    b.add(
      "position_filled",
      surplus >= demand ? `${pos} is your deepest position` : "Position already filled",
      surplus >= demand
        ? `You already carry ${ctx.owned[pos]} ${pos}${ctx.owned[pos] === 1 ? "" : "s"} against ${(ctx.perTeamDemand[pos] ?? 0).toFixed(1)} starting spots. Another one cannot crack your lineup, so his value here is a fraction of his projection.`
        : `Your ${pos} starting slots are already covered, so this player's value only shows up as depth or a trade chip.`,
      -vorpValue * rate,
    );
  }

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

  if (ctx.picksUntilNextTurn > 0) {
    if (survival > 0.6) {
      // Very likely to last: taking them now spends a pick you did not need to.
      const discount = vorpValue * 0.2 * (survival - 0.6) / 0.4;
      b.add(
        "likely_to_last",
        "Can wait",
        `About a ${(survival * 100).toFixed(0)}% chance they are still on the board at pick ${ctx.state.nextPickNumber}, so you can likely take a scarcer position first and still get them.`,
        -discount,
      );
    } else if (survival < 0.25) {
      const urgency = Math.min(vorpValue * 0.25, tier.dropoff * 0.5 + 3) * (1 - survival / 0.25);
      b.add(
        "last_chance",
        "Now or never",
        `Only about a ${(survival * 100).toFixed(0)}% chance they last until pick ${ctx.state.nextPickNumber}. If you want them, this is the turn.`,
        urgency,
      );
    }
  }

  // --- Tier cliff ---
  if (tier.remaining <= 2 && tier.dropoff >= 8) {
    const cliffBonus = Math.min(tier.dropoff * 0.4, 12);
    b.add(
      "tier_cliff",
      "Last of the tier",
      `Only ${tier.remaining} player${tier.remaining === 1 ? "" : "s"} left in this ${pos} tier, and the next tier down is about ${tier.dropoff.toFixed(0)} points worse over the season.`,
      cliffBonus,
    );
  }

  // --- ADP value ---
  if (Number.isFinite(player.averageDraftPosition)) {
    const adp = player.averageDraftPosition;
    const slip = adp - ctx.state.pickNumber;
    if (slip >= 8) {
      const bonus = Math.min(slip * 0.15, 8);
      b.add(
        "adp_value",
        "Falling",
        `Typically drafted around pick ${adp.toFixed(0)} but still available at ${ctx.state.pickNumber} -- ${slip.toFixed(0)} picks of surplus value.`,
        bonus,
      );
    } else if (slip <= -12) {
      const penalty = Math.min(Math.abs(slip) * 0.1, 6);
      b.add(
        "adp_reach",
        "A reach",
        `Usually goes around pick ${adp.toFixed(0)}; taking them at ${ctx.state.pickNumber} is roughly ${Math.abs(slip).toFixed(0)} picks early.`,
        -penalty,
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

  if (player.injuryStatus && player.injuryStatus.toUpperCase() !== "ACTIVE") {
    b.note(
      "injury_flag",
      `Listed ${player.injuryStatus.replace(/_/g, " ").toLowerCase()}`,
      `Currently listed ${player.injuryStatus.replace(/_/g, " ").toLowerCase()} -- confirm the timeline before spending this pick.`,
    );
  }

  // Applied last so it scales against everything else the player earned.
  if (STREAMABLE.has(pos)) {
    // Full value only in the last two rounds; near zero before that.
    const roundsLeft = ctx.rounds - ctx.currentRound;
    const readiness = roundsLeft <= 1 ? 1 : roundsLeft <= 2 ? 0.6 : 0.03;
    const running = b.total();
    if (readiness < 1 && running > 0) {
      b.add(
        "stream_position",
        "Draft this last",
        `${pos} is streamed off the wire every week, so drafting one in round ${ctx.currentRound} of ${ctx.rounds} costs you a real player for a spot you can fill for free later. Take one in the final two rounds.`,
        -running * (1 - readiness),
      );
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
