import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CURSOR_IPC_CODEC_VERSION,
  CURSOR_NATIVE_TAG_KEY,
  MAX_NATIVE_ENCODE_DEPTH,
  MAX_NATIVE_ENCODE_NODES,
  MAX_NATIVE_ENCODED_BYTES,
  decodeNativePayload,
  decodeTaggedPayload,
  encodeNativePayload,
  parseParentFrame,
  parseWorkerFrame,
} from "./ipc";

const API_KEY = "key_sentinel_do_not_leak";

function roundTrip(eventType: string, value: unknown): unknown {
  const encoded = encodeNativePayload(eventType, value);
  expect(encoded.ok).toBe(true);
  if (!encoded.ok) throw new Error(encoded.violation);
  const decoded = decodeNativePayload(eventType, encoded.payload);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error(decoded.violation);
  return decoded.value;
}

function expectLossless(value: unknown, eventType = "assistant_message"): void {
  expect(roundTrip(eventType, value)).toStrictEqual(value);
}

/** Deterministic generator so a property-style failure is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(random: () => number, depth: number): unknown {
  const leaves: unknown[] = [
    undefined,
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -12.5,
    Number.MAX_SAFE_INTEGER,
    "",
    "truncated… [output limit reached]",
    true,
    false,
    9007199254740993n,
    -1n,
    new Uint8Array([0, 127, 255]),
    new Float64Array([1.5, Number.NaN]),
    Buffer.from("binary sentinel", "utf8"),
    { [CURSOR_NATIVE_TAG_KEY]: "escaped" },
    { [CURSOR_NATIVE_TAG_KEY]: { nested: undefined } },
  ];
  if (depth <= 0 || random() < 0.5) {
    const index = Math.floor(random() * leaves.length);
    return leaves[index];
  }
  const size = Math.floor(random() * 4);
  if (random() < 0.5) {
    return Array.from({ length: size }, () => randomValue(random, depth - 1));
  }
  const object: Record<string, unknown> = {};
  for (let index = 0; index < size; index += 1) {
    object[`k${index}`] = randomValue(random, depth - 1);
  }
  if (random() < 0.25) object[CURSOR_NATIVE_TAG_KEY] = randomValue(random, 0);
  return object;
}

function nest(depth: number): unknown {
  let value: unknown = "leaf";
  for (let level = 0; level < depth; level += 1) value = { child: value };
  return value;
}

describe("cursor native payload codec", () => {
  it("round-trips every JSON-edge value the fork channel would mangle", () => {
    expectLossless(undefined);
    expectLossless(Number.NaN);
    expectLossless(Number.POSITIVE_INFINITY);
    expectLossless(Number.NEGATIVE_INFINITY);
    expectLossless(170141183460469231731687303715884105727n);
    expectLossless(-42n);
    expectLossless(new Uint8Array([0, 1, 254, 255]));
    expectLossless(new Int32Array([-1, 0, 2147483647]));
    expectLossless(new Float64Array([Number.NaN, 1.25]));
    expectLossless(new BigInt64Array([-1n, 9007199254740993n]));
    expectLossless(Buffer.from([1, 2, 3]));
    expectLossless(new DataView(new Uint8Array([9, 8, 7]).buffer));
    expectLossless(new ArrayBuffer(4));
    expectLossless({
      type: "tool_call",
      args: undefined,
      score: Number.NaN,
      ceiling: Number.POSITIVE_INFINITY,
      floor: Number.NEGATIVE_INFINITY,
      cursorTokenId: 2n ** 70n,
      bytes: new Uint8Array([7]),
      nested: [undefined, Number.NaN, [new Uint8Array([1]), { deep: -0.5 }]],
    });
  });

  it("preserves unknown event types and unknown fields verbatim", () => {
    const unknownEvent = {
      type: "someFutureCursorEvent",
      unknownField: { alsoUnknown: [1, undefined, "x"] },
      truncationMarker: "…[truncated by cursor]",
    };
    expect(roundTrip("someFutureCursorEvent", unknownEvent)).toStrictEqual(
      unknownEvent,
    );
  });

  it("escapes application objects that already carry the tag key", () => {
    expectLossless({ [CURSOR_NATIVE_TAG_KEY]: "undefined" });
    expectLossless({
      [CURSOR_NATIVE_TAG_KEY]: "escaped",
      value: "not a wrapper",
    });
    expectLossless({
      [CURSOR_NATIVE_TAG_KEY]: "binary",
      view: "Uint8Array",
      base64: "AAA=",
    });
    expectLossless({
      outer: {
        [CURSOR_NATIVE_TAG_KEY]: {
          [CURSOR_NATIVE_TAG_KEY]: "bigint",
          value: "1",
        },
      },
    });
    // An escaped object still round-trips its own JSON-edge members.
    expectLossless({
      [CURSOR_NATIVE_TAG_KEY]: "escaped",
      payload: new Uint8Array([3]),
      missing: undefined,
    });
  });

  it("round-trips generated structures (property style)", () => {
    const random = mulberry32(0xc0ffee);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const value = randomValue(random, 4);
      expect(roundTrip("generated", value)).toStrictEqual(value);
    }
  });

  it("produces byte-stable payloads carrying the tagged JSON-safe form", () => {
    const value = { type: "x", missing: undefined, big: 5n };
    const first = encodeNativePayload("x", value);
    const second = encodeNativePayload("x", value);
    expect(first).toStrictEqual(second);
    if (!first.ok) throw new Error(first.violation);

    expect(first.byteLength).toBe(Buffer.byteLength(first.payload, "utf8"));
    expect(first.sha256).toBe(
      createHash("sha256").update(first.payload, "utf8").digest("hex"),
    );

    const decoded = decodeNativePayload("x", first.payload);
    if (!decoded.ok) throw new Error(decoded.violation);
    // `raw` is stored tagged: JSON-safe, so the transcript writer never sees a
    // value its own serializer would mangle.
    expect(JSON.parse(JSON.stringify(decoded.tagged))).toStrictEqual(
      decoded.tagged,
    );
  });
});

describe("cursor native payload bounds", () => {
  it("rejects cyclic input without throwing or echoing content", () => {
    const cyclic: Record<string, unknown> = { type: "loop", secret: API_KEY };
    cyclic.self = cyclic;

    const result = encodeNativePayload("loop", cyclic);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violation).toBe("cycle");
    expect(result.eventType).toBe("loop");
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(Object.keys(result).sort()).toStrictEqual([
      "byteLength",
      "eventType",
      "ok",
      "sha256",
      "violation",
    ]);
  });

  it("accepts the deepest allowed nesting and rejects one level deeper", () => {
    const allowed = encodeNativePayload(
      "deep",
      nest(MAX_NATIVE_ENCODE_DEPTH - 1),
    );
    expect(allowed.ok).toBe(true);

    const tooDeep = encodeNativePayload(
      "deep",
      nest(MAX_NATIVE_ENCODE_DEPTH + 1),
    );
    expect(tooDeep.ok).toBe(false);
    if (tooDeep.ok) return;
    expect(tooDeep.violation).toBe("max_depth");
    expect(tooDeep.eventType).toBe("deep");
    expect(tooDeep.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects payloads exceeding the node bound", () => {
    const wide = Array.from(
      { length: MAX_NATIVE_ENCODE_NODES + 10 },
      (_unused, index) => index,
    );

    const result = encodeNativePayload("wide", wide);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violation).toBe("max_nodes");
  });

  it("rejects payloads exceeding the serialized size bound", () => {
    const oversized = {
      type: "big",
      blob: "z".repeat(MAX_NATIVE_ENCODED_BYTES + 1),
    };

    const result = encodeNativePayload("big", oversized);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violation).toBe("max_bytes");
    expect(result.byteLength).toBeGreaterThan(MAX_NATIVE_ENCODED_BYTES);
    expect(JSON.stringify(result)).not.toContain("zzzz");
  });

  it("rejects non-serializable values", () => {
    const withFunction = { type: "fn", handler: () => "x" };
    const functionResult = encodeNativePayload("fn", withFunction);
    expect(functionResult.ok).toBe(false);
    if (!functionResult.ok) {
      expect(functionResult.violation).toBe("unsupported_value");
    }

    const withSymbol = { type: "sym", marker: Symbol("s") };
    const symbolResult = encodeNativePayload("sym", withSymbol);
    expect(symbolResult.ok).toBe(false);
    if (!symbolResult.ok) {
      expect(symbolResult.violation).toBe("unsupported_value");
    }
  });

  it("decodes a tagged form recovered from a durable envelope", () => {
    const value = {
      type: "reloaded",
      missing: undefined,
      bytes: new Uint8Array([2]),
    };
    const encoded = encodeNativePayload("reloaded", value);
    if (!encoded.ok) throw new Error(encoded.violation);

    // The round trip a transcript reload performs: JSON text → stored `raw` →
    // decoded native form.
    const stored: unknown = JSON.parse(encoded.payload);
    const decoded = decodeTaggedPayload("reloaded", stored);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toStrictEqual(value);

    const corrupt = decodeTaggedPayload("reloaded", {
      [CURSOR_NATIVE_TAG_KEY]: "notAWrapperKind",
    });
    expect(corrupt.ok).toBe(false);
    if (corrupt.ok) return;
    expect(corrupt.violation).toBe("malformed");
    expect(corrupt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("decodes malformed payloads into a bounded typed failure", () => {
    const result = decodeNativePayload("broken", `{"unterminated": ${API_KEY}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violation).toBe("malformed");
    expect(result.eventType).toBe("broken");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("keeps later valid events working after a violation", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(encodeNativePayload("loop", cyclic).ok).toBe(false);

    expect(roundTrip("ok", { type: "ok", value: undefined })).toStrictEqual({
      type: "ok",
      value: undefined,
    });
  });
});

describe("cursor IPC frames", () => {
  const initFrame = {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "init",
    conversationId: "conv-1",
    workerId: "worker-1",
    cwd: "/work/tree",
    storePath: "/state/cursor/conv-1",
    parentPid: 4242,
    idleTimeoutMs: 300_000,
    parentPollIntervalMs: 1_000,
    terminationGraceMs: 2_000,
    sdkVersion: "1.0.28",
  };

  const attachFrame = {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "attachAgent",
    mode: "resume",
    ref: "agent-ref-1",
    model: "composer-2.5",
    disallowedTools: ["askQuestion", "await"],
    sandboxEnabled: false,
    autoReview: false,
    settingSources: [],
    enableAgentRetries: true,
    mcpServers: {
      fixture: { command: "node", args: ["server.mjs"], env: { A: "1" } },
    },
  };

  const startTurnFrame = {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "startTurn",
    runId: "run-1",
    promptText: "hello",
    images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
    structuredOutputInstruction: null,
    model: "composer-2.5",
    mcpServers: {},
    forceExpirePersistedRun: false,
  };

  it("accepts every parent frame in the contract", () => {
    for (const frame of [
      initFrame,
      { v: CURSOR_IPC_CODEC_VERSION, type: "credential", apiKey: API_KEY },
      attachFrame,
      startTurnFrame,
      { v: CURSOR_IPC_CODEC_VERSION, type: "cancel", runId: "run-1" },
      { v: CURSOR_IPC_CODEC_VERSION, type: "shutdown", reason: "close" },
    ]) {
      const parsed = parseParentFrame(frame);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.frame.type).toBe(frame.type);
    }
  });

  it("accepts every worker frame in the contract", () => {
    for (const frame of [
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "ready",
        pid: 91,
        pgid: 91,
        nodeVersion: "v22.14.0",
        sdkVersion: "1.0.28",
      },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "preflightFailed",
        reason: "invalid_credential",
        message: "credential rejected",
      },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "attachResult",
        outcome: "attached",
        ref: "agent-ref-1",
        error: null,
      },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "refIssued",
        runId: "run-1",
        ref: "agent-ref-1",
      },
      // The ref reaches the parent at attach on the tested SDK, before any run
      // exists, so the run-less arm is part of the contract.
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "refIssued",
        runId: null,
        ref: "agent-ref-1",
      },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "nativeEventRejected",
        runId: "run-1",
        eventIndex: 3,
        eventType: "tool_call",
        violation: "max_bytes",
        byteLength: 4_194_304,
        sha256: "a".repeat(64),
      },
      { v: CURSOR_IPC_CODEC_VERSION, type: "inputAccepted", runId: "run-1" },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "nativeEvent",
        runId: "run-1",
        eventIndex: 0,
        eventType: "assistant_message",
        payload: '{"type":"assistant_message"}',
      },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "usage",
        runId: "run-1",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: 30,
        reasoningTokens: 5,
      },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "turnSettled",
        runId: "run-1",
        outcome: "failed",
        error: {
          name: "RateLimitError",
          code: "rate_limit",
          status: 429,
          message: "slow down",
        },
      },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "cancelResult",
        runId: "run-1",
        outcome: "cancelled",
        message: null,
      },
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "fatal",
        code: "worker_exit",
        message: "sdk crashed",
      },
    ]) {
      const parsed = parseWorkerFrame(frame);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.frame.type).toBe(frame.type);
    }
  });

  it("rejects a mismatched codec version without falling back", () => {
    const parsed = parseParentFrame({
      ...initFrame,
      v: CURSOR_IPC_CODEC_VERSION + 1,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("unsupported_version");
  });

  it("rejects unknown, malformed, and non-object frames without throwing", () => {
    for (const input of [
      { v: CURSOR_IPC_CODEC_VERSION, type: "notAFrame" },
      { v: CURSOR_IPC_CODEC_VERSION, type: "cancel" },
      null,
      "startTurn",
      42,
    ]) {
      const parsed = parseParentFrame(input);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe("invalid_frame");
    }
  });

  it("never echoes credential material in a rejection", () => {
    // A malformed credential frame still carries the key; the bounded
    // rejection must name the frame type and nothing else.
    const parsed = parseParentFrame({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "credential",
      apiKey: "",
      strayCopy: API_KEY,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("invalid_frame");
    expect(JSON.stringify(parsed)).not.toContain(API_KEY);
  });
});
