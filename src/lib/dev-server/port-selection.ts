import { createLogger } from "../logging";
import {
  defaultPortOwnershipService,
  type PortOwnershipInput,
  type PortOwnershipResult,
  type ScanRangeInput,
  type ScanRangeMatch,
} from "./port-ownership";

const logger = createLogger("dev-server");

const DEFAULT_MAX_ATTEMPTS = 100;

// ============================================================
// Public types
// ============================================================

export interface PortSelectionDeps {
  classifyPort(input: PortOwnershipInput): Promise<PortOwnershipResult>;
  /**
   * Batched sweep for an already-running listener owned by this worktree.
   * One system-wide listener lookup instead of a per-port classification of
   * the whole range — the difference between a couple of subprocess spawns
   * and one per port on every dev-server start.
   */
  findOwnedListenerInRange(input: ScanRangeInput): Promise<ScanRangeMatch>;
}

export interface PortSelectionInput {
  basePort: number;
  worktreePath: string;
  allowedCwd?: string | null;
  maxAttempts?: number;
}

export interface PortSelectionDiagnostic {
  port: number;
  status: "conflict" | "unknown";
  pid?: number;
  cwd?: string | null;
  reason?: string;
}

export type PortSelectionResult =
  | {
      status: "selected";
      port: number;
    }
  | {
      status: "unmanaged-detected";
      port: number;
      pid: number;
      cwd: string;
    }
  | {
      status: "exhausted";
      diagnostics: PortSelectionDiagnostic[];
    };

// ============================================================
// Service factory
// ============================================================

function toDiagnostic(
  port: number,
  result: Extract<PortOwnershipResult, { status: "conflict" | "unknown" }>,
): PortSelectionDiagnostic {
  if (result.status === "unknown") {
    return { port, status: "unknown", reason: result.reason };
  }
  const diag: PortSelectionDiagnostic = { port, status: "conflict" };
  if (result.pid !== null) diag.pid = result.pid;
  if (result.cwd !== null) diag.cwd = result.cwd;
  if (result.reason) diag.reason = result.reason;
  return diag;
}

export function createPortSelectionService(deps: PortSelectionDeps) {
  async function selectPort(
    input: PortSelectionInput,
  ): Promise<PortSelectionResult> {
    const { basePort, worktreePath } = input;
    const allowedCwd = input.allowedCwd ?? null;
    const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

    logger.info("dev-server.port_selection.start", {
      basePort,
      worktreePath,
      allowedCwd,
      maxAttempts,
    });

    const unmanagedDetected = (
      port: number,
      pid: number,
      cwd: string,
    ): PortSelectionResult => {
      logger.info("dev-server.port_selection.unmanaged_detected", {
        basePort,
        port,
        pid,
        cwd,
      });
      return { status: "unmanaged-detected", port, pid, cwd };
    };

    // Pass 1 — surface the lowest unmanaged listener anywhere in the range so
    // the caller can prompt the user to stop it rather than silently adopting.
    // One batched sweep: only ports that actually hold a listener cost a cwd
    // lookup, so a range with nothing running in it costs a single lookup.
    const owned = await deps.findOwnedListenerInRange({
      basePort,
      rangeSize: maxAttempts,
      worktreePath,
      allowedCwd,
    });
    if (owned.status === "owned") {
      return unmanagedDetected(owned.port, owned.pid, owned.cwd);
    }

    // Pass 2 — first available port, base inclusive. `classifyPort` bind-probes
    // a port with no visible listener, which is the only signal that catches
    // root-owned binds (tailscaled under `tailscale serve`) that `lsof` misses.
    const diagnostics: PortSelectionDiagnostic[] = [];
    for (let offset = 0; offset < maxAttempts; offset++) {
      const port = basePort + offset;
      const result = await deps.classifyPort({
        port,
        worktreePath,
        allowedCwd,
      });
      if (result.status === "available") {
        logger.info("dev-server.port_selection.available_found", {
          basePort,
          port,
        });
        return { status: "selected", port };
      }
      // The batched sweep is best-effort — it reports no match when the
      // system-wide listener lookup fails. Taking a port this worktree already
      // owns would start a duplicate server, so honour ownership here too.
      if (result.status === "owned") {
        return unmanagedDetected(port, result.pid, result.cwd);
      }
      diagnostics.push(toDiagnostic(port, result));
    }

    logger.warn("dev-server.port_selection.exhausted", {
      basePort,
      worktreePath,
      maxAttempts,
      diagnosticsCount: diagnostics.length,
    });

    return { status: "exhausted", diagnostics };
  }

  return { selectPort };
}

// ============================================================
// Default production service
// ============================================================

export const defaultPortSelectionService = createPortSelectionService({
  classifyPort: defaultPortOwnershipService.classifyPort,
  findOwnedListenerInRange:
    defaultPortOwnershipService.findOwnedListenerInRange,
});
