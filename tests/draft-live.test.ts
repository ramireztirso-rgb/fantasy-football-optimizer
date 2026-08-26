import { describe, expect, it } from "vitest";
import { buildDemoDraft, buildDemoLeague, buildDemoPlayers } from "@/lib/demo/league";
import {
  buildLiveDraftContext,
  courseCorrection,
  detectRuns,
  snakePicksForSlot,
  survivalGivenNeeds,
  teamAtPick,
  type TeamDraftState,
} from "@/lib/engine/draftLive";
import { buildDraftBoard } from "@/lib/engine/draft";
import { normalizeDraftStatus } from "@/lib/espn/normalize";
import { rosterNeed } from "@/lib/engine/replacement";
import type { DraftPick, Player } from "@/lib/domain/types";

const { league } = buildDemoLeague({ week: 6 });
const pool = buildDemoPlayers();
const status = buildDemoDraft();

describe("scheduled but undrafted leagues", () => {
  // Once the draft order is set, ESPN publishes all size*rounds picks with
  // `playerId: -1`. Read as made picks, they make an undrafted league look
  // complete: the board reports every player gone and returns nothing.
  const placeholders = Array.from({ length: 24 }, (_, i) => ({
    overallPickNumber: i + 1,
    roundId: Math.floor(i / 12) + 1,
    roundPickNumber: (i % 12) + 1,
    teamId: ((i % 12) + 1),
    playerId: -1,
    keeper: false,
    reservedForKeeper: false,
    bidAmount: 0,
  }));

  it("does not count placeholder picks as made", () => {
    const s = normalizeDraftStatus(
      { picks: placeholders, drafted: false, inProgress: false },
      { ...status.settings, pickOrder: Array.from({ length: 12 }, (_, i) => i + 1) },
      12,
    );
    expect(s.picks).toHaveLength(0);
    expect(s.completed).toBe(false);
  });

  it("keeps real picks when the skeleton is partially filled", () => {
    const mixed = placeholders.map((p, i) => (i < 3 ? { ...p, playerId: 1000 + i } : p));
    const s = normalizeDraftStatus(
      { picks: mixed, drafted: false, inProgress: true },
      { ...status.settings, pickOrder: Array.from({ length: 12 }, (_, i) => i + 1) },
      12,
    );
    expect(s.picks.map((p) => p.playerId)).toEqual([1000, 1001, 1002]);
    expect(s.picks.map((p) => p.overallPick)).toEqual([1, 2, 3]);
  });

  it("takes the draft length from the published grid, not roster settings", () => {
    const s = normalizeDraftStatus(
      { picks: placeholders, drafted: false, inProgress: false },
      { ...status.settings, rounds: 99 },
      12,
    );
    // 24 published slots across 12 teams is a two-round grid, whatever the
    // roster settings imply.
    expect(s.settings.rounds).toBe(2);
  });

  it("ignores a partial pick list when deriving draft length", () => {
    // 24 made picks in a 12-team league is two rounds *elapsed*, not a
    // two-round draft. With no placeholder present, roster settings win.
    const made = placeholders.map((p, i) => ({ ...p, playerId: 1000 + i }));
    const s = normalizeDraftStatus(
      { picks: made, drafted: false, inProgress: true },
      { ...status.settings, rounds: 15 },
      12,
    );
    expect(s.settings.rounds).toBe(15);
  });

  it("puts a pre-draft league on pick one, not past the end", () => {
    const s = normalizeDraftStatus(
      { picks: placeholders, drafted: false, inProgress: false },
      { ...status.settings, pickOrder: Array.from({ length: 12 }, (_, i) => i + 1) },
      12,
    );
    const ctx = buildLiveDraftContext(s, league.settings, league.teams, pool, league.teams[0].id);
    expect(ctx.currentPick).toBe(1);
    expect(ctx.draftedIds.size).toBe(0);
  });
});

