"use client";

import type { QueryClient } from "@tanstack/react-query";

import type { QuickTicketClientError } from "@/lib/tickets/schemas";

type ClientErrorKind = QuickTicketClientError["kind"];

export interface ClientErrorRingBuffer {
  capture(kind: ClientErrorKind, value: unknown, capturedAt?: Date): void;
  read(): QuickTicketClientError[];
}

interface CaptureInstallation {
  buffer: ClientErrorRingBuffer;
  originalConsoleError: typeof console.error;
  removeWindowError(): void;
  removeUnhandledRejection(): void;
  unsubscribeQueryCache(): void;
}

const CAPTURE_STATE_KEY = Symbol.for("command-center.client-error-capture");
const MAX_MESSAGE_LENGTH = 500;
const MAX_STACK_LINES = 3;
const AUTHORIZATION_HEADER =
  /\b(Authorization\s*:\s*)(Basic|Bearer)\s+[^\s,;'"`]+/gi;
const COOKIE_HEADER =
  /\b(Cookie\s*:\s*)((?:[^=;\s]+=[^;,\s]+)(?:\s*;\s*[^=;\s]+=[^;,\s]+)*)/gi;
const COOKIE_PAIR = /([^=;\s]+)(\s*=\s*)([^;,\s]+)/g;
const CREDENTIAL_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|token|session(?:[_-]?(?:id|token))?)(["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;}]+))/gi;

type CaptureGlobal = typeof globalThis & {
  [CAPTURE_STATE_KEY]?: CaptureInstallation;
};

function redactCredentialAssignments(value: string): string {
  return value.replace(
    CREDENTIAL_ASSIGNMENT,
    (
      _match,
      key: string,
      separator: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
    ) => {
      if (doubleQuoted !== undefined) {
        return `${key}${separator}"[redacted]"`;
      }
      if (singleQuoted !== undefined) {
        return `${key}${separator}'[redacted]'`;
      }
      return `${key}${separator}[redacted]`;
    },
  );
}

function redactCookieHeaders(value: string): string {
  return value.replace(
    COOKIE_HEADER,
    (_match, prefix: string, cookies: string) =>
      `${prefix}${cookies.replace(COOKIE_PAIR, "$1$2[redacted]")}`,
  );
}

function sanitizeText(value: string): string {
  const withoutUrlSecrets = value.replace(
    /https?:\/\/[^\s)\]}>,"']+/gi,
    (candidate) => {
      try {
        const url = new URL(candidate);
        url.username = "";
        url.password = "";
        url.search = "";
        return url.toString().replace(/\/$/, "");
      } catch {
        return candidate.replace(/\?.*$/, "");
      }
    },
  );
  const withoutHeaderSecrets = redactCookieHeaders(withoutUrlSecrets).replace(
    AUTHORIZATION_HEADER,
    "$1$2 [redacted]",
  );
  return redactCredentialAssignments(withoutHeaderSecrets)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

export function sanitizeClientError(
  kind: ClientErrorKind,
  value: unknown,
  capturedAt = new Date(),
): QuickTicketClientError | null {
  if (typeof value !== "string" && !(value instanceof Error)) return null;

  const rawMessage = typeof value === "string" ? value : value.message;
  const message = sanitizeText(rawMessage.trim());
  if (message.length === 0) return null;

  const stackHead =
    value instanceof Error && typeof value.stack === "string"
      ? value.stack
          .split("\n")
          .slice(0, MAX_STACK_LINES)
          .map((line) => sanitizeText(line.trim()))
          .filter((line) => line.length > 0)
      : [];

  return {
    ts: capturedAt.toISOString(),
    kind,
    message,
    stackHead,
  };
}

export function createClientErrorRingBuffer(
  capacity = 25,
): ClientErrorRingBuffer {
  const entries: QuickTicketClientError[] = [];
  return {
    capture(kind, value, capturedAt = new Date()) {
      const sanitized = sanitizeClientError(kind, value, capturedAt);
      if (sanitized === null) return;
      entries.push(sanitized);
      if (entries.length > capacity) {
        entries.splice(0, entries.length - capacity);
      }
    },
    read() {
      return entries.map((entry) => ({
        ...entry,
        stackHead: [...entry.stackHead],
      }));
    },
  };
}

export function initializeClientErrorCapture(
  queryClient: QueryClient,
): ClientErrorRingBuffer {
  const captureGlobal = globalThis as CaptureGlobal;
  if (captureGlobal[CAPTURE_STATE_KEY] !== undefined) {
    return captureGlobal[CAPTURE_STATE_KEY].buffer;
  }

  const buffer = createClientErrorRingBuffer();
  const originalConsoleError = console.error;
  const onWindowError = (event: ErrorEvent) => {
    buffer.capture("window", event.error ?? event.message);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    buffer.capture("unhandledrejection", event.reason);
  };

  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  console.error = (...values: unknown[]) => {
    for (const value of values) buffer.capture("console", value);
    originalConsoleError(...values);
  };

  const unsubscribeQueryCache = queryClient
    .getQueryCache()
    .subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      buffer.capture("query", event.action.error);
    });

  captureGlobal[CAPTURE_STATE_KEY] = {
    buffer,
    originalConsoleError,
    removeWindowError: () => window.removeEventListener("error", onWindowError),
    removeUnhandledRejection: () =>
      window.removeEventListener("unhandledrejection", onUnhandledRejection),
    unsubscribeQueryCache,
  };
  return buffer;
}

export function readCapturedClientErrors(): QuickTicketClientError[] {
  return (globalThis as CaptureGlobal)[CAPTURE_STATE_KEY]?.buffer.read() ?? [];
}

export function resetClientErrorCaptureForTesting(): void {
  const captureGlobal = globalThis as CaptureGlobal;
  const installation = captureGlobal[CAPTURE_STATE_KEY];
  if (installation === undefined) return;
  installation.removeWindowError();
  installation.removeUnhandledRejection();
  installation.unsubscribeQueryCache();
  console.error = installation.originalConsoleError;
  delete captureGlobal[CAPTURE_STATE_KEY];
}
