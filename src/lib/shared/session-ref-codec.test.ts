import { describe, expect, it } from "vitest";
import {
  encodeAgentSessionRefForStorage,
  persistedAgentSessionRefSchema,
} from "./session-ref-codec";
import type { AgentSessionRef } from "./schemas";

describe("persistedAgentSessionRefSchema (canonical decode)", () => {
  it.each([
    { backend: "claude", sessionId: "sess-legacy-1" },
    { backend: "codex", threadId: "thr-legacy-1" },
  ])("requires the canonical ref field for $backend", (legacy) => {
    const result = persistedAgentSessionRefSchema.safeParse(legacy);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["ref"] })]),
      );
    }
  });

  it("decodes a canonical ref unchanged", () => {
    const decoded = persistedAgentSessionRefSchema.parse({
      backend: "claude",
      ref: "sess-canonical-1",
    });
    expect(decoded).toEqual({ backend: "claude", ref: "sess-canonical-1" });
  });

  it("strips unrecognized fields from a canonical row", () => {
    const decoded = persistedAgentSessionRefSchema.parse({
      backend: "codex",
      ref: "thr-super-1",
      threadId: "thr-super-1",
    });
    expect(decoded).toEqual({ backend: "codex", ref: "thr-super-1" });
  });

  it("decodes a canonical cursor ref unchanged", () => {
    const decoded = persistedAgentSessionRefSchema.parse({
      backend: "cursor",
      ref: "agent-canonical-1",
    });
    expect(decoded).toEqual({ backend: "cursor", ref: "agent-canonical-1" });
  });

  it("strips unrecognized fields from a canonical cursor row", () => {
    const decoded = persistedAgentSessionRefSchema.parse({
      backend: "cursor",
      ref: "agent-super-1",
      unexpectedExtra: "ignored",
    });
    expect(decoded).toEqual({ backend: "cursor", ref: "agent-super-1" });
  });

  // Cursor registered after the canonical shape existed, so no row anywhere
  // carries a legacy handle key for it. A decode that invented one would
  // accept a shape the product never wrote.
  it("rejects a fabricated legacy cursor handle", () => {
    expect(
      persistedAgentSessionRefSchema.safeParse({
        backend: "cursor",
        sessionId: "agent-legacy-1",
      }).success,
    ).toBe(false);
    expect(
      persistedAgentSessionRefSchema.safeParse({
        backend: "cursor",
        threadId: "agent-legacy-1",
      }).success,
    ).toBe(false);
  });

  it("rejects handle-less garbage", () => {
    expect(
      persistedAgentSessionRefSchema.safeParse({ backend: "claude" }).success,
    ).toBe(false);
    expect(persistedAgentSessionRefSchema.safeParse({}).success).toBe(false);
    expect(persistedAgentSessionRefSchema.safeParse("sess-1").success).toBe(
      false,
    );
    expect(
      persistedAgentSessionRefSchema.safeParse({
        backend: "other",
        ref: "x",
      }).success,
    ).toBe(false);
    expect(
      persistedAgentSessionRefSchema.safeParse({
        backend: "claude",
        ref: "",
      }).success,
    ).toBe(false);
  });
});

describe("encodeAgentSessionRefForStorage (canonical)", () => {
  it("returns the canonical claude ref with no mirrored sessionId key", () => {
    expect(
      encodeAgentSessionRefForStorage({ backend: "claude", ref: "sess-1" }),
    ).toEqual({ backend: "claude", ref: "sess-1" });
  });

  it("returns the canonical codex ref with no mirrored threadId key", () => {
    expect(
      encodeAgentSessionRefForStorage({ backend: "codex", ref: "thr-1" }),
    ).toEqual({ backend: "codex", ref: "thr-1" });
  });

  it("round-trips: decode(encode(x)) equals x", () => {
    const refs: AgentSessionRef[] = [
      { backend: "claude", ref: "sess-rt" },
      { backend: "codex", ref: "thr-rt" },
      { backend: "cursor", ref: "agent-rt" },
    ];
    for (const ref of refs) {
      expect(
        persistedAgentSessionRefSchema.parse(
          encodeAgentSessionRefForStorage(ref),
        ),
      ).toEqual(ref);
    }
  });
});
