import { NextResponse } from "next/server";
import { getHistoricalDrafts, getLeague, toErrorResponse } from "@/lib/data";
import { analyzeDraftTendencies } from "@/lib/engine/tendencies";

export const dynamic = "force-dynamic";

/** How this specific league drafts, learned from its own past drafts. */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const seasonsBack = Math.min(5, Math.max(1, Number(searchParams.get("seasons")) || 3));

    const [{ data: league, isDemo }, { data: history }] = await Promise.all([
      getLeague(),
      getHistoricalDrafts(seasonsBack),
    ]);

    // Current team names win: managers rename teams between seasons.
    const teamNames = new Map(history.teamNames);
    for (const team of league.teams) teamNames.set(team.id, team.name);

    return NextResponse.json({
      isDemo,
      tendencies: analyzeDraftTendencies(history.drafts, history.playerInfo, teamNames, history.marketOrder),
    });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
