import { afterEach, describe, expect, it } from "vitest";

import { POST_TRANSCRIBE } from "./route-handlers";
import { _setTranscribeFetchForTesting } from "./transcribe";

/**
 * The transcribe route's project contract. A quick capture whose destination is
 * a global notepad has no project to name, and the Voice2Text server's own
 * contract declares `projectPath` optional — so absence must travel all the way
 * through rather than being papered over with an invented project.
 */

interface UpstreamCall {
  projectPath: FormDataEntryValue | null;
  context: FormDataEntryValue | null;
  audioName: string | null;
}

const calls: UpstreamCall[] = [];

function captureUpstream(): void {
  _setTranscribeFetchForTesting(async (_input, init) => {
    const body = init?.body;
    if (!(body instanceof FormData))
      throw new Error("expected a multipart body");
    const audio = body.get("audio");
    calls.push({
      projectPath: body.get("projectPath"),
      context: body.get("context"),
      audioName: audio instanceof File ? audio.name : null,
    });
    return Response.json({
      rawText: "raw",
      cleanText: "A captured thought.",
      status: "ok",
      sessionId: 1,
    });
  });
}

function transcribeRequest(fields: {
  projectName?: string;
  context?: string;
}): Request {
  const form = new FormData();
  form.set(
    "audio",
    new File(["audio-bytes"], "clip.webm", { type: "audio/webm" }),
  );
  if (fields.projectName !== undefined) {
    form.set("projectName", fields.projectName);
  }
  if (fields.context !== undefined) form.set("context", fields.context);
  return new Request("http://localhost/api/voice/transcribe", {
    method: "POST",
    body: form,
  });
}

function invoke(request: Request): Promise<Response> {
  return POST_TRANSCRIBE(request, { params: Promise.resolve({}) });
}

afterEach(() => {
  _setTranscribeFetchForTesting(undefined);
  calls.length = 0;
});

describe("POST /api/voice/transcribe project handling (R25 no-project path)", () => {
  it("accepts a request that names no project and omits projectPath upstream", async () => {
    captureUpstream();

    const response = await invoke(transcribeRequest({}));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "A captured thought." });
    expect(calls).toHaveLength(1);
    // Never invent a project: the field is absent, not an empty string.
    expect(calls[0]?.projectPath).toBeNull();
    expect(calls[0]?.audioName).toBe("clip.webm");
  });

  it("still forwards transcription context without a project", async () => {
    captureUpstream();

    await invoke(transcribeRequest({ context: "Existing notepad content." }));

    expect(calls[0]?.context).toBe("Existing notepad content.");
    expect(calls[0]?.projectPath).toBeNull();
  });

  it("still refuses a named project that does not resolve", async () => {
    captureUpstream();

    const response = await invoke(
      transcribeRequest({ projectName: "no-such-project-9f2a1c" }),
    );

    expect(response.status).toBe(404);
    // A 404 must not have reached the voice server at all.
    expect(calls).toHaveLength(0);
  });

  it("still refuses a request with no audio", async () => {
    captureUpstream();
    const form = new FormData();
    const response = await invoke(
      new Request("http://localhost/api/voice/transcribe", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
