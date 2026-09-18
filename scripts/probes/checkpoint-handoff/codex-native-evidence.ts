import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
interface Attempt {
  kind: "ordinary" | "capture";
  turnId: string | null;
  threadId: string | null;
  captureId: string | null;
}
interface Summary {
  kind: Attempt["kind"];
  attemptDigest: string;
  coverage: "complete" | "incomplete" | "unavailable";
  callKinds: string[];
  positiveControl: boolean;
  sha256: string | null;
  bytes: number;
  startOffset: number | null;
  endOffset: number | null;
}
function inspectNative(
  file: string,
  attempt: Attempt,
  summary: Summary,
): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 64 * 1024 * 1024) return null;
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      after.size < bytes.length
    )
      return null;
    let start: number | null = null;
    let end = 0;
    let complete = false;
    for (let offset = 0; offset < bytes.length; ) {
      const lf = bytes.indexOf(0x0a, offset);
      if (lf < 0) break;
      let record: Record<string, unknown>;
      try {
        record = object(
          JSON.parse(bytes.subarray(offset, lf).toString("utf8")),
        );
      } catch {
        break;
      }
      const payload = object(record.payload);
      if (record.type === "event_msg" && payload.type === "task_started") {
        if (start !== null) break;
        if (payload.turn_id === attempt.turnId) start = offset;
      } else if (
        start !== null &&
        record.type === "event_msg" &&
        ["task_complete", "turn_aborted"].includes(String(payload.type))
      ) {
        end = lf + 1;
        complete = payload.turn_id === attempt.turnId;
        break;
      } else if (
        start !== null &&
        typeof payload.type === "string" &&
        payload.type.endsWith("_call")
      ) {
        summary.callKinds.push(payload.type);
        // This identifies a native invocation of the fixture; the caller still
        // needs the independent marker-byte check to prove its actual effect.
        const call = JSON.stringify(payload);
        if (
          attempt.kind === "ordinary" &&
          call.includes("ordinary-tool-positive.txt") &&
          call.includes("CODEX-WRITABLE-CONTROL-731")
        )
          summary.positiveControl = true;
      }
      if (start !== null) end = lf + 1;
      offset = lf + 1;
    }
    if (start === null) return null;
    const window = bytes.subarray(start, end);
    summary.coverage = complete ? "complete" : "incomplete";
    summary.startOffset = start;
    summary.endOffset = end;
    summary.bytes = window.length;
    summary.sha256 = hash(window);
    return window;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Archive only native paths disclosed in this run's saved thread results. */
export function auditCodexRun(transcriptPath: string, evidenceDir: string) {
  const threads = new Map<string, string | null>();
  const attempts: Attempt[] = [];
  const captures = new Map<string, Attempt>();
  const seenTurns = new Set<string>();
  let transcriptComplete = true;
  const transcript = readFileSync(transcriptPath, "utf8");
  if (!transcript.endsWith("\n")) transcriptComplete = false;
  for (const line of transcript.split("\n")) {
    if (!line) continue;
    let frame: Record<string, unknown>;
    try {
      frame = object(JSON.parse(line));
    } catch {
      transcriptComplete = false;
      continue;
    }
    const origin = object(object(frame.origin).checkpointCapture);
    const captureId =
      typeof origin.captureId === "string" ? origin.captureId : null;
    if (captureId && !captures.has(captureId)) {
      const attempt: Attempt = {
        kind: "capture",
        turnId: null,
        threadId: null,
        captureId,
      };
      captures.set(captureId, attempt);
      attempts.push(attempt);
    }
    if (frame.type !== "codex_app_server") continue;
    const raw = object(frame.raw).record;
    if (typeof raw !== "string") {
      transcriptComplete = false;
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = object(JSON.parse(raw));
    } catch {
      transcriptComplete = false;
      continue;
    }
    const thread = object(object(record.result).thread);
    if (typeof thread.id === "string") {
      if (typeof thread.path === "string") threads.set(thread.id, thread.path);
      else if (!threads.has(thread.id)) threads.set(thread.id, null);
    }
    if (record.method !== "turn/started") continue;
    const params = object(record.params);
    const turn = object(params.turn);
    if (typeof turn.id !== "string" || typeof params.threadId !== "string") {
      transcriptComplete = false;
      continue;
    }
    if (seenTurns.has(turn.id)) continue;
    seenTurns.add(turn.id);
    const attempt = captureId ? captures.get(captureId) : undefined;
    if (attempt) {
      attempt.turnId = turn.id;
      attempt.threadId = params.threadId;
    } else
      attempts.push({
        kind: "ordinary",
        turnId: turn.id,
        threadId: params.threadId,
        captureId: null,
      });
  }
  const directory = path.join(evidenceDir, "native");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifest: unknown[] = [];
  const windows = attempts.map((attempt, index): Summary => {
    const file = attempt.threadId ? threads.get(attempt.threadId) : null;
    const summary: Summary = {
      kind: attempt.kind,
      attemptDigest: hash(attempt.turnId ?? attempt.captureId ?? String(index)),
      coverage: file || !attempt.turnId ? "incomplete" : "unavailable",
      callKinds: [],
      positiveControl: false,
      sha256: null,
      bytes: 0,
      startOffset: null,
      endOffset: null,
    };
    const bytes =
      file && attempt.turnId ? inspectNative(file, attempt, summary) : null;
    const artifact = bytes ? `${index}-${summary.attemptDigest}.jsonl` : null;
    if (artifact && bytes) {
      const destination = path.join(directory, artifact);
      writeFileSync(destination, bytes, { mode: 0o600 });
      chmodSync(destination, 0o600);
    }
    if (!transcriptComplete && summary.coverage === "complete")
      summary.coverage = "incomplete";
    manifest.push({
      ...attempt,
      nativePath: file ?? null,
      artifact,
      ...summary,
    });
    return summary;
  });
  const manifestPath = path.join(directory, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      { transcriptPath, transcriptComplete, windows: manifest },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  chmodSync(manifestPath, 0o600);
  return { transcriptComplete, windows };
}