describe("snake draft math", () => {
  it("reverses the order every round", () => {
    // Seat 1 in a 12-team league: 1, 24, 25, 48, 49...
    expect(snakePicksForSlot(1, 12, 4)).toEqual([1, 24, 25, 48]);
    // Seat 12: 12, 13, 36, 37...
    expect(snakePicksForSlot(12, 12, 4)).toEqual([12, 13, 36, 37]);
    // A middle seat is evenly spaced.
    expect(snakePicksForSlot(6, 12, 3)).toEqual([6, 19, 30]);
  });

  it("maps a pick number back to the team that owns it", () => {
    const order = [101, 102, 103, 104];
    expect(teamAtPick(1, order)).toBe(101);
    expect(teamAtPick(4, order)).toBe(104);
    // Round two runs backwards.
    expect(teamAtPick(5, order)).toBe(104);
    expect(teamAtPick(8, order)).toBe(101);
    expect(teamAtPick(9, order)).toBe(101);
  });

  it("round-trips: every pick maps back to the seat that owns it", () => {
    const size = 12;
    const order = Array.from({ length: size }, (_, i) => i + 1);
    for (let slot = 1; slot <= size; slot++) {
      for (const pick of snakePicksForSlot(slot, size, 16)) {
        expect(teamAtPick(pick, order)).toBe(slot);
      }
    }
  });

  it("returns undefined for an unpublished order", () => {
    expect(teamAtPick(1, [])).toBeUndefined();
  });
});

describe("live draft context", () => {
  const ctx = buildLiveDraftContext(status, league.settings, league.teams, pool, 1);

  it("locates my seat and my next pick from the published order", () => {
    expect(ctx.mySeat).toEqual({ teamId: 1, slot: 1 });
    expect(ctx.currentPick).toBe(status.picks.length + 1);
    expect(ctx.myNextPick).not.toBeNull();
    expect(ctx.myNextPick!).toBeGreaterThanOrEqual(ctx.currentPick);
  });

  it("lists exactly the teams picking before my turn, in order", () => {
    expect(ctx.interveningTeams).toHaveLength(ctx.picksUntilMyTurn);
    expect(ctx.interveningTeams).not.toContain(1);
  });

  it("reconstructs every team's roster from the pick feed", () => {
    const totalTracked = ctx.teams.reduce((s, t) => s + t.picks.length, 0);
    expect(totalTracked).toBe(status.picks.length);
    const mine = ctx.teams.find((t) => t.teamId === 1)!;
    expect(mine.picks.length).toBeGreaterThan(0);
    expect(ctx.myRoster).toHaveLength(mine.picks.filter((p) => p.player).length);
  });

  it("marks drafted players as unavailable", () => {
    expect(ctx.draftedIds.size).toBe(status.picks.length);
    const board = buildDraftBoard(pool, league.settings, {
      pickNumber: ctx.currentPick,
      nextPickNumber: ctx.myNextPick ?? ctx.currentPick + 12,
      drafted: ctx.draftedIds,
      myRoster: ctx.myRoster,
      live: ctx,
    });
    for (const rec of board.recommendations) {
      expect(ctx.draftedIds.has(rec.player.id)).toBe(false);
    }
  });

  it("switches the survival model to league needs when connected", () => {
    const board = buildDraftBoard(pool, league.settings, {
      pickNumber: ctx.currentPick,
      nextPickNumber: ctx.myNextPick ?? ctx.currentPick + 12,
      drafted: ctx.draftedIds,
      myRoster: ctx.myRoster,
      live: ctx,
    });
    expect(board.recommendations[0].survivalBasis).toBe("league-needs");
  });

  it("falls back to ADP when no draft is connected", () => {
    const board = buildDraftBoard(pool, league.settings, {
      pickNumber: 13,
      nextPickNumber: 25,
      drafted: new Set<number>(),
      myRoster: [],
    });
    expect(board.recommendations[0].survivalBasis).toBe("adp");
  });

  it("handles an empty draft without a published order", () => {
    const empty = normalizeDraftStatus({ picks: [] }, { ...status.settings, pickOrder: [] }, 12);
    const emptyCtx = buildLiveDraftContext(empty, league.settings, league.teams, pool, 1);
    expect(emptyCtx.mySeat).toBeNull();
    expect(emptyCtx.myNextPick).toBeNull();
    expect(emptyCtx.interveningTeams).toEqual([]);
    expect(emptyCtx.currentPick).toBe(1);
  });
});

