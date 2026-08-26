import { NextResponse } from "next/server";
import { getFreeAgentPool, getLeague, toErrorResponse } from "@/lib/data";
import { buildWaiverReport } from "@/lib/engine/waivers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { data: league, isDemo } = await getLeague();

    const teamId = Number(searchParams.get("teamId")) || league.myTeamId;
    const team = league.teams.find((t) => t.id === teamId) ?? league.teams[0];
    if (!team) {
      return NextResponse.json({ error: "No team found in this league." }, { status: 404 });
    }

    const week = Number(searchParams.get("week")) || league.settings.currentWeek;
    const { data: freeAgents } = await getFreeAgentPool(week);
    const limit = Math.min(50, Number(searchParams.get("limit")) || 25);

    const report = buildWaiverReport(league, team, freeAgents, { week, limit });
    return NextResponse.json({
      isDemo,
      team: { id: team.id, name: team.name },
      settings: league.settings,
      report,
    });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
