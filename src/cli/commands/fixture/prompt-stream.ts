export type SseOutcome =
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "ended" }
  | { kind: "stopped" };
/** The stream is server protocol data, independent of CLI rendering. */
export async function readSseUntilDone(
  response: Response,
  signal: AbortSignal,
): Promise<SseOutcome> {
  if (!response.body) return { kind: "ended" };
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  try {
    for (;;) {
      if (signal.aborted) return { kind: "stopped" };
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
          currentEvent = trimmed.slice(6).trim();
          if (currentEvent === "done") return { kind: "done" };
        } else if (trimmed.startsWith("data:") && currentEvent === "error")
          return { kind: "error", message: trimmed.slice(5).trim() };
      }
      if (done)
        return signal.aborted
          ? { kind: "stopped" }
          : currentEvent === "error"
            ? { kind: "error", message: "turn failed" }
            : { kind: "ended" };
    }
  } catch (error) {
    return signal.aborted
      ? { kind: "stopped" }
      : {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        };
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
