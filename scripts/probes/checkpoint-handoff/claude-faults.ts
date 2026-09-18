import type { ClaudeSdkQueryPort } from "@/lib/agent-backends/claude/query-session";
import type { CaptureHandoffResult } from "@/lib/agent-backends/schemas";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { writeFileSync } from "node:fs";
import {
  injectClaudeTerminalOverflow,
  type TerminalOverflowMarker,
} from "./claude-terminal-overflow";
import {
  observeOwnedClaudeSpawn,
  type OwnedClaudeProcess,
  type OwnedClaudeProcessEvidence,
} from "./claude-owned-process";

export function rejectArmedHookSuppression(
  original: ClaudeSdkQueryPort["applyFlagSettings"],
  armed: () => boolean,
  onRejected: () => Promise<void>,
): ClaudeSdkQueryPort["applyFlagSettings"] {
  return async (settings) => {
    if (armed() && settings?.disableAllHooks === true) {
      await onRejected();
      throw new Error(
        "explicit probe injection: hook suppression rejected before SDK dispatch",
      );
    }
    await original(settings);
  };
}

export type ClaudeFaultKind =
  | "setup-control-rejection"
  | "provider-interruption"
  | "execution-limit"
  | "output-limit-injected";
export interface ClaudeFaultEvidence {
  fault: ClaudeFaultKind;
  boundary: "real-sdk-query-with-explicit-probe-fault";
  events: {
    event: string;
    queryId: string;
    at: string;
    sourceRefDigest?: string;
  }[];
  processes: OwnedClaudeProcessEvidence[];
  captures: {
    submitted: boolean;
    modeEstablished: boolean;
    executionSettled: boolean;
    omissionReason: string | null;
    sourceCloseCountAtReturn: number;
    sourceExitObservedAtReturn: boolean;
  }[];
  interruptSent: boolean;
  executionSuspended: boolean;
  resumeSent: boolean;
  cleanupObserved: boolean | null;
  terminalOverflow:
    | (TerminalOverflowMarker & {
        originalFramePath: string;
        originalFrameBytes: number;
        originalFrameSha256: string;
        forwardedFrameBytes: number;
        forwardedFrameSha256: string;
      })
    | null;
}

