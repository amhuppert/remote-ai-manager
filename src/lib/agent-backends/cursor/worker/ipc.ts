import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The Cursor worker IPC contract: versioned Zod-validated frames plus the
 * lossless tagged encoding applied to native SDK payloads before Node's fork
 * channel serializes them (spec D7).
 *
 * Node IPC JSON-serializes every frame, which mangles `undefined`, `NaN`,
 * signed `Infinity`, and binary views and throws on `BigInt`, so losslessness
 * has to be established in the worker — nothing downstream can recover what
 * the channel already destroyed.
 */

export const CURSOR_IPC_CODEC_VERSION = 1;

/**
 * Reserved wrapper key. An application object that already owns this key is
 * escaped rather than reinterpreted, so payload data can never collide with
 * the encoding.
 */
export const CURSOR_NATIVE_TAG_KEY = "$ccCursorNative";

export const MAX_NATIVE_ENCODE_DEPTH = 64;
export const MAX_NATIVE_ENCODE_NODES = 100_000;
export const MAX_NATIVE_ENCODED_BYTES = 2 * 1024 * 1024;

export type NativeCodecViolation =
  | "cycle"
  | "max_depth"
  | "max_nodes"
  | "max_bytes"
  | "unsupported_value"
  | "malformed";

/**
 * Bounded failure diagnostics. Deliberately carries no payload content: the
 * event type, the observed byte length, and a content hash are enough to
 * correlate a rejected event across logs without echoing it.
 */
export interface NativeCodecFailure {
  ok: false;
  violation: NativeCodecViolation;
  eventType: string;
  byteLength: number;
  sha256: string;
}

export interface NativeEncodeSuccess {
  ok: true;
  eventType: string;
  /** Tagged JSON text; exactly the bytes measured against the size bound. */
  payload: string;
  byteLength: number;
  sha256: string;
}

export type NativeEncodeResult = NativeEncodeSuccess | NativeCodecFailure;

export interface NativeDecodeSuccess {
  ok: true;
  /** The tagged JSON-safe form the durable envelope stores as `raw`. */
  tagged: unknown;
  /** The exact inverse of the encoded input. */
  value: unknown;
}

export type NativeDecodeResult = NativeDecodeSuccess | NativeCodecFailure;

const TAG_UNDEFINED = "undefined";
const TAG_NAN = "nan";
const TAG_INFINITY = "infinity";
const TAG_BIGINT = "bigint";
const TAG_BINARY = "binary";
const TAG_ESCAPED = "escaped";

type BinaryViewName =
  | "ArrayBuffer"
  | "DataView"
  | "Buffer"
  | "Int8Array"
  | "Uint8Array"
  | "Uint8ClampedArray"
  | "Int16Array"
  | "Uint16Array"
  | "Int32Array"
  | "Uint32Array"
  | "Float32Array"
  | "Float64Array"
  | "BigInt64Array"
  | "BigUint64Array";

const TYPED_ARRAY_CONSTRUCTORS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const;

type TypedArrayName = keyof typeof TYPED_ARRAY_CONSTRUCTORS;

function isTypedArrayName(name: string): name is TypedArrayName {
  return Object.hasOwn(TYPED_ARRAY_CONSTRUCTORS, name);
}

function ownsTag(value: object): boolean {
  return Object.hasOwn(value, CURSOR_NATIVE_TAG_KEY);
}

interface BinarySource {
  view: BinaryViewName;
  bytes: Buffer;
}

function binarySource(value: object): BinarySource | null {
  if (Buffer.isBuffer(value)) return { view: "Buffer", bytes: value };
  if (value instanceof ArrayBuffer) {
    return { view: "ArrayBuffer", bytes: Buffer.from(value) };
  }
  if (value instanceof DataView) {
    return {
      view: "DataView",
      bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    };
  }
  if (!ArrayBuffer.isView(value)) return null;
  const name = value.constructor.name;
  if (!isTypedArrayName(name)) return null;
  return {
    view: name,
    bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  };
}

/**
 * JSON sink that hashes and measures as it writes, so the size bound is
 * enforced against exactly the bytes that would cross the channel and every
 * violation class still yields a byte length and a hash. Writing stops at the
 * first overflow, so a hostile payload cannot be materialized twice.
 */
