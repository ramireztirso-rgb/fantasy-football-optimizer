import { NextResponse } from "next/server";
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
    };

    const board = buildDraftBoard(pool, league.settings, state, Math.min(60, body.limit ?? 30));
    return NextResponse.json({ isDemo, settings: league.settings, state: { ...state, drafted: [...state.drafted] }, board });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
