import { NextResponse } from "next/server";
import { getLeague, toErrorResponse } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data, isDemo } = await getLeague();
    return NextResponse.json({ league: data, isDemo });
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
