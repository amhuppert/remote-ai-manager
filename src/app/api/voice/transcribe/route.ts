import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const VOICE_SERVER_URL =
  process.env.VOICE_SERVER_URL ?? "http://localhost:7880";

/** POST /api/voice/transcribe — proxy transcription to Voice2Text server */
export const POST = withTracing(async (request) => {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid form data" } satisfies ApiError,
      { status: 400 },
    );
  }

  const audio = formData.get("audio");
  if (!audio || !(audio instanceof File)) {
    return NextResponse.json(
      { error: "Missing audio file" } satisfies ApiError,
      { status: 400 },
    );
  }

  const projectName = formData.get("projectName");
  if (!projectName || typeof projectName !== "string") {
    return NextResponse.json(
      { error: "Missing projectName" } satisfies ApiError,
      { status: 400 },
    );
  }

  const projectPath = await resolveProjectPath(projectName);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  // Forward to Voice2Text server
  const upstreamFormData = new FormData();
  upstreamFormData.set("audio", audio);
  upstreamFormData.set("projectPath", projectPath);

  const context = formData.get("context");
  if (typeof context === "string" && context.trim()) {
    upstreamFormData.set("context", context);
  }

  try {
    const response = await fetch(`${VOICE_SERVER_URL}/transcribe`, {
      method: "POST",
      body: upstreamFormData,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      const errorMessage = data?.error ?? "Voice server error";
      return NextResponse.json({ error: errorMessage } satisfies ApiError, {
        status: response.status,
      });
    }

    const data = (await response.json()) as { text: string };
    return NextResponse.json({ text: data.text });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return NextResponse.json(
        { error: "Transcription timed out" } satisfies ApiError,
        { status: 504 },
      );
    }

    if (err instanceof TypeError) {
      return NextResponse.json(
        { error: "Voice server is not available" } satisfies ApiError,
        { status: 502 },
      );
    }

    const message = err instanceof Error ? err.message : "Transcription failed";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
