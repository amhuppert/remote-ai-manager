/**
 * Workspace admission: which uses of one worktree may overlap. Interactive turns
 * are cooperative writers and wait only for Git operations; supervised writers
 * coordinate strictly through disjoint scopes; stable reads exclude supervised
 * writes inside their scope. In-process: one server owns every worktree.
 */

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

function scopesOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return a.some((left) =>
    b.some(
      (right) =>
        left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`),
    ),
  );
}

const SUPERVISED_WRITES: ReadonlySet<GrantKind> = new Set(["scoped_write", "full_write"]);

/** The conflict relation of design §6.2, symmetric by construction. */
export function grantsConflict(a: GrantRequest, b: GrantRequest): boolean {
  if (a.worktree !== b.worktree) return false;
  if (a.kind === "observe" || b.kind === "observe") return false;
  if (a.kind === "git" || b.kind === "git") return true;
  if (a.kind === "interactive_write" || b.kind === "interactive_write") return false;
  if (a.kind === "full_write" && (SUPERVISED_WRITES.has(b.kind) || b.kind === "stable_read")) return true;
  if (b.kind === "full_write" && (SUPERVISED_WRITES.has(a.kind) || a.kind === "stable_read")) return true;
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

export function createWorkspaceAdmission(): WorkspaceAdmission {
  const granted = new Map<number, Grant>();
  const waiters: Waiter[] = [];
  const changeListeners = new Set<() => void>();
  let nextId = 1;

  function conflictsWithHeld(request: GrantRequest): Grant[] {
    return [...granted.values()].filter((held) => grantsConflict(held, request));
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
        waiters.some((waiter) => grantsConflict(waiter.request, request));
      return blocked ? null : grant(request);
    },
    acquire(request, signal) {
      const immediate = this.tryAcquire(request);
      if (immediate !== null) return Promise.resolve(immediate);
      return new Promise<Grant>((resolve, reject) => {
        const waiter: Waiter = { request, resolve, reject };
        waiters.push(waiter);
        signal?.addEventListener(
          "abort",
          () => {
            const index = waiters.indexOf(waiter);
            if (index === -1) return;
            waiters.splice(index, 1);
            reject(new Error("Workspace admission was cancelled"));
            admitWaiters();
          },
          { once: true },
        );
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
      const ahead = waiters
        .filter((waiter) => waiter.request !== request && grantsConflict(waiter.request, request))
        .map((waiter) => waiter.request);
      return [...conflictsWithHeld(request), ...ahead];
    },
    held() {
      return [...granted.values()];
    },
  };
}
