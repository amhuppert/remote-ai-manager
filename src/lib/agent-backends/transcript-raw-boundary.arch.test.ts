// @vitest-inputs src/**/*.{ts,tsx}
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Architecture test (consolidated plan §3.1.3/§3.5.3): raw backend payloads
 * cross the seam only inside uninterpreted envelopes — the
 * `AgentTranscriptEntry` wrapper and the conversation JSONL frame's `raw`
 * field. Outside `src/lib/agent-backends/`, code that holds a
 * transcript-shaped value may pass it along whole but must never read into
 * its raw payload — interpretation belongs to the backend-owned decoders
 * behind `agent-backends/transcript-projections`.
 *
 * Grep-based on purpose: the corpus is EVERY non-test module under `src/`
 * outside the adapter seam. A module is transcript-shaped when it references
 * transcript machinery at all — the envelope module/type, the conversation
 * transcript module (`prompt/transcript`), its `TranscriptEntry` frame type,
 * or a transcript path — so JSONL re-parsers that never import the envelope
 * (the gap that previously hid `conversation-telemetry.ts` and
 * `prompt/transcript.ts`) are still in scope. Within the corpus, any `raw`
 * property access is an offender. Code that needs the payload belongs below
 * the seam.
 */

const REPO_SRC = path.resolve(__dirname, "..", "..");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "agent-backends") continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name) || /\.stories\.tsx?$/.test(name)) {
      continue;
    }
    out.push(full);
  }
  return out;
}

/**
 * A module handles transcript-shaped values when it references any transcript
 * machinery: the seam envelope, the conversation transcript module, the frame
 * type, or transcript path plumbing. Broader than envelope imports on
 * purpose — files that re-parse persisted transcript JSONL as plain records
 * still resolve the file through `getTranscriptPath`/`transcriptPath` or
 * name the frame type.
 */
function handlesTranscriptShapedValues(source: string): boolean {
  return (
    source.includes("agent-backends/transcript") ||
    source.includes("AgentTranscriptEntry") ||
    source.includes("prompt/transcript") ||
    source.includes("TranscriptEntry") ||
    source.includes("getTranscriptPath") ||
    source.includes("transcriptPath")
  );
}

/** Dot or bracket access of a `raw` property. */
const RAW_ACCESS = /\.raw\b|\[["']raw["']\]/;

describe("transcript raw-payload boundary", () => {
  it("no transcript-shaped module outside agent-backends/ reads into raw payloads", () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(REPO_SRC)) {
      const rel = path.relative(REPO_SRC, file);
      const source = readFileSync(file, "utf8");
      if (!handlesTranscriptShapedValues(source)) continue;
      if (!RAW_ACCESS.test(source)) continue;
      offenders.push(rel);
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the conversation actor and external-turn handler never touch a raw payload", () => {
    for (const rel of [
      "lib/workflows/conversation/actor-implementations.ts",
      "lib/workflows/conversation/external-turn-handler.ts",
    ]) {
      const source = readFileSync(path.join(REPO_SRC, rel), "utf8");
      expect(
        /entry\.raw|\.raw\./.test(source),
        `${rel} reads into a raw payload`,
      ).toBe(false);
      expect(
        source.includes("@anthropic-ai/claude-agent-sdk"),
        `${rel} imports the provider SDK`,
      ).toBe(false);
    }
  });
});
