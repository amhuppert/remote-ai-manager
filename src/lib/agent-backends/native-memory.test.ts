/**
 * The disclosure derivation both surfaces read (spec `memory` R14, criterion
 * memory-crit-native-disclosure).
 *
 * The nothing-to-disclose case is the one worth pinning hardest: a notice that
 * appears for a backend Command Center DID neutralize teaches the operator to
 * ignore it, at which point the real exception is invisible too.
 */

import { describe, expect, it } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  listNativeMemoryExceptions,
  renderNativeMemoryDisclosureLine,
  type NativeMemoryDeclarant,
} from "./native-memory";

function declarant(
  id: AgentBackendId,
  label: string,
  nativeMemory: NativeMemoryDeclarant["nativeMemory"],
): NativeMemoryDeclarant {
  return { id, label, nativeMemory };
}

const NEUTRALIZED = declarant("claude", "Claude", {
  mechanism: "disabled",
  lever: "settings",
});
const EXCEPTION = declarant("cursor", "Cursor", {
  mechanism: "none",
  reason: "the SDK exposes no lever",
});

describe("listNativeMemoryExceptions", () => {
  it("names only the backends with no disable mechanism", () => {
    expect(listNativeMemoryExceptions([NEUTRALIZED, EXCEPTION])).toEqual([
      {
        backend: "cursor",
        label: "Cursor",
        reason: "the SDK exposes no lever",
      },
    ]);
  });

  it("returns nothing when every backend is neutralized", () => {
    expect(listNativeMemoryExceptions([NEUTRALIZED])).toEqual([]);
  });
});

describe("renderNativeMemoryDisclosureLine", () => {
  it("returns null when there is nothing to disclose", () => {
    expect(renderNativeMemoryDisclosureLine([])).toBeNull();
  });

  it("names the backend and the reason on one line", () => {
    const line = renderNativeMemoryDisclosureLine(
      listNativeMemoryExceptions([NEUTRALIZED, EXCEPTION]),
    );
    expect(line).not.toBeNull();
    expect(line).toContain("Cursor");
    expect(line).toContain("the SDK exposes no lever");
    expect(line).toContain("native memory not disabled:");
    expect(line).not.toContain("still running");
    // One line: this rides a header, not a paragraph.
    expect(line).not.toContain("\n");
    // A neutralized backend is never named — the notice would stop meaning
    // "this one still has its own memory".
    expect(line).not.toContain("Claude");
  });

  it("names every exception when more than one backend lacks a lever", () => {
    const line = renderNativeMemoryDisclosureLine(
      listNativeMemoryExceptions([
        EXCEPTION,
        declarant("codex", "Codex", {
          mechanism: "none",
          reason: "hypothetical second exception",
        }),
      ]),
    );
    expect(line).toContain("Cursor");
    expect(line).toContain("Codex");
  });
});
