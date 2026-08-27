import { NextResponse } from "next/server";
import { getBoardSources } from "@/lib/sources/boardSources";
import { getDraftPoolData, getDraftStatus, getLeague, toErrorResponse } from "@/lib/data";
import { buildLiveDraftContext, courseCorrection } from "@/lib/engine/draftLive";
import { buildDraftBoard } from "@/lib/engine/draft";
import { mockDraftEnabled } from "@/lib/mock/draftRoom";

export const dynamic = "force-dynamic";

/**
 * Live draft board.
 *
 * Reads picks straight from ESPN, so during a real draft the board re-ranks on
 * its own as other managers pick. `previousTargets` is echoed back by the
 * client so the response can say which of your targets were sniped since your
 * last turn.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      /** Hand-tracked pick ids in order, for when ESPN's feed is blind. */
      manualPicks?: number[];
      /** Seat override for before the pick order publishes. */
      seat?: number;
      previousTargets?: number[];
      limit?: number;
    };

    const [{ data: league, isDemo }, { data: liveStatus }, { data: pool }] = await Promise.all([
      getLeague(),
      getDraftStatus(),
      getDraftPoolData(),
    ]);

    // ESPN's feed is blind during live drafts -- proven against a real room:
    // every pick arrives only at completion. So the client may hand-track
    // picks, and when the feed has nothing, those become the draft. They are
    // synthesized into real pick objects against the published order (or a
    // seat-adjusted one before it publishes), so everything downstream --
    // the board, the bands, my-turn detection, even the sniped-targets notes
    // -- runs on the identical path either way. If ESPN's feed ever does
    // deliver mid-draft, it simply wins, and the taps become redundant
    // rather than conflicting.
    let status = liveStatus;
    const manual = (body.manualPicks ?? []).filter((id) => Number.isFinite(id));
    if (!liveStatus.picks.length && manual.length) {
      const size = league.settings.size || league.teams.length || 12;
      let pickOrder = [...liveStatus.settings.pickOrder];
      if (!pickOrder.length) pickOrder = league.teams.map((t) => t.id);
      if (body.seat && league.myTeamId !== undefined) {
        const others = pickOrder.filter((id) => id !== league.myTeamId);
        others.splice(Math.max(0, Math.min(body.seat - 1, others.length)), 0, league.myTeamId);
        pickOrder = others;
      }
      const picks = manual.map((playerId, i) => {
        const overall = i + 1;
        const round = Math.ceil(overall / size);
        const within = (overall - 1) % size;
        const index = round % 2 === 1 ? within : size - 1 - within;
        return {
          overallPick: overall,
          round,
          roundPick: within + 1,
          teamId: pickOrder[index] ?? 0,
          playerId,
          keeper: false,
          bidAmount: undefined,
        };
      });
      status = {
        ...liveStatus,
        settings: { ...liveStatus.settings, pickOrder },
        picks,
        inProgress: true,
        completed: false,
      };
    }

    const ctx = buildLiveDraftContext(status, league.settings, league.teams, pool, league.myTeamId);

    // Assembled once per process and reused for ten minutes: rebuilding these
    // per poll cost seconds, which turned every hand-tracked tap into felt lag.
    const { market, backfield, secondOpinion } = await getBoardSources(league.settings, pool);

    const board = buildDraftBoard(
      pool,
      league.settings,
      {
        pickNumber: ctx.currentPick,
        nextPickNumber: ctx.myNextPick ?? ctx.currentPick + (league.settings.size || 12),
        drafted: ctx.draftedIds,
        myRoster: ctx.myRoster,
        live: ctx,
        market,
        backfield,
        secondOpinion,
      },
      Math.min(60, body.limit ?? 25),
    );

    const byId = new Map(pool.map((p) => [p.id, p]));
    const correction = courseCorrection(
      ctx,
      body.previousTargets ?? [],
      board.recommendations.map((r) => ({ player: r.player, score: r.score })),
      byId,
    );

    const available = pool
      .filter((p) => !ctx.draftedIds.has(p.id))
      .sort((a, b) => a.averageDraftPosition - b.averageDraftPosition)
      .slice(0, 450)
      .map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position,
        proTeam: p.proTeam,
        adp: p.averageDraftPosition,
      }));

    return NextResponse.json({
      mock: mockDraftEnabled(),
      feedAlive: liveStatus.picks.length > 0,
      available,
      // The snake order, so the client can say which team a hand-tracked pick
      // belongs to -- ESPN's own pick history shows it, and matching their
      // layout is what makes the two lists comparable at a glance.
      pickOrder: status.settings.pickOrder,
      isDemo,
      settings: league.settings,
      draft: {
        connected: ctx.connected,
        type: ctx.type,
        inProgress: ctx.inProgress,
        completed: ctx.completed,
        mySeat: ctx.mySeat,
        currentPick: ctx.currentPick,
        myNextPick: ctx.myNextPick,
        myFollowingPick: ctx.myFollowingPick,
        picksUntilMyTurn: ctx.picksUntilMyTurn,
        interveningTeams: ctx.interveningTeams,
        runs: ctx.runs,
        recentPicks: ctx.recentPicks,
        teams: ctx.teams,
        myRoster: ctx.myRoster,
      },
      correction,
      board,
    });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
