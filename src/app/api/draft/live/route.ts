import { NextResponse } from "next/server";
import { getDraftPoolData, getDraftStatus, getLeague, toErrorResponse } from "@/lib/data";
import { buildLiveDraftContext, courseCorrection } from "@/lib/engine/draftLive";
import { buildDraftBoard } from "@/lib/engine/draft";

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
      previousTargets?: number[];
      limit?: number;
    };

    const [{ data: league, isDemo }, { data: status }, { data: pool }] = await Promise.all([
      getLeague(),
      getDraftStatus(),
      getDraftPoolData(),
    ]);

    const ctx = buildLiveDraftContext(status, league.settings, league.teams, pool, league.myTeamId);

    const board = buildDraftBoard(
      pool,
      league.settings,
      {
        pickNumber: ctx.currentPick,
        nextPickNumber: ctx.myNextPick ?? ctx.currentPick + (league.settings.size || 12),
        drafted: ctx.draftedIds,
        myRoster: ctx.myRoster,
        live: ctx,
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

    return NextResponse.json({
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