class BoundedJsonSink {
  private readonly chunks: string[] = [];
  private readonly hasher = createHash("sha256");
  private bytes = 0;
  private stopped = false;

  write(text: string): void {
    if (this.stopped) return;
    this.bytes += Buffer.byteLength(text, "utf8");
    if (this.bytes > MAX_NATIVE_ENCODED_BYTES) {
      this.stopped = true;
      return;
    }
    this.hasher.update(text);
    this.chunks.push(text);
  }

  /**
   * Strings are the one leaf whose escaped form can dwarf the bound, so the
   * raw size is charged before `JSON.stringify` materializes a second copy.
   */
  writeString(value: string): void {
    if (this.stopped) return;
    const rawBytes = Buffer.byteLength(value, "utf8") + 2;
    if (this.bytes + rawBytes > MAX_NATIVE_ENCODED_BYTES) {
      this.bytes += rawBytes;
      this.stopped = true;
      return;
    }
    this.write(JSON.stringify(value));
  }

  /** Charges bytes for a leaf too large to serialize, without building it. */
  overflow(extraBytes: number): void {
    if (this.stopped) return;
    this.bytes += extraBytes;
    this.stopped = true;
  }

  get overflowed(): boolean {
    return this.stopped;
  }

  get byteLength(): number {
    return this.bytes;
  }

  text(): string {
    return this.chunks.join("");
  }

  digest(): string {
    return this.hasher.copy().digest("hex");
  }
}

interface EncodeWalkState {
  sink: BoundedJsonSink;
  path: Set<object>;
  nodes: number;
}

function emit(
  value: unknown,
  depth: number,
  state: EncodeWalkState,
): NativeCodecViolation | null {
  state.nodes += 1;
  if (state.nodes > MAX_NATIVE_ENCODE_NODES) return "max_nodes";
  if (depth > MAX_NATIVE_ENCODE_DEPTH) return "max_depth";

  if (value === undefined) {
    state.sink.write(
      `{${JSON.stringify(CURSOR_NATIVE_TAG_KEY)}:"${TAG_UNDEFINED}"}`,
    );
    return state.sink.overflowed ? "max_bytes" : null;
  }
  if (value === null) {
    state.sink.write("null");
    return state.sink.overflowed ? "max_bytes" : null;
  }

  if (typeof value === "object") return emitObject(value, depth, state);

  switch (typeof value) {
    case "boolean":
      state.sink.write(value ? "true" : "false");
      return state.sink.overflowed ? "max_bytes" : null;
    case "number":
      state.sink.write(numberText(value));
      return state.sink.overflowed ? "max_bytes" : null;
    case "bigint":
      state.sink.write(
        `{${JSON.stringify(CURSOR_NATIVE_TAG_KEY)}:"${TAG_BIGINT}","value":${JSON.stringify(value.toString(10))}}`,
      );
      return state.sink.overflowed ? "max_bytes" : null;
    case "string":
      state.sink.writeString(value);
      return state.sink.overflowed ? "max_bytes" : null;
    default:
      // Functions and symbols have no serialized form; failing closed keeps a
      // hostile or unexpected value from silently vanishing mid-payload.
      return "unsupported_value";
  }
}

function numberText(value: number): string {
  if (Number.isNaN(value)) {
    return `{${JSON.stringify(CURSOR_NATIVE_TAG_KEY)}:"${TAG_NAN}"}`;
  }
  if (
    value === Number.POSITIVE_INFINITY ||
    value === Number.NEGATIVE_INFINITY
  ) {
    return `{${JSON.stringify(CURSOR_NATIVE_TAG_KEY)}:"${TAG_INFINITY}","negative":${value < 0}}`;
  }
  return JSON.stringify(value);
}

