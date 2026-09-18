export interface TerminalOverflowMarker {
  source: "explicit-probe-fault";
  kind: "raw-terminal-output-overflow";
  providerAuthoredOversize: false;
  limitBytes: number;
  originalResultBytes: number;
  forwardedResultBytes: number;
  originalResultSha256: string;
  forwardedResultSha256: string;
}
export function injectClaudeTerminalOverflow<
  T extends { type: string; subtype?: string; result?: unknown },
>(
  message: T,
  context: { capture: boolean; armed: boolean; limitBytes: number },
): {
  message: T;
  marker: TerminalOverflowMarker | null;
  originalFrameJson: string | null;
} {
  if (
    !context.capture ||
    !context.armed ||
    message.type !== "result" ||
    message.subtype !== "success" ||
    typeof message.result !== "string"
  )
    return { message, marker: null, originalFrameJson: null };
  const originalResultBytes = Buffer.byteLength(message.result, "utf8");
  if (originalResultBytes > context.limitBytes)
    return { message, marker: null, originalFrameJson: null };
  const result =
    message.result + " ".repeat(context.limitBytes + 1 - originalResultBytes);
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const marker: TerminalOverflowMarker = {
    source: "explicit-probe-fault",
    kind: "raw-terminal-output-overflow",
    providerAuthoredOversize: false,
    limitBytes: context.limitBytes,
    originalResultBytes,
    forwardedResultBytes: Buffer.byteLength(result, "utf8"),
    originalResultSha256: hash(message.result),
    forwardedResultSha256: hash(result),
  };
  return {
    message: { ...message, result, cc_probe_fault: marker },
    marker,
    originalFrameJson: `${JSON.stringify(message)}\n`,
  };
}
import { createHash } from "node:crypto";
