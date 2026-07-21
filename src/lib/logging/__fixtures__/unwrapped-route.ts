/**
 * Deliberately mixed route fixture for `route-tracing.architecture.test.ts`.
 *
 * `GET` is exported WITHOUT `withTracing`, so it is outside the tracing net —
 * exactly the mistake the architecture test exists to catch. `POST` is wrapped
 * correctly. The test asserts the detector flags `GET` and clears `POST`,
 * proving the enumeration would go red if a real route shipped unwrapped.
 *
 * This file lives outside `src/app/api`, so it is never enumerated as a real
 * route nor served by Next.js — it exists only to give the test a known-bad
 * export to detect.
 */

import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging/tracing";

// Intentionally NOT wrapped — the negative case.
export async function GET(): Promise<Response> {
  return NextResponse.json({ ok: true });
}

// Correctly wrapped — the positive case.
export const POST = withTracing(async (): Promise<Response> => {
  return NextResponse.json({ ok: true });
});