function emitObject(
  value: object,
  depth: number,
  state: EncodeWalkState,
): NativeCodecViolation | null {
  if (state.path.has(value)) return "cycle";

  const binary = binarySource(value);
  if (binary !== null) {
    const base64Bytes = Math.ceil(binary.bytes.byteLength / 3) * 4;
    if (state.sink.byteLength + base64Bytes > MAX_NATIVE_ENCODED_BYTES) {
      state.sink.overflow(base64Bytes);
      return "max_bytes";
    }
    state.sink.write(
      `{${JSON.stringify(CURSOR_NATIVE_TAG_KEY)}:"${TAG_BINARY}","view":${JSON.stringify(binary.view)},"base64":${JSON.stringify(binary.bytes.toString("base64"))}}`,
    );
    return state.sink.overflowed ? "max_bytes" : null;
  }

  state.path.add(value);
  try {
    if (Array.isArray(value)) return emitArray(value, depth, state);

    // `toJSON` is honored exactly as `JSON.stringify` would, so an object that
    // defines its own JSON form (a Date, an SDK value type) carries that form
    // across instead of collapsing to `{}` for lack of own enumerable keys.
    const replaced = callToJson(value);
    if (replaced !== value) return emit(replaced, depth, state);

    return emitPlainObject(value, depth, state);
  } finally {
    state.path.delete(value);
  }
}

function callToJson(value: object): unknown {
  const toJson: unknown = Reflect.get(value, "toJSON");
  if (typeof toJson !== "function") return value;
  return Reflect.apply(toJson, value, []);
}

function emitArray(
  value: readonly unknown[],
  depth: number,
  state: EncodeWalkState,
): NativeCodecViolation | null {
  state.sink.write("[");
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) state.sink.write(",");
    if (state.sink.overflowed) return "max_bytes";
    const violation = emit(value[index], depth + 1, state);
    if (violation !== null) return violation;
  }
  state.sink.write("]");
  return state.sink.overflowed ? "max_bytes" : null;
}

function emitPlainObject(
  value: object,
  depth: number,
  state: EncodeWalkState,
): NativeCodecViolation | null {
  if (!ownsTag(value)) return emitEntries(value, depth, state);

  state.sink.write(
    `{${JSON.stringify(CURSOR_NATIVE_TAG_KEY)}:"${TAG_ESCAPED}","value":`,
  );
  if (state.sink.overflowed) return "max_bytes";
  const violation = emitEntries(value, depth, state);
  if (violation !== null) return violation;
  state.sink.write("}");
  return state.sink.overflowed ? "max_bytes" : null;
}

function emitEntries(
  value: object,
  depth: number,
  state: EncodeWalkState,
): NativeCodecViolation | null {
  state.sink.write("{");
  let first = true;
  for (const key of Object.keys(value)) {
    if (!first) state.sink.write(",");
    first = false;
    state.sink.writeString(key);
    state.sink.write(":");
    if (state.sink.overflowed) return "max_bytes";
    const violation = emit(Reflect.get(value, key), depth + 1, state);
    if (violation !== null) return violation;
  }
  state.sink.write("}");
  return state.sink.overflowed ? "max_bytes" : null;
}

export function encodeNativePayload(
  eventType: string,
  value: unknown,
): NativeEncodeResult {
  const sink = new BoundedJsonSink();
  const state: EncodeWalkState = { sink, path: new Set(), nodes: 0 };
  const violation = emit(value, 1, state);

  if (violation !== null) {
    return {
      ok: false,
      violation,
      eventType,
      byteLength: sink.byteLength,
      sha256: sink.digest(),
    };
  }

  return {
    ok: true,
    eventType,
    payload: sink.text(),
    byteLength: sink.byteLength,
    sha256: sink.digest(),
  };
}

/** Thrown only inside the decode walk; converted to a bounded failure. */
class TaggedDecodeError extends Error {}

function decodeTagged(tagged: unknown): unknown {
  if (tagged === null || typeof tagged !== "object") return tagged;
  if (Array.isArray(tagged)) return tagged.map(decodeTagged);
  if (!ownsTag(tagged)) return decodeEntries(tagged);

  const kind: unknown = Reflect.get(tagged, CURSOR_NATIVE_TAG_KEY);
  switch (kind) {
    case TAG_UNDEFINED:
      return undefined;
    case TAG_NAN:
      return Number.NaN;
    case TAG_INFINITY:
      return Reflect.get(tagged, "negative") === true
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY;
    case TAG_BIGINT:
      return decodeBigInt(Reflect.get(tagged, "value"));
    case TAG_BINARY:
      return decodeBinary(
        Reflect.get(tagged, "view"),
        Reflect.get(tagged, "base64"),
      );
    case TAG_ESCAPED: {
      const escaped: unknown = Reflect.get(tagged, "value");
      if (escaped === null || typeof escaped !== "object") {
        throw new TaggedDecodeError("escaped wrapper without an object");
      }
      return decodeEntries(escaped);
    }
    default:
      throw new TaggedDecodeError("unknown wrapper kind");
  }
}

