import { afterEach, describe, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  workspaceBindingRecordSchema,
  workspaceOperationRecordSchema,
} from "@/lib/workspace/schemas";
import { createWorkspaceRepo } from "./workspace-repo";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

describe("workspace repository", () => {
  it("round-trips a binding with its baseline", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createWorkspaceRepo(db);
    await assertRoundTripDurability({
      label: "workspace binding",
      schema: workspaceBindingRecordSchema,
      buildMaximalFixture: () => ({
        bindingId: "ctx-1",
        request: {
          kind: "session" as const,
          projectPath: "/repo",
          sessionName: "session",
          worktreePath: "/repo/.worktrees/session",
          scope: { mode: "owned" as const, paths: ["src/api"] },
        },
        state: "bound" as const,
        baseline: "git:abc:def",
        createdAt: "2026-10-03T10:00:00.000Z",
        updatedAt: "2026-10-03T10:01:00.000Z",
      }),
      persist: (value) => {
        repo.insertBindingIfAbsent(value);
        return value;
      },
      reload: (value) => createWorkspaceRepo(db).getBinding(value.bindingId),
    });
  });

  it("round-trips an operation with its permit and outcome", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createWorkspaceRepo(db);
    await assertRoundTripDurability({
      label: "workspace operation",
      schema: workspaceOperationRecordSchema,
      buildMaximalFixture: () => ({
        cause: "ctx-1:check:3",
        bindingId: "ctx-1",
        requester: { kind: "context" as const, id: "ctx-1" },
        request: {
          kind: "check",
          bindingId: "ctx-1",
          command: "typecheck",
          evidence: "git:a:b",
        },
        permit: { controllerId: "context:ctx-1", generation: 2 },
        state: "settled" as const,
        outcome: {
          kind: "checked",
          status: "passed",
          wroteReviewedScope: ["x"],
        },
        createdAt: "2026-10-03T10:00:00.000Z",
        updatedAt: "2026-10-03T10:02:00.000Z",
      }),
      persist: (value) => {
        repo.insertOperationIfAbsent(value);
        return value;
      },
      reload: (value) => createWorkspaceRepo(db).getOperation(value.cause),
    });
  });
});
