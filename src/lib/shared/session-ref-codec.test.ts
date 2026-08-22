import { describe, expect, it } from "vitest";
import {
  canonicalizeSessionRefsForStorageDeep,
  encodeAgentSessionRefForStorage,
  normalizeSessionRefsDeepInPlace,
  persistedAgentSessionRefSchema,
} from "./session-ref-codec";
import type { AgentSessionRef } from "./schemas";

describe("persistedAgentSessionRefSchema (lenient decode)", () => {
  it("decodes a legacy claude ref to the canonical shape", () => {
    const decoded = persistedAgentSessionRefSchema.parse({
      backend: "claude",
      sessionId: "sess-legacy-1",
    });
    expect(decoded).toEqual({ backend: "claude", ref: "sess-legacy-1" });
  });

  it("decodes a legacy codex ref to the canonical shape", () => {
    const decoded = persistedAgentSessionRefSchema.parse({
      backend: "codex",
      threadId: "thr-legacy-1",
    });
    expect(decoded).toEqual({ backend: "codex", ref: "thr-legacy-1" });
  });

  it("decodes a canonical ref unchanged", () => {
    const decoded = persistedAgentSessionRefSchema.parse({
      backend: "claude",
      ref: "sess-canonical-1",
    });
    expect(decoded).toEqual({ backend: "claude", ref: "sess-canonical-1" });
  });

  it("decodes a superset row to canonical, preferring ref", () => {
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

  it("decodes a superset cursor row through the superset arm", () => {
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

describe("canonicalizeSessionRefsForStorageDeep", () => {
  it("canonicalizes legacy refs at arbitrary depth, including arrays", () => {
    const tree = {
      context: {
        backendRef: { backend: "claude", sessionId: "sess-root" },
        forkedFrom: {
          sourceBackendRef: { backend: "codex", threadId: "thr-legacy" },
        },
      },
      children: {
        "0.conversation.executing": {
          snapshot: {
            input: {
              backendRef: { backend: "claude", sessionId: "sess-child" },
              history: [{ backend: "codex", threadId: "thr-in-array" }],
            },
          },
        },
      },
    };

    const { value, rewrittenRefs } =
      canonicalizeSessionRefsForStorageDeep(tree);

    expect(rewrittenRefs).toBe(4);
    expect(value.context.backendRef).toEqual({
      backend: "claude",
      ref: "sess-root",
    });
    expect(value.context.forkedFrom.sourceBackendRef).toEqual({
      backend: "codex",
      ref: "thr-legacy",
    });
    const childInput =
      value.children["0.conversation.executing"]!.snapshot.input;
    expect(childInput.backendRef).toEqual({
      backend: "claude",
      ref: "sess-child",
    });
    expect(childInput.history[0]).toEqual({
      backend: "codex",
      ref: "thr-in-array",
    });

    // The input tree is never mutated — the encoded tree is a clone.
    expect(tree.context.backendRef).toEqual({
      backend: "claude",
      sessionId: "sess-root",
    });
    expect(
      tree.children["0.conversation.executing"]!.snapshot.input.backendRef,
    ).toEqual({ backend: "claude", sessionId: "sess-child" });
  });

  it("is a no-op on an already-canonical tree: refs are left alone and the original object is returned", () => {
    const canonical = {
      backendRef: { backend: "claude", ref: "sess-1" },
    };
    const result = canonicalizeSessionRefsForStorageDeep(canonical);
    expect(result.rewrittenRefs).toBe(0);
    expect(result.value).toBe(canonical);
    expect(result.value.backendRef).toEqual({
      backend: "claude",
      ref: "sess-1",
    });
  });

  it("does not rewrite look-alike objects that fail the exact key-set match", () => {
    const tree = {
      // Canonical two-key ref: must NOT match the legacy-only write matcher.
      canonical: { backend: "claude", ref: "sess-canon" },
      // activeTurn-style object: has `backend` but extra keys.
      turn: { backend: "claude", sessionId: "x", promptText: "hi" },
      unknownBackend: { backend: "other", sessionId: "x" },
      emptyHandle: { backend: "claude", sessionId: "" },
    };
    const { value, rewrittenRefs } =
      canonicalizeSessionRefsForStorageDeep(tree);
    expect(rewrittenRefs).toBe(0);
    expect(value).toBe(tree);
  });

  // A backend with no legacy handle key has nothing to canonicalize: the write
  // transform must leave its canonical refs alone and must not treat a
  // look-alike two-key object as another backend's legacy shape.
  it("leaves cursor refs untouched — cursor has no legacy handle key", () => {
    const tree = {
      canonical: { backend: "cursor", ref: "agent-canon" },
      sessionIdLookAlike: { backend: "cursor", sessionId: "agent-x" },
      threadIdLookAlike: { backend: "cursor", threadId: "agent-x" },
    };
    const { value, rewrittenRefs } =
      canonicalizeSessionRefsForStorageDeep(tree);
    expect(rewrittenRefs).toBe(0);
    expect(value).toBe(tree);
  });
});

describe("normalizeSessionRefsDeepInPlace", () => {
  it("rewrites superset and legacy refs to canonical at arbitrary depth, in place", () => {
    const tree = {
      context: {
        backendRef: { backend: "claude", ref: "sess-r", sessionId: "sess-r" },
      },
      children: {
        child: {
          snapshot: {
            input: {
              backendRef: { backend: "codex", threadId: "thr-legacy" },
              refs: [{ backend: "codex", ref: "thr-s", threadId: "thr-s" }],
            },
          },
        },
      },
    };

    const rewritten = normalizeSessionRefsDeepInPlace(tree);

    expect(rewritten).toBe(3);
    expect(tree.context.backendRef).toEqual({
      backend: "claude",
      ref: "sess-r",
    });
    expect(tree.children.child.snapshot.input.backendRef).toEqual({
      backend: "codex",
      ref: "thr-legacy",
    });
    expect(tree.children.child.snapshot.input.refs[0]).toEqual({
      backend: "codex",
      ref: "thr-s",
    });
  });

  it("leaves canonical refs and look-alikes untouched", () => {
    const tree = {
      backendRef: { backend: "claude", ref: "sess-1" },
      turn: { backend: "claude", sessionId: "x", promptText: "hi" },
      mismatchedSuperset: { backend: "claude", ref: "a", threadId: "b" },
    };
    const rewritten = normalizeSessionRefsDeepInPlace(tree);
    expect(rewritten).toBe(0);
    expect(tree.backendRef).toEqual({ backend: "claude", ref: "sess-1" });
    expect(tree.turn).toEqual({
      backend: "claude",
      sessionId: "x",
      promptText: "hi",
    });
  });

  it("leaves cursor refs untouched — cursor has no legacy handle key", () => {
    const tree = {
      backendRef: { backend: "cursor", ref: "agent-1" },
      sessionIdLookAlike: { backend: "cursor", ref: "a", sessionId: "b" },
      threadIdLookAlike: { backend: "cursor", ref: "a", threadId: "b" },
    };
    const rewritten = normalizeSessionRefsDeepInPlace(tree);
    expect(rewritten).toBe(0);
    expect(tree.backendRef).toEqual({ backend: "cursor", ref: "agent-1" });
    expect(tree.sessionIdLookAlike).toEqual({
      backend: "cursor",
      ref: "a",
      sessionId: "b",
    });
  });
});