describe("survivalGivenNeeds", () => {
  const byId = new Map(pool.map((p) => [p.id, p]));
  const valueOf = (p: Player) => p.seasonProjectedPoints;
  const available = [...pool].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 40);
  const target = available[0];

  function stateWith(need: Partial<Record<string, number>>): TeamDraftState {
    return {
      teamId: 99,
      name: "T",
      picks: [],
      counts: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 },
      need: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, ...need } as TeamDraftState["need"],
    };
  }

  it("returns certainty when nobody picks before me", () => {
    expect(survivalGivenNeeds(target, valueOf, available, [], new Map())).toBe(1);
  });

  it("drops as more teams pick before my turn", () => {
    const states = new Map([[99, stateWith({ [target.position]: 2 })]]);
    const one = survivalGivenNeeds(target, valueOf, available, [99], states);
    const many = survivalGivenNeeds(target, valueOf, available, [99, 99, 99, 99, 99, 99], states);
    expect(many).toBeLessThan(one);
  });

  it("survives longer when the teams ahead have that position filled", () => {
    const hungry = new Map([[99, stateWith({ [target.position]: 3 })]]);
    const full = new Map([[99, stateWith({})]]);
    const teams = [99, 99, 99, 99];
    expect(survivalGivenNeeds(target, valueOf, available, teams, full)).toBeGreaterThan(
      survivalGivenNeeds(target, valueOf, available, teams, hungry),
    );
  });

  it("treats a player off the top of the board as nearly certain to last", () => {
    const deep = pool[pool.length - 1];
    expect(survivalGivenNeeds(deep, valueOf, available, [99, 99], new Map())).toBeGreaterThan(0.9);
  });

  it("stays within probability bounds", () => {
    const states = new Map([[99, stateWith({ [target.position]: 3 })]]);
    const teams = Array.from({ length: 30 }, () => 99);
    const p = survivalGivenNeeds(target, valueOf, available, teams, states);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  void byId;
  void rosterNeed;
});

describe("detectRuns", () => {
  function pickFor(playerId: number, overall: number): DraftPick {
    return { overallPick: overall, round: 1, roundPick: overall, teamId: 1, playerId, keeper: false };
  }

  it("flags a burst of one position above the league's normal rate", () => {
    const rbs = pool.filter((p) => p.position === "RB").slice(0, 6);
    const wrs = pool.filter((p) => p.position === "WR").slice(0, 2);
    const byId = new Map([...rbs, ...wrs].map((p) => [p.id, p]));
    const picks = [...wrs, ...rbs].map((p, i) => pickFor(p.id, i + 1));

    const runs = detectRuns(picks, byId, league.settings);
    expect(runs.some((r) => r.position === "RB")).toBe(true);
    expect(runs.find((r) => r.position === "RB")!.intensity).toBeGreaterThan(1.8);
  });

  it("stays quiet on a balanced board", () => {
    const mixed = [
      ...pool.filter((p) => p.position === "RB").slice(0, 3),
      ...pool.filter((p) => p.position === "WR").slice(0, 3),
      ...pool.filter((p) => p.position === "TE").slice(0, 1),
      ...pool.filter((p) => p.position === "QB").slice(0, 1),
    ];
    const byId = new Map(mixed.map((p) => [p.id, p]));
    const picks = mixed.map((p, i) => pickFor(p.id, i + 1));
    expect(detectRuns(picks, byId, league.settings)).toEqual([]);
  });

  it("needs a full window before calling anything", () => {
    expect(detectRuns([pickFor(pool[0].id, 1)], new Map(), league.settings)).toEqual([]);
  });
});

