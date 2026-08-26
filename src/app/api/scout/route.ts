import { NextResponse } from "next/server";
import { getLeague, toErrorResponse } from "@/lib/data";
import { buildScoutingReport } from "@/lib/engine/scout";
import { simulatePlayoffOdds, teamStrengths } from "@/lib/engine/simulate";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { data: league, isDemo } = await getLeague();

    const teamId = Number(searchParams.get("teamId")) || league.myTeamId || league.teams[0]?.id;
    if (teamId === undefined) {
      return NextResponse.json({ error: "No team found in this league." }, { status: 404 });
    }
    const week = Number(searchParams.get("week")) || league.settings.currentWeek;

    const report = buildScoutingReport(league, teamId, week);

    // Playoff odds run off the remaining schedule so strength of schedule is
    // priced in rather than assumed away.
    const strengths = teamStrengths(league.teams, league.settings, week);
    const remaining = league.matchups
      .filter((m) => m.week > week && m.away !== undefined)
      .map((m) => ({ week: m.week, homeId: m.home.teamId, awayId: m.away!.teamId }));
    const odds = simulatePlayoffOdds(
      league.teams,
      strengths,
      remaining,
      league.settings.playoffTeamCount,
    );

    return NextResponse.json({
      isDemo,
      settings: league.settings,
      report,
      strengths: strengths.sort((a, b) => b.mean - a.mean),
      playoffOdds: odds,
      scheduleKnown: remaining.length,
      playoffOddsUnavailableReason:
        odds === null
          ? "No remaining matchups are scheduled, so there is nothing left to simulate. With zero games left every outcome is already decided, and reporting that as a percentage would be the current standings in disguise."
          : null,
    });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
