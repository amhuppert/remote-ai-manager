import type { ControlPermits } from "@/lib/control/permits";
import type { Executor, OperationState } from "@/lib/intents/executor";
import type { OwnerRef, PendingIntent } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { WorkspaceRepo } from "@/lib/state-store/workspace-repo";
import type { Grant, GrantRequest, WorkspaceAdmission } from "./admission";
import type { WorkspaceEvidence } from "./evidence";
import {
  workspaceOperationSchema,
  type WorkspaceBindingRecord,
  type WorkspaceBindingRequest,
  type WorkspaceOperation,
  type WorkspaceOperationRecord,
  type WorkspaceScope,
} from "./schemas";

export type CheckRunResult = {
  status: "passed" | "failed" | "unavailable";
  detail?: string;
};

export interface WorkspaceExecutorDeps {
  transaction<T>(fn: () => T): T;
  repo: WorkspaceRepo;
  permits: ControlPermits;
  admission: WorkspaceAdmission;
  evidence: WorkspaceEvidence;
  /** Runs one registered validation command against the binding's worktree. */
  runCheck(input: {
    binding: WorkspaceBindingRequest;
    bindingId: string;
    command: string;
    /** Aborts when the requester interrupts the operation, e.g. on cancel. */
    signal: AbortSignal;
  }): Promise<CheckRunResult>;
  touchRequester(owner: OwnerRef): void;
  now(): string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Executes Workspace operations for session placement: binding admission,
 * content capture, acceptance checks as readers, and acceptance by comparison.
 * Operations on one binding run one at a time, each under a grant from the
 * shared admission, and only while the requester's permit admits them.
 */
export interface WorkspaceExecutor extends Executor {
  releaseBinding(bindingId: string): void;
  /** Boot: session operations only read, so one interrupted mid-run runs again. */
  recover(): void;
  /** Runs every admissible queued operation; resolves when none is left to start. */
  drain(): Promise<void>;
}

function scopesOverlap(a: WorkspaceScope, b: WorkspaceScope): boolean {
  if (a.mode === "readOnly" || b.mode === "readOnly") return false;
  if (a.mode === "full" || b.mode === "full") return true;
  return a.paths.some((left) =>
    b.paths.some(
      (right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`),
    ),
  );
}

function scopePaths(scope: WorkspaceScope): string[] | undefined {
  return scope.mode === "owned" ? scope.paths : undefined;
}

export function createWorkspaceExecutor(deps: WorkspaceExecutorDeps): WorkspaceExecutor {
  const runningBindings = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();

  function settle(record: WorkspaceOperationRecord, outcome: unknown): void {
    deps.transaction(() =>
      deps.repo.updateOperation(record.cause, { state: "settled", outcome, updatedAt: deps.now() }),
    );
    deps.touchRequester(record.requester);
  }

  function bindingOf(bindingId: string): WorkspaceBindingRecord {
    const binding = deps.repo.getBinding(bindingId);
    if (binding === null) throw new Error(`Unknown workspace binding ${bindingId}`);
    return binding;
  }

  async function withGrant<T>(request: GrantRequest, work: () => Promise<T>): Promise<T> {
    const grant: Grant = await deps.admission.acquire(request);
    try {
      return await work();
    } finally {
      deps.admission.release(grant);
    }
  }

  function bindAdmissible(operation: Extract<WorkspaceOperation, { kind: "bind" }>): boolean {
    const others = deps.repo
      .listBindings(operation.binding.worktreePath, "bound")
      .filter((b) => b.bindingId !== operation.bindingId);
    return !others.some((other) => scopesOverlap(other.request.scope, operation.binding.scope));
  }

  async function perform(
    record: WorkspaceOperationRecord,
    operation: WorkspaceOperation,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (operation.kind === "bind") {
      const baseline = await deps.evidence.capture(
        operation.binding.worktreePath,
        operation.binding.scope,
      );
      deps.transaction(() =>
        deps.repo.setBindingState(operation.bindingId, { state: "bound", baseline, updatedAt: deps.now() }),
      );
      return { kind: "bound" };
    }
    const binding = bindingOf(operation.bindingId).request;
    const stableRead: GrantRequest = {
      worktree: binding.worktreePath,
      kind: "stable_read",
      ...(scopePaths(binding.scope) !== undefined ? { paths: scopePaths(binding.scope) } : {}),
      holder: record.cause,
    };
    switch (operation.kind) {
      case "freeze":
        return withGrant(stableRead, async () => ({
          kind: "frozen",
          evidence: await deps.evidence.capture(binding.worktreePath, binding.scope),
        }));
      case "verify":
        return withGrant(stableRead, async () => {
          const current = await deps.evidence.capture(binding.worktreePath, binding.scope);
          return { kind: "verified", changed: !deps.evidence.sameContent(current, operation.evidence) };
        });
      case "accept":
        // Session placement accepts in place: the receipt names the exact content.
        return withGrant(stableRead, async () => {
          const current = await deps.evidence.capture(binding.worktreePath, binding.scope);
          return deps.evidence.sameContent(current, operation.evidence)
            ? { kind: "accepted", receipt: `snapshot:${current}` }
            : { kind: "candidate_changed" };
        });
      case "check":
        // Checks read the whole tree, so they exclude every supervised writer.
        return withGrant({ ...stableRead, paths: undefined }, async () => {
          const before = await deps.evidence.capture(binding.worktreePath, binding.scope);
          const result = await deps.runCheck({
            binding,
            bindingId: operation.bindingId,
            command: operation.command,
            signal,
          });
          const after = await deps.evidence.capture(binding.worktreePath, binding.scope);
          const wrote = deps.evidence.sameContent(before, after)
            ? []
            : await deps.evidence.changedPaths(binding.worktreePath, binding.scope, before, after);
          return {
            kind: "checked",
            status: result.status,
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
            wroteReviewedScope: wrote,
          };
        });
    }
  }

  async function execute(record: WorkspaceOperationRecord, operation: WorkspaceOperation): Promise<void> {
    const controller = new AbortController();
    controllers.set(record.cause, controller);
    try {
      const outcome = await perform(record, operation, controller.signal);
      settle(record, outcome);
    } catch (error) {
      deps.log.error("workspace.operation_failed", {
        cause: record.cause,
        kind: operation.kind,
        error: getErrorMessage(error),
      });
      settle(record, { kind: "refused", detail: getErrorMessage(error) });
    } finally {
      controllers.delete(record.cause);
      runningBindings.delete(record.bindingId);
    }
  }

  /** Admits one queued operation if its permit, binding and scope allow it now. */
  function tryStart(record: WorkspaceOperationRecord): boolean {
    if (runningBindings.has(record.bindingId)) return false;
    const operation = workspaceOperationSchema.parse(record.request);
    if (operation.kind === "bind" && !bindAdmissible(operation)) return false;
    const admitted = deps.transaction(() => {
      // Admission and its permit check happen together, at the moment of admission.
      if (!deps.permits.admits(record.permit)) return false;
      deps.repo.updateOperation(record.cause, { state: "running", updatedAt: deps.now() });
      return true;
    });
    if (!admitted) return false;
    runningBindings.add(record.bindingId);
    const run = execute(record, operation).finally(() => inFlight.delete(run));
    inFlight.add(run);
    return true;
  }

  const executor: WorkspaceExecutor = {
    submit(intent: PendingIntent) {
      const operation = workspaceOperationSchema.parse(intent.request);
      deps.transaction(() => {
        const existing = deps.repo.getOperation(intent.cause);
        if (existing !== null) {
          // A resubmission refreshes the permit of an operation not yet admitted.
          if (existing.state === "queued") {
            deps.repo.updateOperation(intent.cause, { permit: intent.permit, updatedAt: deps.now() });
          }
          return;
        }
        if (operation.kind === "bind") {
          deps.repo.insertBindingIfAbsent({
            bindingId: operation.bindingId,
            request: operation.binding,
            state: "waiting",
            baseline: null,
            createdAt: deps.now(),
            updatedAt: deps.now(),
          });
        }
        deps.repo.insertOperationIfAbsent({
          cause: intent.cause,
          bindingId: operation.bindingId,
          requester: intent.requester,
          request: intent.request,
          permit: intent.permit,
          state: "queued",
          outcome: null,
          createdAt: deps.now(),
          updatedAt: deps.now(),
        });
      });
      void executor.drain();
    },
    outcome(cause): OperationState {
      const record = deps.repo.getOperation(cause);
      if (record === null) return { kind: "unknown" };
      switch (record.state) {
        case "queued":
          return { kind: "queued" };
        case "running":
          return { kind: "running" };
        case "settled":
          return { kind: "settled", outcome: record.outcome };
        case "uncertain":
          return { kind: "uncertain", evidence: JSON.stringify(record.outcome) };
      }
    },
    withdraw(cause) {
      deps.transaction(() => {
        const record = deps.repo.getOperation(cause);
        if (record?.state === "queued") deps.repo.deleteOperation(cause);
      });
    },
    interrupt(cause) {
      controllers.get(cause)?.abort();
    },
    releaseBinding(bindingId) {
      deps.transaction(() => {
        const binding = deps.repo.getBinding(bindingId);
        if (binding === null || binding.state === "released") return;
        deps.repo.setBindingState(bindingId, {
          state: "released",
          baseline: binding.baseline,
          updatedAt: deps.now(),
        });
      });
      // Start waiting bindings only after a caller's enclosing transaction commits.
      setImmediate(() => void executor.drain());
    },
    recover() {
      deps.transaction(() => {
        for (const record of deps.repo.listOperations("running")) {
          deps.repo.updateOperation(record.cause, { state: "queued", updatedAt: deps.now() });
        }
      });
    },
    async drain() {
      for (;;) {
        let started = false;
        for (const record of deps.repo.listOperations("queued")) {
          if (tryStart(record)) started = true;
        }
        if (inFlight.size === 0) return;
        await Promise.race(inFlight);
        if (!started && inFlight.size === 0) return;
      }
    },
  };
  return executor;
}
