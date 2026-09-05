import { describe, expect, it } from "vitest";

import { graphWorkflowLaunchExample } from "@/lib/workflow-graph/launch-presentation";
import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "contract-token",
  CC_PROJECT: "demo",
  CC_SESSION: "feature-session",
  CC_CONVERSATION_ID: "conversation-1",
};

const LAUNCH = graphWorkflowLaunchExample();

const PREVIEW = {
  stage: "draft",
  attemptId: "attempt-1",
  specSlug: "native-sdd",
  draftRevision: 4,
  pinnedRevisionId: "revision-approved",
  candidateHash: null,
  snapshotId: null,
  candidateId: null,
  approvable: false,
  approvability: "A draft attempt is never approvable.",
  launch: LAUNCH,
  binding: { dispositions: [] },
};

function makeHost(): CliHost & { requests: Array<{ url: string }> } {
  const requests: Array<{ url: string }> = [];
  return {
    requests,
    async fetch(url: string, _init: FetchInit) {
      requests.push({ url });
      return new Response(JSON.stringify(PREVIEW), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    readTextFile: async () => null,
    readFileBytes: async () => null,
    sleep: async () => {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl spec plan preview --outline (#80 I-18)", () => {
  it("renders the launch envelope through the workflow outline renderer", async () => {
    const result = await runCli(
      [
        "spec",
        "plan",
        "preview",
        "native-sdd",
        "--stage",
        "draft",
        "--outline",
      ],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `workflow ${LAUNCH.layout.workflowId} "${LAUNCH.name}" rev 4`,
    );
    expect(result.stdout).toContain("contexts (");
    expect(result.stdout).toContain("-> --charter");
    // The outline reports SIZES, never the acceptance-criteria or instruction
    // prose the whole envelope carries.
    expect(result.stdout).not.toContain(
      LAUNCH.definition.executionContexts[0]?.acceptanceCriteria,
    );
  });

  it("carries the outline projection instead of the whole preview with --json", async () => {
    const result = await runCli(
      [
        "spec",
        "plan",
        "preview",
        "native-sdd",
        "--stage",
        "draft",
        "--outline",
        "--json",
      ],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.outline.name).toBe(LAUNCH.name);
    expect(envelope).not.toHaveProperty("preview");
  });

  it("leaves the output unchanged without the flag", async () => {
    const result = await runCli(
      ["spec", "plan", "preview", "native-sdd", "--stage", "draft"],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("plan preview native-sdd — draft");
    expect(result.stdout).not.toContain("contexts (");
  });
});