/** Wraps real SDK execution; every injected boundary fault is explicitly marked. */
export async function installClaudeFaultFixture(input: {
  directory: string;
  fault: ClaudeFaultKind;
}) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { _setSdkQueryForTesting } =
    await import("@/lib/agent-backends/claude/query-session");
  const {
    listBackends,
    _resetBackendRegistryForTesting,
    _registerBackendForTesting,
  } = await import("@/lib/agent-backends/registry-core");
  let armed = false;
  let rejected = false;
  let interrupted = false;
  let sourceQueryId: string | null = null;
  let captureDeadline: number | null = null;
  let captureOutputLimit: number | null = null;
  const resumeTimers = new Set<ReturnType<typeof setTimeout>>();
  const resuming = new Set<Promise<void>>();
  const children: OwnedClaudeProcess[] = [];
  const closed = new Map<string, number>();
  const evidence: ClaudeFaultEvidence = {
    fault: input.fault,
    boundary: "real-sdk-query-with-explicit-probe-fault",
    events: [],
    processes: [],
    captures: [],
    interruptSent: false,
    executionSuspended: false,
    resumeSent: false,
    cleanupObserved: null,
    terminalOverflow: null,
  };
  const note = (event: string, queryId: string, sourceRefDigest?: string) =>
    evidence.events.push({
      event,
      queryId,
      at: new Date().toISOString(),
      ...(sourceRefDigest ? { sourceRefDigest } : {}),
    });

  _setSdkQueryForTesting((args) => {
    const queryId = randomUUID();
    const kind =
      Array.isArray(args.options.tools) && args.options.tools.length === 0
        ? ("capture" as const)
        : ("ordinary" as const);
    if (kind === "ordinary" && sourceQueryId === null) sourceQueryId = queryId;
    const spawn = args.options.spawnClaudeCodeProcess;
    if (!spawn) throw new Error("production owned spawn callback unavailable");
    let owned: OwnedClaudeProcess | undefined;
    const real = query({
      ...args,
      options: {
        ...args.options,
        spawnClaudeCodeProcess: observeOwnedClaudeSpawn(
          path.join(input.directory, "owned-pids"),
          queryId,
          kind,
          spawn,
          (child) => {
            owned = child;
            children.push(child);
          },
        ),
      },
    });
    note(`real-${kind}-query-created`, queryId);
    const port: ClaudeSdkQueryPort = {
      async *[Symbol.asyncIterator]() {
        for await (const message of real) {
          if (message.type === "system" && message.subtype === "init") {
            note(
              "native-init",
              queryId,
              createHash("sha256").update(message.session_id).digest("hex"),
            );
            if (owned) await owned.observeIdentity();
            if (
              kind === "capture" &&
              armed &&
              input.fault === "provider-interruption" &&
              !interrupted
            ) {
              interrupted = true;
              if (!owned)
                throw new Error("capture child ownership was not observed");
              evidence.interruptSent = await owned.signal("SIGTERM");
              note("owned-capture-interrupt", queryId);
            }
            if (
              kind === "capture" &&
              armed &&
              input.fault === "execution-limit" &&
              !evidence.executionSuspended
            ) {
              if (!owned || captureDeadline === null)
                throw new Error(
                  "capture deadline or child ownership was not observed",
                );
              const captureChild = owned;
              evidence.executionSuspended =
                await captureChild.signal("SIGSTOP");
              note("owned-capture-suspended", queryId);
              // Resume one second after the unchanged deadline, inside the
              // shipped settlement grace, so pending SDK termination can run.
              const timer = setTimeout(
                () => {
                  resumeTimers.delete(timer);
                  const pending = captureChild
                    .signal("SIGCONT")
                    .then((sent) => {
                      evidence.resumeSent = sent;
                      note("owned-capture-resumed", queryId);
                    })
                    .catch(() => {
                      note("owned-capture-resume-failed", queryId);
                    });
                  resuming.add(pending);
                  void pending.finally(() => resuming.delete(pending));
                },
                Math.max(1, captureDeadline + 1000 - Date.now()),
              );
              resumeTimers.add(timer);
            }
          }
          if (
            input.fault === "output-limit-injected" &&
            captureOutputLimit !== null &&
            evidence.terminalOverflow === null
          ) {
            const transformed = injectClaudeTerminalOverflow(message, {
              capture: kind === "capture",
              armed,
              limitBytes: captureOutputLimit,
            });
            if (transformed.marker && transformed.originalFrameJson !== null) {
              const originalFramePath = path.join(
                input.directory,
                `original-capture-result-${queryId}.json`,
              );
              writeFileSync(originalFramePath, transformed.originalFrameJson, {
                mode: 0o600,
                flag: "wx",
              });
              const forwardedFrame = `${JSON.stringify(transformed.message)}\n`;
              evidence.terminalOverflow = {
                ...transformed.marker,
                originalFramePath,
                originalFrameBytes: Buffer.byteLength(
                  transformed.originalFrameJson,
                  "utf8",
                ),
                originalFrameSha256: createHash("sha256")
                  .update(transformed.originalFrameJson)
                  .digest("hex"),
                forwardedFrameBytes: Buffer.byteLength(forwardedFrame, "utf8"),
                forwardedFrameSha256: createHash("sha256")
                  .update(forwardedFrame)
                  .digest("hex"),
              };
              note(
                "injected-terminal-whitespace-overflow-after-real-success",
                queryId,
              );
              yield transformed.message;
              continue;
            }
          }
          yield message;
        }
      },
      close() {
        closed.set(queryId, (closed.get(queryId) ?? 0) + 1);
        note("query-close-requested", queryId);
        real.close();
      },
      supportedCommands: () => real.supportedCommands(),
      supportedAgents: () => real.supportedAgents(),
      mcpServerStatus: () => real.mcpServerStatus(),
      reloadPlugins: () => real.reloadPlugins(),
      applyFlagSettings: rejectArmedHookSuppression(
        real.applyFlagSettings.bind(real),
        () => armed && input.fault === "setup-control-rejection" && !rejected,
        async () => {
          rejected = true;
          sourceQueryId = queryId;
          if (!owned || !(await owned.observeIdentity()))
            throw new Error("source child ownership was not observed");
          note("injected-suppression-rejection-before-dispatch", queryId);
        },
      ),
    };
    return port;
  });

  const descriptors = [...listBackends()];
  _resetBackendRegistryForTesting();
  for (const descriptor of descriptors) {
    if (descriptor.id !== "claude" || !descriptor.conversation) {
      _registerBackendForTesting(descriptor);
      continue;
    }
    const conversation = descriptor.conversation;
    const factory = conversation.factory;
    _registerBackendForTesting({
      ...descriptor,
      conversation: {
        ...conversation,
        factory: {
          ...factory,
          async createRuntime(options) {
            const runtime = await factory.createRuntime(options);
            const capture = runtime.captureHandoff?.bind(runtime);
            if (capture)
              runtime.captureHandoff = async (request) => {
                captureDeadline = Date.now() + request.limits.executionMs;
                captureOutputLimit = request.limits.outputBytes;
                const result: CaptureHandoffResult = await capture(request);
                const sourceChild = children.find(
                  (child) => child.snapshot().queryId === sourceQueryId,
                );
                evidence.captures.push({
                  submitted: result.submitted,
                  modeEstablished: result.modeEstablished,
                  executionSettled: result.executionSettled,
                  omissionReason: result.omissionReason,
                  sourceCloseCountAtReturn: sourceQueryId
                    ? (closed.get(sourceQueryId) ?? 0)
                    : 0,
                  sourceExitObservedAtReturn:
                    sourceChild?.snapshot().sdkExitObserved ?? false,
                });
                armed = false;
                return result;
              };
            return runtime;
          },
        },
      },
    });
  }
  return {
    arm() {
      armed = true;
    },
    evidence(): ClaudeFaultEvidence {
      return structuredClone({
        ...evidence,
        processes: children.map((child) => child.snapshot()),
      });
    },
    async restoreAndCollect(): Promise<boolean> {
      let collected = true;
      try {
        for (const timer of resumeTimers) clearTimeout(timer);
        resumeTimers.clear();
        await Promise.all(resuming);
        for (const child of children) {
          if (await child.waitForExit(1000)) continue;
          if (
            child
              .snapshot()
              .signals.some((entry) => entry.signal === "SIGSTOP" && entry.sent)
          )
            await child.signal("SIGCONT");
          await child.signal("SIGTERM");
          if (!(await child.waitForExit(5000))) {
            await child.signal("SIGKILL");
            if (!(await child.waitForExit(5000))) collected = false;
          }
        }
      } catch {
        collected = false;
      } finally {
        evidence.cleanupObserved = collected;
        _setSdkQueryForTesting(null);
        _resetBackendRegistryForTesting();
        for (const descriptor of descriptors)
          _registerBackendForTesting(descriptor);
      }
      return collected;
    },
  };
}
