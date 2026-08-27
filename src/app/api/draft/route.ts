import { NextResponse } from "next/server";
import { getBoardSources } from "@/lib/sources/boardSources";
import { getDraftPoolData, getLeague, toErrorResponse } from "@/lib/data";
import { buildDraftBoard, type DraftState } from "@/lib/engine/draft";

export const dynamic = "force-dynamic";

/**
 * Draft board. Draft state is supplied by the client rather than read from
 * ESPN: ESPN's live draft feed is not part of the read API, and a manager
 * ticking off picks in the UI is both simpler and works for offline drafts.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      pickNumber?: number;
      nextPickNumber?: number;
      drafted?: number[];
      myRosterIds?: number[];
      limit?: number;
    };

    const { data: league, isDemo } = await getLeague();
    const { data: pool } = await getDraftPoolData();

    // Assembled once per process and reused for ten minutes: rebuilding these
    // per poll cost seconds, which turned every hand-tracked tap into felt lag.
    const { market, backfield, secondOpinion } = await getBoardSources(league.settings, pool);

    const byId = new Map(pool.map((p) => [p.id, p]));
    const myRoster = (body.myRosterIds ?? [])
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));

    const pickNumber = body.pickNumber ?? 1;
    const state: DraftState = {
      pickNumber,
      // Default to a snake-draft turnaround in a league of this size.
      nextPickNumber: body.nextPickNumber ?? pickNumber + (league.settings.size || 12),
      drafted: new Set([...(body.drafted ?? []), ...(body.myRosterIds ?? [])]),
      myRoster,
      market,
      backfield,
      secondOpinion,
    };

    const board = buildDraftBoard(pool, league.settings, state, Math.min(60, body.limit ?? 30));
    // The whole available pool rides along, light: manual pick tracking needs
    // to mark ANY player drafted, including ones the board would never
    // recommend, and a search box is only as good as the list behind it.
    const available = pool
      .filter((p) => !state.drafted.has(p.id))
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
      isDemo,
      settings: league.settings,
      state: { ...state, drafted: [...state.drafted] },
      board,
      available,
    });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