function decodeEntries(tagged: object): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const key of Object.keys(tagged)) {
    decoded[key] = decodeTagged(Reflect.get(tagged, key));
  }
  return decoded;
}

function decodeBigInt(raw: unknown): bigint {
  if (typeof raw !== "string") {
    throw new TaggedDecodeError("bigint wrapper without a decimal string");
  }
  try {
    return BigInt(raw);
  } catch {
    throw new TaggedDecodeError("bigint wrapper with an unparsable value");
  }
}

function decodeBinary(view: unknown, base64: unknown): unknown {
  if (typeof view !== "string" || typeof base64 !== "string") {
    throw new TaggedDecodeError("binary wrapper without view and base64");
  }
  const bytes = Buffer.from(base64, "base64");
  if (view === "Buffer") return bytes;

  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  if (view === "ArrayBuffer") return buffer;
  if (view === "DataView") return new DataView(buffer);
  if (!isTypedArrayName(view)) {
    throw new TaggedDecodeError("binary wrapper with an unknown view");
  }
  return new TYPED_ARRAY_CONSTRUCTORS[view](buffer);
}

/**
 * Decodes a tagged form already recovered from a durable envelope's `raw`.
 * `decodeNativePayload` is the wire entry point; this one serves reload.
 */
export function decodeTaggedPayload(
  eventType: string,
  tagged: unknown,
): NativeDecodeResult {
  try {
    return { ok: true, tagged, value: decodeTagged(tagged) };
  } catch {
    return malformed(eventType, tagged);
  }
}

export function decodeNativePayload(
  eventType: string,
  payload: string,
): NativeDecodeResult {
  let tagged: unknown;
  try {
    tagged = JSON.parse(payload) as unknown;
  } catch {
    return {
      ok: false,
      violation: "malformed",
      eventType,
      byteLength: Buffer.byteLength(payload, "utf8"),
      sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
    };
  }
  return decodeTaggedPayload(eventType, tagged);
}

function malformed(eventType: string, tagged: unknown): NativeCodecFailure {
  const encoded = encodeNativePayload(eventType, tagged);
  return {
    ok: false,
    violation: "malformed",
    eventType,
    byteLength: encoded.byteLength,
    sha256: encoded.sha256,
  };
}

const mcpServerMapSchema = z.record(
  z.string().min(1),
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string().min(1), z.string()),
    cwd: z.string().min(1).optional(),
  }),
);

const versionSchema = z.literal(CURSOR_IPC_CODEC_VERSION);

/**
 * The worker's whole lifetime contract arrives in one frame. The bounds are
 * stated by the supervisor rather than defaulted in the worker so exactly one
 * side owns them: a worker that disagreed with its supervisor about the idle
 * bound would be reaped twice or never.
 */
const initFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("init"),
  conversationId: z.string().min(1),
  workerId: z.string().min(1),
  cwd: z.string().min(1),
  storePath: z.string().min(1),
  parentPid: z.number().int().positive(),
  idleTimeoutMs: z.number().int().positive(),
  /** Cadence of the worker's parent-liveness poll. */
  parentPollIntervalMs: z.number().int().positive(),
  /** Disposal window and post-SIGTERM grace of the worker's own teardown. */
  terminationGraceMs: z.number().int().positive(),
  sdkVersion: z.string().min(1),
});

const credentialFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("credential"),
  apiKey: z.string().min(1),
});

/**
 * Create-or-resume options the SDK does not persist, so the full set is
 * re-passed on every attach (D11). The literal `false` arms and the empty
 * `settingSources` make the Phase 1 policy a wire-level invariant rather than
 * a convention the worker could drift from.
 */
