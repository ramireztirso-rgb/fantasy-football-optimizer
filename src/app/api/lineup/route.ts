import { NextResponse } from "next/server";
import { getLeague, toErrorResponse } from "@/lib/data";
import { optimizeLineup } from "@/lib/engine/lineup";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { data: league, isDemo } = await getLeague();

    const teamId = Number(searchParams.get("teamId")) || league.myTeamId;
    const team = league.teams.find((t) => t.id === teamId) ?? league.teams[0];
    if (!team) {
      return NextResponse.json(
        {
          error: "No team found in this league.",
          hint: "If your league is private, the SWID cookie is what identifies which team is yours.",
        },
        { status: 404 },
      );
    }

    const week = Number(searchParams.get("week")) || league.settings.currentWeek;
    const result = optimizeLineup(team, league.settings, { week });

    return NextResponse.json({
      isDemo,
      team: { id: team.id, name: team.name },
      settings: league.settings,
      result,
    });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
