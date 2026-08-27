import { NextResponse } from "next/server";
import { getDraftPoolData, getDraftStatus, getLeague, toErrorResponse } from "@/lib/data";
import { buildLiveDraftContext, courseCorrection } from "@/lib/engine/draftLive";
import { buildDraftBoard } from "@/lib/engine/draft";
import { fetchAdpMarket } from "@/lib/sources/adp";
import { fetchBackfieldSource } from "@/lib/sources/backfieldSource";
import { fetchSecondOpinion } from "@/lib/sources/secondOpinion";
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
      previousTargets?: number[];
      limit?: number;
    };

    const [{ data: league, isDemo }, { data: status }, { data: pool }] = await Promise.all([
      getLeague(),
      getDraftStatus(),
      getDraftPoolData(),
    ]);

    const ctx = buildLiveDraftContext(status, league.settings, league.teams, pool, league.myTeamId);

    // Measured draft-slot spreads. This is the path that runs during an actual
    // draft, so a failure here must cost accuracy and nothing else.
    const market = await fetchAdpMarket(league.settings).catch((err) => {
      // Logged rather than swallowed. A silent fallback here is indistinguishable
      // from the market simply agreeing with ESPN about everybody, which is not a
      // thing anyone should have to guess at during a draft.
      console.warn("[adp] market unavailable, falling back to estimated spreads:", err);
      return undefined;
    });

    // Backfield usage and durability. Purely additional -- when it is missing
    // the board says less about running backs and ranks them identically.
    const backfield = await fetchBackfieldSource(league.settings.seasonId).catch((err) => {
      console.warn("[backfield] usage data unavailable:", err);
      return undefined;
    });

    // The second opinion on every projection. Same contract as the others: a
    // failure costs the board an opinion, never a draft.
    const secondOpinion = await fetchSecondOpinion(league.settings).catch((err) => {
      console.warn("[second-opinion] history unavailable:", err);
      return undefined;
    });

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

    return NextResponse.json({
      mock: mockDraftEnabled(),
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
