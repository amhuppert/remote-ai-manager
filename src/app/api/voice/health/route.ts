import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const VOICE_SERVER_URL =
  process.env.VOICE_SERVER_URL ?? "http://localhost:7880";

/** GET /api/voice/health — proxy health check to Voice2Text server */
export async function GET() {
  try {
    const response = await fetch(`${VOICE_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });

    if (response.ok) {
      return NextResponse.json({ available: true });
    }

    return NextResponse.json({ available: false });
  } catch {
    return NextResponse.json({ available: false });
  }
}
