import { createLogger } from "./logging";
import {
  defaultPortOwnershipService,
  type PortOwnershipInput,
  type PortOwnershipResult,
} from "./dev-server-port-ownership";

const logger = createLogger("dev-server");

const DEFAULT_MAX_ATTEMPTS = 100;

// ============================================================
// Public types
// ============================================================

export interface PortSelectionDeps {
  classifyPort(input: PortOwnershipInput): Promise<PortOwnershipResult>;
}

export interface PortSelectionInput {
  basePort: number;
  worktreePath: string;
  allowedCwd?: string | null;
  maxAttempts?: number;
}

type PortSelectionSource = "external-adopted" | "available";

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
      source: PortSelectionSource;
      port: number;
      pid?: number;
      cwd?: string;
    }
  | {
      status: "exhausted";
      diagnostics: PortSelectionDiagnostic[];
    };

// ============================================================
// Service factory
// ============================================================

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

    const classifications = new Map<number, PortOwnershipResult>();
    const classify = async (port: number): Promise<PortOwnershipResult> => {
      const cached = classifications.get(port);
      if (cached) return cached;
      const result = await deps.classifyPort({
        port,
        worktreePath,
        allowedCwd,
      });
      classifications.set(port, result);
      return result;
    };

    // Pass 1 — find the lowest owned port anywhere in the range.
    for (let offset = 0; offset < maxAttempts; offset++) {
      const port = basePort + offset;
      const result = await classify(port);
      if (result.status === "owned") {
        logger.info("dev-server.port_selection.owned_found", {
          basePort,
          port,
          pid: result.pid,
          cwd: result.cwd,
        });
        return {
          status: "selected",
          source: "external-adopted",
          port,
          pid: result.pid,
          cwd: result.cwd,
        };
      }
    }

    // Pass 2 — find the first available port, base inclusive.
    for (let offset = 0; offset < maxAttempts; offset++) {
      const port = basePort + offset;
      const result = await classify(port);
      if (result.status === "available") {
        logger.info("dev-server.port_selection.available_found", {
          basePort,
          port,
        });
        return { status: "selected", source: "available", port };
      }
    }

    const diagnostics: PortSelectionDiagnostic[] = [];
    for (let offset = 0; offset < maxAttempts; offset++) {
      const port = basePort + offset;
      const result = classifications.get(port);
      if (!result) continue;
      if (result.status === "conflict") {
        diagnostics.push({
          port,
          status: "conflict",
          pid: result.pid,
          cwd: result.cwd,
        });
      } else if (result.status === "unknown") {
        diagnostics.push({
          port,
          status: "unknown",
          reason: result.reason,
        });
      }
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
});
