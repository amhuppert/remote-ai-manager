const VOICE_SERVER_URL =
  process.env.VOICE_SERVER_URL ?? "http://localhost:7880";

export interface TranscribeProxyInput {
  audio: File;
  projectPath: string;
  context?: string;
}

export interface TranscribeProxySuccess {
  ok: true;
  text: string;
}

export interface TranscribeProxyFailure {
  ok: false;
  status: number;
  error: string;
}

export type TranscribeProxyResult =
  | TranscribeProxySuccess
  | TranscribeProxyFailure;

/**
 * Forward audio + project context to the Voice2Text server and return the
 * transcribed text or a normalized error.
 */
export async function proxyTranscribe(
  input: TranscribeProxyInput,
): Promise<TranscribeProxyResult> {
  const formData = new FormData();
  formData.set("audio", input.audio);
  formData.set("projectPath", input.projectPath);

  if (input.context && input.context.trim()) {
    formData.set("context", input.context);
  }

  try {
    const response = await fetch(`${VOICE_SERVER_URL}/transcribe`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      return {
        ok: false,
        status: response.status,
        error: data?.error ?? "Voice server error",
      };
    }

    const data = (await response.json()) as { text: string };
    return { ok: true, text: data.text };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, status: 504, error: "Transcription timed out" };
    }
    if (err instanceof TypeError) {
      return { ok: false, status: 502, error: "Voice server is not available" };
    }
    const message = err instanceof Error ? err.message : "Transcription failed";
    return { ok: false, status: 500, error: message };
  }
}

/** Check whether the upstream Voice2Text server is reachable. */
export async function checkVoiceHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${VOICE_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
