import { NextResponse } from "next/server";
import { resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import { checkVoiceHealth, proxyTranscribe } from "@/lib/voice/transcribe";
import { getErrorMessage } from "@/lib/shared/errors";

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
      error: getErrorMessage(err),
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

  // A named project must still resolve; an unnamed one is not an error. A
  // voice capture bound for a global notepad has no project to name, and the
  // upstream contract declares projectPath optional — so absence travels
  // through untouched rather than being filled in with a guess.
  const projectNameValue = formData.get("projectName");
  const projectName =
    typeof projectNameValue === "string" && projectNameValue.length > 0
      ? projectNameValue
      : null;

  let projectPath: string | undefined;
  if (projectName !== null) {
    const project = await resolveProjectOr404(
      { resolveProjectPath },
      projectName,
    );
    if (!project.ok) {
      logger.warn("voice.transcribe.rejected", {
        reason: "project-not-found",
        projectName,
      });
      return project.response;
    }
    projectPath = project.value;
  }

  const contextValue = formData.get("context");
  const context = typeof contextValue === "string" ? contextValue : undefined;

  const result = await proxyTranscribe({
    audio,
    ...(projectPath === undefined ? {} : { projectPath }),
    context,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error } satisfies ApiError, {
      status: result.status,
    });
  }
  return NextResponse.json({ text: result.text });
});

/** GET /api/voice/health — proxy health check to Voice2Text server */
async function getVoiceHealth(): Promise<Response> {
  const available = await checkVoiceHealth();
  return NextResponse.json({ available });
}

export const GET_HEALTH = withTracing(getVoiceHealth);
