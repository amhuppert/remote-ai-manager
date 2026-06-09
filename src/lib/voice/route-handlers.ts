import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import { checkVoiceHealth, proxyTranscribe } from "@/lib/voice/transcribe";

const logger = createLogger("voice");

/** POST /api/voice/transcribe — proxy transcription to Voice2Text server */
export const POST_TRANSCRIBE = withTracing(async (request) => {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    // Log the reason: a request that 400s here never reaches the voice server
    // (no upstream call, no history row), so this is otherwise invisible.
    logger.warn("voice.transcribe.rejected", {
      reason: "invalid-form-data",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Invalid form data" } satisfies ApiError,
      { status: 400 },
    );
  }

  const audio = formData.get("audio");
  if (!audio || !(audio instanceof File)) {
    logger.warn("voice.transcribe.rejected", {
      reason: "missing-audio",
      audioType: audio === null ? "absent" : typeof audio,
    });
    return NextResponse.json(
      { error: "Missing audio file" } satisfies ApiError,
      { status: 400 },
    );
  }

  if (audio.size === 0) {
    // A zero-byte clip (e.g. the recorder produced no data) would fail upstream
    // with an opaque error and no useful row — reject it here with a clear reason.
    logger.warn("voice.transcribe.rejected", { reason: "empty-audio" });
    return NextResponse.json(
      { error: "No audio captured" } satisfies ApiError,
      { status: 400 },
    );
  }

  const projectName = formData.get("projectName");
  if (!projectName || typeof projectName !== "string") {
    logger.warn("voice.transcribe.rejected", {
      reason: "missing-project-name",
    });
    return NextResponse.json(
      { error: "Missing projectName" } satisfies ApiError,
      { status: 400 },
    );
  }

  const projectPath = await resolveProjectPath(projectName);
  if (!projectPath) {
    logger.warn("voice.transcribe.rejected", {
      reason: "project-not-found",
      projectName,
    });
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