describe("courseCorrection", () => {
  const ctx = buildLiveDraftContext(status, league.settings, league.teams, pool, 1);
  const byId = new Map(pool.map((p) => [p.id, p]));

  it("reports targets that came off the board", () => {
    const sniped = status.picks.slice(-3).map((p) => p.playerId);
    const notes = courseCorrection(ctx, sniped, [], byId);
    const gone = notes.find((n) => n.code === "targets_gone");
    expect(gone).toBeDefined();
    const names = sniped.map((id) => byId.get(id)?.name).filter(Boolean);
    expect(names.some((n) => gone!.detail.includes(n!))).toBe(true);
  });

  it("says nothing about sniping when the targets are still available", () => {
    const stillThere = pool.filter((p) => !ctx.draftedIds.has(p.id)).slice(0, 3).map((p) => p.id);
    const notes = courseCorrection(ctx, stillThere, [], byId);
    expect(notes.some((n) => n.code === "targets_gone")).toBe(false);
  });

  it("names the current pick when a board is supplied", () => {
    const top = pool.find((p) => !ctx.draftedIds.has(p.id))!;
    const notes = courseCorrection(ctx, [], [{ player: top, score: 100 }], byId);
    expect(notes.find((n) => n.code === "current_call")?.detail).toContain(top.name);
  });
});

describe("draft value regressions", () => {
  const ctx = buildLiveDraftContext(status, league.settings, league.teams, pool, 1);

  function boardAtPick(pickNumber: number) {
    return buildDraftBoard(pool, league.settings, {
      pickNumber,
      nextPickNumber: pickNumber + 12,
      drafted: ctx.draftedIds,
      myRoster: ctx.myRoster,
    }, 12);
  }

  // A defense once ranked first overall at pick 41 because its value over
  // replacement looked competitive. Streaming makes that value illusory.
  it("keeps kickers and defenses off the early board", () => {
    const early = boardAtPick(41);
    const top5 = early.recommendations.slice(0, 5).map((r) => r.player.position);
    expect(top5).not.toContain("DST");
    expect(top5).not.toContain("K");
  });

  it("explains why it is deferring them", () => {
    const early = boardAtPick(41);
    const streamed = early.recommendations.find(
      (r) => r.player.position === "K" || r.player.position === "DST",
    );
    if (streamed) {
      expect(streamed.reasons.some((r) => r.code === "stream_position" && r.impact < 0)).toBe(true);
    }
  });

  it("lets them back in during the final rounds", () => {
    const rounds = 16;
    const lastRoundPick = (rounds - 1) * 12 + 1;
    const late = boardAtPick(lastRoundPick);
    const earlyRank = boardAtPick(41).recommendations.findIndex(
      (r) => r.player.position === "DST",
    );
    const lateRank = late.recommendations.findIndex((r) => r.player.position === "DST");
    // Present and better ranked late than early (or absent early entirely).
    expect(lateRank).toBeGreaterThanOrEqual(0);
    if (earlyRank >= 0) expect(lateRank).toBeLessThan(earlyRank);
  });

  // A league starting one TE was told it needed "2 more starting TE" because
  // fractional flex demand was rounded up.
  it("never overstates positional need from fractional flex demand", () => {
    const board = boardAtPick(41);
    const startedTe = league.settings.lineupSlots.find((s) => s.slot === "TE")?.count ?? 0;
    expect(startedTe).toBe(1);
    for (const rec of board.recommendations) {
      const needReason = rec.reasons.find((r) => r.code === "roster_need");
      if (needReason && rec.player.position === "TE") {
        expect(needReason.detail).not.toMatch(/need 2 more starting TE/);
      }
    }
  });
});
