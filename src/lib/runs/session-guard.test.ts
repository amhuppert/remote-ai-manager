import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createRunsRepo } from "@/lib/state-store/runs-repo";
import { DEFAULT_CONTEXT_POLICY } from "@/lib/execution-context/schemas";
import {
  binding,
  contract,
} from "@/lib/execution-context/testing/context-harness";
import type { RunProgress, RunRecord } from "./schemas";
import { currentRunsIn } from "./session-guard";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

function run(
  runId: string,
  projectPath: string,
  sessionName: string,
  progress: RunProgress,
): RunRecord {
  const at = "2026-10-11T12:00:00.000Z";
  return {
    runId,
    projectPath,
    sessionName,
    ownerConversationId: "owner",
    ownerSessionName: sessionName,
    launchCause: `launch:${runId}`,
    origin: null,
    facts: {
      runId,
      kind: "agent",
      title: runId,
      definition: {
        revision: 1,
        contexts: [
          {
            key: "fix",
            dependsOn: [],
            request: {
              contextId: `${runId}.fix.1`,
              runId,
              ownerConversationId: "owner",
              workspace: { ...binding, projectPath, sessionName },
              contract: contract(),
              policy: DEFAULT_CONTEXT_POLICY,
            },
          },
        ],
      },
      documents: [],
      charter: [],
      invocations: [],
      control: { paused: false, cancelled: false, fault: null },
      acts: [],
      amendments: [],
    },
    revision: 1,
    progress,
    createdAt: at,
    updatedAt: at,
  };
}

describe("a session's current runs, as stored", () => {
  it("are every run not yet succeeded or cancelled, in that project and session", () => {
    fixture = createPersistenceFixture();
    const repo = createRunsRepo(fixture.db);
    const kinds: RunProgress[] = [
      { kind: "running" },
      { kind: "needs_owner", reasons: ["A question"] },
      { kind: "paused", draining: false },
      { kind: "stopping" },
      { kind: "succeeded" },
      { kind: "cancelled" },
    ];
    for (const progress of kinds) {
      repo.insertIfAbsent(run(`a-${progress.kind}`, "/a", "s1", progress));
    }
    repo.insertIfAbsent(run("other-session", "/a", "s2", { kind: "running" }));
    repo.insertIfAbsent(run("other-project", "/b", "s1", { kind: "running" }));

    expect(
      currentRunsIn(repo, "/a", "s1")
        .map((current) => current.progress)
        .sort(),
    ).toEqual(["needs_owner", "paused", "running", "stopping"]);
    expect(
      currentRunsIn(repo, "/a")
        .map((current) => current.runId)
        .sort(),
    ).toEqual([
      "a-needs_owner",
      "a-paused",
      "a-running",
      "a-stopping",
      "other-session",
    ]);
  });
});
