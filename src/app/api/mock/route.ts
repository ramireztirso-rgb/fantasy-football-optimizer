import { NextResponse } from "next/server";
import {
  makeMockPick,
  mockDraftEnabled,
  resetMockDraft,
} from "@/lib/mock/draftRoom";

export const dynamic = "force-dynamic";

/**
 * Controls for the practice draft room. Only alive under MOCK_DRAFT=1, and
 * everything it touches is in-memory -- there is nothing here that can reach
 * the real league.
 */
export async function POST(request: Request) {
  if (!mockDraftEnabled()) {
    return NextResponse.json(
      { error: "Mock drafting is off. Start the app with MOCK_DRAFT=1 to practice." },
      { status: 400 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    playerId?: number;
    seat?: number;
  };

  if (body.action === "reset") {
    await resetMockDraft(body.seat);
    return NextResponse.json({ ok: true, seat: body.seat ?? "as published" });
  }
  if (body.action === "pick" && typeof body.playerId === "number") {
    return NextResponse.json(await makeMockPick(body.playerId));
  }
  return NextResponse.json({ error: "Unknown action. Use reset or pick." }, { status: 400 });
}
