import { NextResponse } from "next/server";
import { getDraftPoolData, getLeague, toErrorResponse } from "@/lib/data";
import { buildDraftBoard, type DraftState } from "@/lib/engine/draft";
import { fetchAdpMarket } from "@/lib/sources/adp";

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

    // Measured draft-slot spreads, when the market is reachable. A failure here
    // costs accuracy in the survival model and nothing else, so it is caught
    // rather than propagated: no outside source gets to break a live draft.
    const market = await fetchAdpMarket(league.settings).catch((err) => {
      // Logged rather than swallowed. A silent fallback here is indistinguishable
      // from the market simply agreeing with ESPN about everybody, which is not a
      // thing anyone should have to guess at during a draft.
      console.warn("[adp] market unavailable, falling back to estimated spreads:", err);
      return undefined;
    });

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
    };

    const board = buildDraftBoard(pool, league.settings, state, Math.min(60, body.limit ?? 30));
    return NextResponse.json({ isDemo, settings: league.settings, state: { ...state, drafted: [...state.drafted] }, board });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
