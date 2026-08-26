import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/data";
import { poller } from "@/lib/live/poller";

export const dynamic = "force-dynamic";

/** Config and poller diagnostics, surfaced in the UI's setup banner. */
export async function GET() {
  const hasCookies = Boolean(process.env.ESPN_S2 && process.env.SWID);
  return NextResponse.json({
    configured: isConfigured(),
    hasCookies,
    seasonId: Number(process.env.ESPN_SEASON_ID) || new Date().getFullYear(),
    poller: poller.status(),
  });
}
