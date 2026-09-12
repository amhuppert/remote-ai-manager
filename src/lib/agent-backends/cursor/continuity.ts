import { createLogger } from "@/lib/logging";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { decodeCursorTaskRef } from "./task-ref";
import { CURSOR_ATTACH_TIMEOUT_MS } from "./worker/bounds";
import type { BackendModelSelection } from "../schemas";
import {
  assertRefOwnedBy,
  ContinuityForkError,
  type BackendContinuityAdapter,
  type ContinuityContext,
  type ContinuityValidation,
} from "../continuity";
import { CURSOR_BACKEND_ID } from "./backend-id";
import type { CursorWorkerMcpServer } from "./worker/entry";
import type { CursorWorkerFrame } from "./worker/ipc";
import type {
  CursorWorkerSession,
  CursorWorkerStartResult,
  CursorWorkerTransport,
  CursorWorkerCloseOutcome,
} from "./worker-port";

/**
 * Cursor continuity (spec D8, D12, R6).
 *
 * Unlike Claude and Codex — whose `start` mints a placeholder because their
 * real handle only exists after the first turn — a Cursor agent id is a real,
 * probeable handle the SDK issues at `Agent.create`. So `start` creates one
 * through a worker and every later operation is an honest probe rather than an
 * assumption, which is what lets `continuationStrength: "precise_session"` be
 * a claim instead of a hope.
 *
 * A ref is meaningful only against the Command Center-owned cwd and the
 * caller-owned store it was minted under, so every operation binds both before
 * touching the transport. Invalid refs fail CLOSED: they surface their bounded
 * classification and never silently attach to some other conversation.
 */

const logger = createLogger("cursor:continuity");

/**
 * Stable, bounded verdicts about a ref. Deliberately small: each one names a
 * different remedy, and none of them leaks an SDK message.
 */
export type CursorRefClassification =
  /** The SDK has no such agent: a random, deleted, stale, or cross-store ref. */
  | "not_found"
  /** The handle is not a well-formed opaque ref; no worker was started. */
  | "corrupt"
  /** The agent exists but a live run holds it. */
  | "already_active"
  /** The provider rejected the resume configuration. */
  | "rejected"
  /** Authentication, transport, or worker trouble — no verdict about the ref. */
  | "unavailable";

/** The cwd, store, and complete model selection a continuity ref is bound to. */
export interface CursorContinuityBinding {
  /** Worker slot this probe runs under; distinct per continuity identity. */
  conversationId: string;
  /** The Command Center-owned worktree the ref is bound to. */
  cwd: string;
  /** The caller-owned SDK agent store the ref is bound to. */
  storePath: string;
  modelSelection: BackendModelSelection;
  mcpServers: Record<string, CursorWorkerMcpServer>;
}

export interface CursorContinuityDeps {
  attachTimeoutMs?: number;
  transport: CursorWorkerTransport;
  resolveBinding(
    input: ContinuityContext,
    ref?: AgentSessionRef,
  ): Promise<CursorContinuityBinding>;
  buildSyntheticForkSeed?(
    transcriptPath: string,
    messageIndex: number,
  ): Promise<string | null>;
}

/** A ref operation that reached a bounded verdict rather than succeeding. */
export class CursorContinuityError extends Error {
  readonly classification: CursorRefClassification;

  constructor(classification: CursorRefClassification, message: string) {
    super(message);
    this.name = "CursorContinuityError";
    this.classification = classification;
  }
}

/**
 * The longest handle worth spawning a process for. An opaque ref is not
 * parsed — Command Center does not know the provider's id format and will not
 * invent one — but a value that cannot be any handle is refused before a
 * worker starts, so a corrupt row costs nothing.
 */
const MAX_REF_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function classifyRefShape(ref: string): CursorRefClassification | null {
  if (ref.trim().length === 0) return "corrupt";
  if (ref.length > MAX_REF_LENGTH) return "corrupt";
  if (CONTROL_CHARACTERS.test(ref)) return "corrupt";
  return null;
}

