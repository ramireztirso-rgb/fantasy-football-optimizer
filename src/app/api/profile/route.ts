import { NextResponse } from "next/server";
import { getFreeAgentPool, getLeague, toErrorResponse } from "@/lib/data";
import { buildScoringProfile } from "@/lib/engine/scoringProfile";

export const dynamic = "force-dynamic";

/** What this league's custom rules do to player value. */
export async function GET() {
  try {
    const { data: league, isDemo } = await getLeague();

    // Rostered players carry the richest stat history; the wire fills the tail.
    const rostered = league.teams.flatMap((t) => t.roster.map((r) => r.player));
    let pool = rostered;
    try {
      const { data: freeAgents } = await getFreeAgentPool(league.settings.currentWeek);
      pool = [...rostered, ...freeAgents];
    } catch {
      // Volume estimates fall back to documented baselines without the wire.
    }

    return NextResponse.json({
      isDemo,
      settings: league.settings,
      profile: buildScoringProfile(league.settings, pool),
    });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
