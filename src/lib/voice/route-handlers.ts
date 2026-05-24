import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import { checkVoiceHealth, proxyTranscribe } from "@/lib/voice/transcribe";

/** POST /api/voice/transcribe — proxy transcription to Voice2Text server */
export const POST_TRANSCRIBE = withTracing(async (request) => {
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

  const contextValue = formData.get("context");
  const context = typeof contextValue === "string" ? contextValue : undefined;

  const result = await proxyTranscribe({ audio, projectPath, context });
  if (!result.ok) {
    return NextResponse.json({ error: result.error } satisfies ApiError, {
      status: result.status,
    });
  }
  return NextResponse.json({ text: result.text });
});

/** GET /api/voice/health — proxy health check to Voice2Text server */
export async function GET_HEALTH(): Promise<Response> {
  const available = await checkVoiceHealth();
  return NextResponse.json({ available });
}