function providerHandle(ref: AgentSessionRef): string {
  if (!ref.ref.startsWith("{")) return ref.ref;
  try {
    return decodeCursorTaskRef(ref).agentId ?? "";
  } catch {
    return "";
  }
}

/**
 * Maps the SDK's stable error seams onto the bounded vocabulary. Reads name,
 * code, and status rather than instances: class identity does not survive the
 * worker's process boundary.
 */
function classifyAttachError(
  error: {
    name: string | null;
    code: string | null;
    status: number | null;
  } | null,
): CursorRefClassification {
  if (error === null) return "unavailable";
  if (
    error.name === "AgentNotFoundError" ||
    error.name === "UnknownAgentError" ||
    error.code === "agent_not_found" ||
    error.status === 404
  ) {
    return "not_found";
  }
  if (
    error.name === "AgentBusyError" ||
    error.code === "agent_busy" ||
    error.status === 409
  ) {
    return "already_active";
  }
  if (error.name === "ConfigurationError" || error.status === 400) {
    return "rejected";
  }
  return "unavailable";
}

type AttachProbe =
  | { ok: true; ref: string }
  | { ok: false; classification: CursorRefClassification; message: string };

function startFailureMessage(
  result: Exclude<
    CursorWorkerStartResult,
    { kind: "ready" | "already_active" }
  >,
): string {
  switch (result.kind) {
    case "spawn_failed":
    case "binding_mismatch":
      return result.message;
    case "runtime_preflight_failed":
    case "preflight_failed":
      return `Cursor preflight failed before the ref could be probed: ${result.message}`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/**
 * Runs one attach in a worker of its own and tears it down before returning.
 * The worker is closed in a `finally`, so no classification path — including
 * the ones that throw — can leave a process behind.
 */
async function probeAttach(
  deps: CursorContinuityDeps,
  binding: CursorContinuityBinding,
  ref: string | null,
  recoverAbandonedRun = false,
): Promise<AttachProbe> {
  if (deps.transport.find(binding.conversationId)) {
    return {
      ok: false,
      classification: "already_active",
      message: "A live Cursor worker owns this conversation",
    };
  }
  let settle: ((probe: AttachProbe) => void) | null = null;
  const settlement = new Promise<AttachProbe>((resolve) => {
    settle = resolve;
  });
  const resolveOnce = (probe: AttachProbe): void => {
    const pending = settle;
    settle = null;
    pending?.(probe);
  };

  const started = await deps.transport.start({
    conversationId: binding.conversationId,
    target: null,
    cwd: binding.cwd,
    storePath: binding.storePath,
    modelSelection: binding.modelSelection,
    ownerToken: {},
    onFrame: (frame: CursorWorkerFrame) => {
      if (frame.type !== "attachResult") return;
      if (frame.outcome === "attached" && frame.ref !== null) {
        resolveOnce({ ok: true, ref: frame.ref });
        return;
      }
      resolveOnce({
        ok: false,
        classification: classifyAttachError(frame.error),
        message: frame.error?.message ?? "the Cursor agent could not attach",
      });
    },
    onExit: () => {
      resolveOnce({
        ok: false,
        classification: "unavailable",
        message: "the Cursor worker exited before its agent attached",
      });
    },
  });

  if (started.kind !== "ready" && started.kind !== "already_active") {
    return {
      ok: false,
      classification: "unavailable",
      message: startFailureMessage(started),
    };
  }

  const session: CursorWorkerSession = started.session;
  const timer = setTimeout(
    () =>
      resolveOnce({
        ok: false,
        classification: "unavailable",
        message: "Cursor continuity attachment timed out",
      }),
    deps.attachTimeoutMs ?? CURSOR_ATTACH_TIMEOUT_MS,
  );
  timer.unref?.();
  let probe: AttachProbe;
  let cleanup: CursorWorkerCloseOutcome;
  try {
    session.attach({
      mode: ref === null ? "create" : "resume",
      ref,
      modelSelection: binding.modelSelection,
      mcpServers: binding.mcpServers,
      recoverAbandonedRun,
    });
    probe = await settlement;
  } finally {
    clearTimeout(timer);
    cleanup = await session.close();
  }
  if (cleanup.kind === "cleanup_failed")
    return {
      ok: false,
      classification: "unavailable",
      message: "Cursor continuity worker cleanup could not be verified",
    };
  return probe;
}

/**
 * Whether a busy agent may be force-expired (D12). Recovery is admitted ONLY
 * when the active-worker registry proves no live local worker owns the ref:
 * expiring a run another live worker genuinely owns would steal a session
 * mid-turn. The worker doing the asking is not a competitor — a wedged
 * persisted run from a crashed predecessor is exactly the case the SDK's
 * option exists for — so it is excluded by id rather than by assumption.
 */
export function mayForceExpire(
  transport: CursorWorkerTransport,
  conversationId: string,
  askingWorkerId?: string,
): boolean {
  const live = transport.find(conversationId);
  return live === null || live.workerId === askingWorkerId;
}

export function createCursorContinuityAdapter(
  deps: CursorContinuityDeps,
): BackendContinuityAdapter {
  return {
    backend: CURSOR_BACKEND_ID,

    async start(input) {
      const binding = await deps.resolveBinding(input);
      const probe = await probeAttach(deps, binding, null);
      if (!probe.ok) {
        throw new CursorContinuityError(probe.classification, probe.message);
      }
      logger.info("continuity.start", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      return {
        backend: CURSOR_BACKEND_ID,
        ref: probe.ref,
      } satisfies AgentSessionRef;
    },

    async validate(ref, input): Promise<ContinuityValidation> {
      assertRefOwnedBy(CURSOR_BACKEND_ID, ref);
      const providerRef = providerHandle(ref);
      const shape = classifyRefShape(providerRef);
      if (shape !== null) {
        return { status: "stale", reason: `cursor_ref_${shape}` };
      }

      const binding = await deps.resolveBinding(input, ref);
      const probe = await probeAttach(deps, binding, providerRef);
      if (probe.ok) return { status: "valid" };

      logger.info("continuity.validate.rejected", {
        projectPath: input.projectPath,
        classification: probe.classification,
      });
      return {
        status: "stale",
        reason: `cursor_ref_${probe.classification}`,
      };
    },

    /**
     * Resumes, or fails closed. A ref the provider will not honour is never
     * silently replaced with a fresh session: the caller has to see the
     * classification, because "your context is gone" and "try again in a
     * moment" call for different responses and a new handle hides both.
     */
    async resumeOrRecover(ref, input) {
      assertRefOwnedBy(CURSOR_BACKEND_ID, ref);
      const providerRef = providerHandle(ref);
      const shape = classifyRefShape(providerRef);
      if (shape !== null) {
        throw new CursorContinuityError(
          shape,
          "The persisted Cursor ref is not a well-formed handle",
        );
      }

      const binding = await deps.resolveBinding(input, ref);
      const probe = await probeAttach(deps, binding, providerRef, true);
      if (!probe.ok) {
        logger.warn("continuity.resume.failed", {
          projectPath: input.projectPath,
          classification: probe.classification,
        });
        throw new CursorContinuityError(probe.classification, probe.message);
      }
      return { ref, recovered: false };
    },

    /** History is portable text; the target creates its own agent on first use. */
    async fork(ref, input) {
      assertRefOwnedBy(CURSOR_BACKEND_ID, ref);
      const buildSeed =
        deps.buildSyntheticForkSeed ??
        (await import("@/lib/sessions/synthetic-fork-seed"))
          .buildSyntheticForkSeed;
      const seed = await buildSeed(
        input.sourceTranscriptPath,
        input.messageIndex,
      );
      if (!seed) {
        throw new ContinuityForkError(
          CURSOR_BACKEND_ID,
          "Fork creation failed: the synthetic seed could not be built from the local transcript",
        );
      }
      logger.info("continuity.fork.synthetic", {
        projectPath: input.projectPath,
        messageIndex: input.messageIndex,
        seedLength: seed.length,
      });
      return { kind: "synthetic_seed", seed };
    },
  };
}
