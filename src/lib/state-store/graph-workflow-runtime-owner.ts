import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { isProcessAlive } from "@/lib/shared/process-liveness";

const logger = createLogger("graph-workflow.runtime-owner");

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().min(1),
});
export type GraphWorkflowRuntimeOwner = z.infer<typeof ownerSchema>;
export interface RuntimeOwnerDeps {
  identity: GraphWorkflowRuntimeOwner;
  isProcessAlive(pid: number): boolean;
}
export type RuntimeOwnerClaim =
  | { kind: "acquired"; owner: GraphWorkflowRuntimeOwner }
  | { kind: "occupied"; owner: GraphWorkflowRuntimeOwner };

function defaultDeps(): RuntimeOwnerDeps {
  return {
    identity: getGlobalSingleton(
      "__cc_graph_workflow_runtime_owner_identity__",
      () => ({ pid: process.pid, token: randomUUID() }),
    ),
    isProcessAlive,
  };
}

function sameOwner(
  left: GraphWorkflowRuntimeOwner | null,
  right: GraphWorkflowRuntimeOwner | null,
): boolean {
  return left?.pid === right?.pid && left?.token === right?.token;
}

/**
 * Acquire the sole same-host graph driver before recovery or admission.
 * Ownership lasts for the process lifetime. An uncertain live PID is refused;
 * only confirmed process death permits replacement, so recovery never sweeps
 * another runtime's live preparation or loops.
 */
export function claimGraphWorkflowRuntimeOwner(
  db: InstanceType<typeof Database>,
  deps: RuntimeOwnerDeps = defaultDeps(),
): RuntimeOwnerClaim {
  db.exec(`CREATE TABLE IF NOT EXISTS graph_workflow_runtime_owner (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    pid INTEGER NOT NULL,
    token TEXT NOT NULL
  )`);
  const identity = ownerSchema.parse(deps.identity);
  const readOwner = () => {
    const row: unknown = db
      .prepare(
        "SELECT pid, token FROM graph_workflow_runtime_owner WHERE singleton = 1",
      )
      .get();
    return row === undefined ? null : ownerSchema.parse(row);
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = readOwner();
    if (sameOwner(observed, identity))
      return { kind: "acquired", owner: identity };
    if (observed && deps.isProcessAlive(observed.pid)) {
      logger.error("graph-workflow.runtime_owner.occupied", {
        pid: identity.pid,
        ownerPid: observed.pid,
      });
      return { kind: "occupied", owner: observed };
    }
    const acquired = db
      .transaction(() => {
        if (!sameOwner(readOwner(), observed)) return false;
        db.prepare(
          `INSERT INTO graph_workflow_runtime_owner (singleton, pid, token) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET pid = excluded.pid, token = excluded.token`,
        ).run(identity.pid, identity.token);
        return true;
      })
      .immediate();
    if (!acquired) continue;
    logger.info("graph-workflow.runtime_owner.acquired", {
      pid: identity.pid,
      previousPid: observed?.pid ?? null,
    });
    return { kind: "acquired", owner: identity };
  }
  logger.error("graph-workflow.runtime_owner.contended", { pid: identity.pid });
  throw new Error(
    "Graph runtime ownership changed repeatedly during admission; retry startup after the other runtime settles.",
  );
}
