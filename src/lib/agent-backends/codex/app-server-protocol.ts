import { z } from "zod";

export const CODEX_APP_SERVER_VERSION = "0.156.0";
export const APP_SERVER_LIMITS = {
  recordBytes: 16 * 1024 * 1024,
  queuedBytes: 16 * 1024 * 1024,
  stderrBytes: 256 * 1024,
  requestTimeoutMs: 30_000,
  exitGraceMs: 5_000,
  termGraceMs: 2_000,
  killGraceMs: 2_000,
} as const;

export type AppServerId = string | number;
export interface AppServerRpcError {
  code: number;
  message: string;
  data?: unknown;
}
export type AppServerMessage =
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "server_request"; id: AppServerId; method: string; params: unknown }
  | { kind: "response"; id: AppServerId; result: unknown; error?: never }
  | {
      kind: "response";
      id: AppServerId;
      error: AppServerRpcError;
      result?: never;
    };
export interface AppServerFrame {
  /** Exact complete UTF-8 record, excluding its LF delimiter. */
  raw: string;
  byteLength: number;
  message: AppServerMessage;
}

/** A process CC launched that was still running when cleanup was checked. */
export interface SurvivingProcess {
  pid: number;
  /** Executable name only; arguments may carry secrets. */
  command: string;
}

export class AppServerTransportError extends Error {
  constructor(
    readonly code:
      | "protocol_error"
      | "record_limit"
      | "queue_limit"
      | "connection_closed"
      | "consumer_failed"
      | "cleanup_unverified",
    message: string,
    readonly evidence: {
      byteLength?: number;
      truncated?: boolean;
      /** Which cleanup check could not be verified. */
      stage?: string;
      survivors?: readonly SurvivingProcess[];
    } = {},
  ) {
    super(message);
    this.name = "AppServerTransportError";
  }
}

export class AppServerRequestError extends Error {
  constructor(
    message: string,
    readonly requestMayHaveBeenWritten: boolean,
    readonly rpcError?: AppServerRpcError,
  ) {
    super(message);
    this.name = "AppServerRequestError";
  }
}

const objectSchema = z.record(z.string(), z.unknown());
const idSchema = z.union([z.string(), z.number().int()]);
const rpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

function invalidFrame(
  byteLength: number,
  truncated = false,
): AppServerTransportError {
  return new AppServerTransportError(
    "protocol_error",
    "Invalid Codex app-server JSONL envelope",
    { byteLength, truncated },
  );
}

export function parseAppServerFrame(
  raw: string,
  byteLength: number,
): AppServerFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidFrame(byteLength);
  }
  const parsed = objectSchema.safeParse(value);
  if (!parsed.success) throw invalidFrame(byteLength);
  const envelope = parsed.data;
  const hasId = Object.hasOwn(envelope, "id");
  const id = idSchema.safeParse(envelope.id);
  if (hasId && !id.success) throw invalidFrame(byteLength);
  const hasResult = Object.hasOwn(envelope, "result");
  const hasError = Object.hasOwn(envelope, "error");
  if (Object.hasOwn(envelope, "method")) {
    if (
      typeof envelope.method !== "string" ||
      !envelope.method ||
      hasResult ||
      hasError
    )
      throw invalidFrame(byteLength);
    return {
      raw,
      byteLength,
      message: id.success
        ? {
            kind: "server_request",
            id: id.data,
            method: envelope.method,
            params: envelope.params,
          }
        : {
            kind: "notification",
            method: envelope.method,
            params: envelope.params,
          },
    };
  }
  if (!id.success || hasResult === hasError) throw invalidFrame(byteLength);
  if (hasError) {
    const error = rpcErrorSchema.safeParse(envelope.error);
    if (!error.success) throw invalidFrame(byteLength);
    return {
      raw,
      byteLength,
      message: { kind: "response", id: id.data, error: error.data },
    };
  }
  return {
    raw,
    byteLength,
    message: { kind: "response", id: id.data, result: envelope.result },
  };
}

/** Byte framing avoids readline's Unicode separators and decoder replacement bytes. */
export class AppServerRecordDecoder {
  private buffer = Buffer.alloc(0);
  private length = 0;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  constructor(
    private readonly receive: (frame: AppServerFrame) => void,
    private readonly maxBytes: number = APP_SERVER_LIMITS.recordBytes,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      const byteLength = this.length + end - start;
      if (byteLength > this.maxBytes) {
        this.discard();
        throw new AppServerTransportError(
          "record_limit",
          "Codex app-server record exceeded its byte budget",
          { byteLength, truncated: true },
        );
      }
      // A geometric byte buffer bounds allocation metadata even for one-byte chunks.
      if (byteLength > this.buffer.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(
            this.maxBytes,
            Math.max(byteLength, this.buffer.length * 2, 4096),
          ),
        );
        this.buffer.copy(grown, 0, 0, this.length);
        this.buffer = grown;
      }
      chunk.copy(this.buffer, this.length, start, end);
      this.length = byteLength;
      if (newline < 0) return;
      let raw: string;
      try {
        raw = this.utf8.decode(this.buffer.subarray(0, this.length));
      } catch {
        this.discard();
        throw invalidFrame(byteLength);
      }
      this.length = 0;
      this.receive(parseAppServerFrame(raw, byteLength));
      start = newline + 1;
    }
  }

  finish(): void {
    const remaining = this.length;
    this.discard();
    if (remaining) throw invalidFrame(remaining, true);
  }

  discard(): void {
    this.buffer = Buffer.alloc(0);
    this.length = 0;
  }
}
