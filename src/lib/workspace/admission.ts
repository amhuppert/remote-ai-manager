/**
 * Workspace admission: which uses of one worktree may overlap. Interactive turns
 * are cooperative writers and wait only for Git operations; supervised writers
 * coordinate strictly through disjoint scopes; stable reads exclude supervised
 * writes inside their scope. In-process: one server owns every worktree.
 */

import type {
  TurnWorkspace,
  WorkspaceBindingRequest,
  WorkspaceScope,
} from "./schemas";

export type GrantKind =
  | "observe"
  | "interactive_write"
  | "scoped_write"
  | "full_write"
  | "stable_read"
  | "git";

export interface GrantRequest {
  worktree: string;
  kind: GrantKind;
  /** Repo-relative scope for scoped writes and stable reads; absent means the whole tree. */
  paths?: string[];
  /** Who holds the grant, for blocker reports. */
  holder: string;
}

export interface Grant extends GrantRequest {
  id: number;
}

function scopesOverlap(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return true;
  // Folded: a case-insensitive disk gives two spellings the same files.
  const fold = (paths: string[]) => paths.map((p) => p.toLowerCase());
  const right = fold(b);
  return fold(a).some((l) =>
    right.some(
      (r) => l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`),
    ),
  );
}

/**
 * Whether two supervised bindings on one worktree overlap (design §6.1). A
 * read-only binding's evidence and stable reads cover the whole tree, so it
 * overlaps every writer and only other readers may share the worktree with
 * it; a full-scope binding overlaps every other; owned scopes overlap when a
 * path of one contains a path of the other.
 */
export function bindingScopesOverlap(
  a: WorkspaceScope,
  b: WorkspaceScope,
): boolean {
  if (a.mode === "readOnly" && b.mode === "readOnly") return false;
  if (a.mode === "readOnly" || b.mode === "readOnly") return true;
  if (a.mode === "full" || b.mode === "full") return true;
  return scopesOverlap(a.paths, b.paths);
}

/**
 * One supervised turn's workspace access, the only place a binding's scope,
 * the seat's role and what the turn needs become a grant and write limits.
 * A writing turn holds a write grant over its scope; a review holds a
 * whole-tree stable read; a turn that only observes holds none. An
 * implementer keeps its scope's write limits on every turn, so its runtime is
 * never reconfigured between turns; reviewers are not confined, by decision.
 */
export function turnWorkspaceAccess(input: {
  binding: WorkspaceBindingRequest;
  need: "write" | "stable_read" | "observe";
  role: "implementer" | "reviewer";
}): TurnWorkspace {
  const { binding, need, role } = input;
  const { scope } = binding;
  const grant: TurnWorkspace["grant"] =
    need === "stable_read"
      ? { kind: "stable_read" }
      : need === "observe" || scope.mode === "readOnly"
        ? null
        : scope.mode === "owned"
          ? { kind: "scoped_write", paths: scope.paths }
          : { kind: "full_write" };
  const writes: TurnWorkspace["writes"] =
    role === "reviewer" || scope.mode === "full"
      ? { mode: "all" }
      : scope.mode === "owned"
        ? { mode: "paths", paths: scope.paths }
        : { mode: "none" };
  return {
    projectPath: binding.projectPath,
    sessionName: binding.sessionName,
    worktreePath: binding.worktreePath,
    grant,
    writes,
  };
}

const SUPERVISED_WRITES: ReadonlySet<GrantKind> = new Set([
  "scoped_write",
  "full_write",
]);

/** The conflict relation of design §6.2, symmetric by construction. */
export function grantsConflict(a: GrantRequest, b: GrantRequest): boolean {
  if (a.worktree !== b.worktree) return false;
  if (a.kind === "observe" || b.kind === "observe") return false;
  if (a.kind === "git" || b.kind === "git") return true;
  if (a.kind === "interactive_write" || b.kind === "interactive_write")
    return false;
  if (
    a.kind === "full_write" &&
    (SUPERVISED_WRITES.has(b.kind) || b.kind === "stable_read")
  )
    return true;
  if (
    b.kind === "full_write" &&
    (SUPERVISED_WRITES.has(a.kind) || a.kind === "stable_read")
  )
    return true;
  if (a.kind === "stable_read" && b.kind === "stable_read") return false;
  // Remaining pairs: scoped write against scoped write or stable read.
  return scopesOverlap(a.paths, b.paths);
}

export interface WorkspaceAdmission {
  /** Grants now, or returns null when a held grant or an earlier waiter conflicts. */
  tryAcquire(request: GrantRequest): Grant | null;
  /** Waits in arrival order until compatible; rejects when `signal` aborts first. */
  acquire(request: GrantRequest, signal?: AbortSignal): Promise<Grant>;
  release(grant: Grant): void;
  /** Held grants and earlier waiters that stand in this request's way. */
  blockers(request: GrantRequest): GrantRequest[];
  held(): Grant[];
  /** Resolves on the next release, or when `signal` aborts. */
  waitForChange(signal?: AbortSignal): Promise<void>;
}

interface Waiter {
  request: GrantRequest;
  resolve(grant: Grant): void;
  reject(error: Error): void;
}

/**
 * An interactive turn waits only for Git and publication operations that hold
 * its worktree, never behind one still waiting: a waiting publication may be
 * queued behind supervised work, and a person must not wait for that (§6.2,
 * decision A). The publication waits for the interactive turns instead.
 */
const jumpsTheQueue = (request: GrantRequest): boolean =>
  request.kind === "interactive_write";

export function createWorkspaceAdmission(): WorkspaceAdmission {
  const granted = new Map<number, Grant>();
  const waiters: Waiter[] = [];
  const changeListeners = new Set<() => void>();
  let nextId = 1;

  function conflictsWithHeld(request: GrantRequest): Grant[] {
    return [...granted.values()].filter((held) =>
      grantsConflict(held, request),
    );
  }

  function grant(request: GrantRequest): Grant {
    const created: Grant = { ...request, id: nextId++ };
    granted.set(created.id, created);
    return created;
  }

  function admitWaiters(): void {
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index];
      if (waiter === undefined) break;
      const earlier = waiters.slice(0, index);
      const blocked =
        conflictsWithHeld(waiter.request).length > 0 ||
        earlier.some((other) => grantsConflict(other.request, waiter.request));
      if (blocked) {
        index += 1;
        continue;
      }
      waiters.splice(index, 1);
      waiter.resolve(grant(waiter.request));
    }
  }

  return {
    tryAcquire(request) {
      const blocked =
        conflictsWithHeld(request).length > 0 ||
        (!jumpsTheQueue(request) &&
          waiters.some((waiter) => grantsConflict(waiter.request, request)));
      return blocked ? null : grant(request);
    },
    acquire(request, signal) {
      if (signal?.aborted)
        return Promise.reject(new Error("Workspace admission was cancelled"));
      const immediate = this.tryAcquire(request);
      if (immediate !== null) return Promise.resolve(immediate);
      return new Promise<Grant>((resolve, reject) => {
        const waiter: Waiter = {
          request,
          resolve(granted) {
            signal?.removeEventListener("abort", stop);
            resolve(granted);
          },
          reject,
        };
        function stop(): void {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          reject(new Error("Workspace admission was cancelled"));
          admitWaiters();
        }
        waiters.push(waiter);
        signal?.addEventListener("abort", stop, { once: true });
      });
    },
    release(released) {
      if (!granted.delete(released.id)) return;
      admitWaiters();
      for (const listener of [...changeListeners]) listener();
    },
    waitForChange(signal) {
      return new Promise<void>((resolve) => {
        const listener = () => {
          changeListeners.delete(listener);
          signal?.removeEventListener("abort", listener);
          resolve();
        };
        changeListeners.add(listener);
        signal?.addEventListener("abort", listener, { once: true });
        if (signal?.aborted) listener();
      });
    },
    blockers(request) {
      const ahead = jumpsTheQueue(request)
        ? []
        : waiters
            .filter(
              (waiter) =>
                waiter.request !== request &&
                grantsConflict(waiter.request, request),
            )
            .map((waiter) => waiter.request);
      return [...conflictsWithHeld(request), ...ahead];
    },
    held() {
      return [...granted.values()];
    },
  };
}