const attachAgentFrameSchema = z
  .object({
    v: versionSchema,
    type: z.literal("attachAgent"),
    mode: z.enum(["create", "resume"]),
    ref: z.string().min(1).nullable(),
    model: z.string().min(1),
    disallowedTools: z.array(z.string().min(1)),
    sandboxEnabled: z.literal(false),
    autoReview: z.literal(false),
    settingSources: z.array(z.string()).max(0),
    /**
     * The SDK's transport/stall auto-retry knob (`local.enableAgentRetries`) is
     * a boolean, so the frame carries the value the policy module fixes rather
     * than a backoff shape the SDK has no option for.
     */
    enableAgentRetries: z.boolean(),
    mcpServers: mcpServerMapSchema,
  })
  .refine((frame) => frame.mode === "create" || frame.ref !== null, {
    message: "resume requires a ref",
  });

const startTurnFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("startTurn"),
  runId: z.string().min(1),
  promptText: z.string(),
  /**
   * Already in the SDK's `SDKImage` base64 shape and already bounds-checked
   * parent-side (D15), so the worker passes these through without translating
   * or re-validating — the bounds must hold before a turn starts.
   */
  images: z.array(
    z.object({ data: z.string().min(1), mimeType: z.string().min(1) }),
  ),
  structuredOutputInstruction: z.string().nullable(),
  model: z.string().min(1),
  mcpServers: mcpServerMapSchema,
  /**
   * The SDK's per-send force-expiry option (`local.force`): expire the agent's
   * currently active persisted run before starting this one. Recovery for an
   * agent left wedged by a crashed process, and admitted only when the
   * supervisor's registry proves no live local worker owns the ref (D12).
   */
  forceExpirePersistedRun: z.boolean(),
});

const cancelFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("cancel"),
  runId: z.string().min(1),
});

const shutdownFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("shutdown"),
  reason: z.enum(["close", "idle", "parent_exit"]),
});

export const cursorParentFrameSchema = z.union([
  initFrameSchema,
  credentialFrameSchema,
  attachAgentFrameSchema,
  startTurnFrameSchema,
  cancelFrameSchema,
  shutdownFrameSchema,
]);

const readyFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("ready"),
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  nodeVersion: z.string().min(1),
  sdkVersion: z.string().min(1),
});

export const cursorPreflightFailureReasonSchema = z.enum([
  "missing_credential",
  "invalid_credential",
  "credential_network",
  "credential_timeout",
  "sdk_load_failed",
]);
export type CursorPreflightFailureReason = z.infer<
  typeof cursorPreflightFailureReasonSchema
>;

const preflightFailedFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("preflightFailed"),
  reason: cursorPreflightFailureReasonSchema,
  message: z.string(),
});

/**
 * `runId` is null when the ref is exposed at attach rather than mid-turn, which
 * is what the tested SDK does — `Agent.create` returns the agent id before any
 * run exists. The nullable arm keeps the eager-persistence signal (D8) on one
 * frame instead of splitting it by when the SDK happened to reveal the ref.
 */
const refIssuedFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("refIssued"),
  runId: z.string().min(1).nullable(),
  ref: z.string().min(1),
});

/**
 * The SDK error taxonomy as it survives the process boundary. Class identity
 * does not cross IPC, so the classifier's stable seams — name, code, status —
 * are carried explicitly (see `failure-classifier.ts`).
 */
const sdkErrorSchema = z.object({
  name: z.string().min(1).nullable(),
  code: z.string().min(1).nullable(),
  status: z.number().int().nullable(),
  message: z.string(),
});

export type CursorSdkErrorFrameDetail = z.infer<typeof sdkErrorSchema>;

/**
 * Attach settlement. Create and resume both report through it, so a resume
 * against a stale, cross-workspace, or already-active ref reaches the parent as
 * a classifiable error rather than a dead worker.
 */
const attachResultFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("attachResult"),
  outcome: z.enum(["attached", "failed"]),
  ref: z.string().min(1).nullable(),
  error: sdkErrorSchema.nullable(),
});

const inputAcceptedFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("inputAccepted"),
  runId: z.string().min(1),
});

/**
 * `payload` is the tagged JSON text `encodeNativePayload` produced; the parent
 * persists its parsed form as the envelope's `raw` before any projection.
 * `runId` plus `eventIndex` are the run-scoped identity the exactly-once
 * append boundary keys on (D21).
 */
const nativeEventFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("nativeEvent"),
  runId: z.string().min(1),
  eventIndex: z.number().int().nonnegative(),
  eventType: z.string(),
  payload: z.string(),
});

/**
 * An event the encoder refused (D7). Carries the same bounded diagnostics
 * `NativeCodecFailure` does — type, byte length, hash — and no payload content,
 * so a hostile or oversized event is reportable without being echoed. The index
 * is still consumed, so the run's event sequence stays monotonic.
 */
const nativeEventRejectedFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("nativeEventRejected"),
  runId: z.string().min(1),
  eventIndex: z.number().int().nonnegative(),
  eventType: z.string(),
  violation: z.enum([
    "cycle",
    "max_depth",
    "max_nodes",
    "max_bytes",
    "unsupported_value",
    "malformed",
  ]),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().min(1),
});

const usageFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("usage"),
  runId: z.string().min(1),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});

const turnSettledFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("turnSettled"),
  runId: z.string().min(1),
  outcome: z.enum(["completed", "aborted", "failed"]),
  error: sdkErrorSchema.nullable(),
});

const cancelResultFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("cancelResult"),
  runId: z.string().min(1),
  outcome: z.enum(["cancelled", "not_active", "failed"]),
  message: z.string().nullable(),
});

const fatalFrameSchema = z.object({
  v: versionSchema,
  type: z.literal("fatal"),
  code: z.string().min(1),
  message: z.string(),
});

export const cursorWorkerFrameSchema = z.union([
  readyFrameSchema,
  preflightFailedFrameSchema,
  attachResultFrameSchema,
  refIssuedFrameSchema,
  inputAcceptedFrameSchema,
  nativeEventFrameSchema,
  nativeEventRejectedFrameSchema,
  usageFrameSchema,
  turnSettledFrameSchema,
  cancelResultFrameSchema,
  fatalFrameSchema,
]);

export type CursorParentFrame = z.infer<typeof cursorParentFrameSchema>;
export type CursorWorkerFrame = z.infer<typeof cursorWorkerFrameSchema>;

export type FrameRejectionReason = "unsupported_version" | "invalid_frame";

export type FrameParseResult<TFrame> =
  | { ok: true; frame: TFrame }
  | { ok: false; reason: FrameRejectionReason; frameType: string | null };

const PARENT_FRAME_TYPES = new Set([
  "init",
  "credential",
  "attachAgent",
  "startTurn",
  "cancel",
  "shutdown",
]);

const WORKER_FRAME_TYPES = new Set([
  "ready",
  "preflightFailed",
  "attachResult",
  "refIssued",
  "inputAccepted",
  "nativeEvent",
  "nativeEventRejected",
  "usage",
  "turnSettled",
  "cancelResult",
  "fatal",
]);

/**
 * Only a known discriminant is echoed back on a rejection — an unrecognized
 * `type` could be arbitrary payload data, and rejections must stay bounded.
 */
function knownFrameType(
  value: object,
  known: ReadonlySet<string>,
): string | null {
  const type: unknown = Reflect.get(value, "type");
  return typeof type === "string" && known.has(type) ? type : null;
}

function parseFrame<TFrame>(
  schema: z.ZodType<TFrame>,
  known: ReadonlySet<string>,
  value: unknown,
): FrameParseResult<TFrame> {
  if (value === null || typeof value !== "object") {
    return { ok: false, reason: "invalid_frame", frameType: null };
  }
  const frameType = knownFrameType(value, known);
  if (Reflect.get(value, "v") !== CURSOR_IPC_CODEC_VERSION) {
    return { ok: false, reason: "unsupported_version", frameType };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_frame", frameType };
  }
  return { ok: true, frame: parsed.data };
}

export function parseParentFrame(
  value: unknown,
): FrameParseResult<CursorParentFrame> {
  return parseFrame(cursorParentFrameSchema, PARENT_FRAME_TYPES, value);
}

export function parseWorkerFrame(
  value: unknown,
): FrameParseResult<CursorWorkerFrame> {
  return parseFrame(cursorWorkerFrameSchema, WORKER_FRAME_TYPES, value);
}
