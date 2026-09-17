import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runForTest } from "cli-for-agents/testing";
import { graphWorkflowLaunchExample } from "@/lib/workflow-graph/launch-presentation";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

describe("spec analysis", () => {
  it("preserves a comparison-file diagnostic in a CC usage refusal", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => {
        throw new Error("must not contact server");
      },
    });
    const diagnostic = `Cannot open /missing-${"bundle".repeat(150)}\n.json`;
    const result = await runForTest(
      fixture.cli,
      ["spec", "verify", "native-sdd", "--against", "/missing.json"],
      {
        host: {
          ...fixture.kernelHost,
          files: {
            ...fixture.kernelHost.files,
            read: async () => {
              throw new Error(diagnostic);
            },
          },
        },
        env: {
          CC_PROJECT: "project-one",
          CC_SERVER_URL: "http://cc.test",
          CC_API_TOKEN: "test-token",
        },
        format: "json",
      },
    );
    expect(result.exitCode, result.stdout || result.stderr).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).toBe("CC_USAGE");
    expect(envelope.error.details.cause).toBe(diagnostic);
    expect(fixture.requests).toHaveLength(0);
  });
  it("executes a diff continuation against its explicit target and comparison basis", async () => {
    const diff = {
      slug: "native-sdd",
      baseline: "governance",
      from: null,
      to: { revisionId: "r1", number: 1, state: "draft" },
      elements: Array.from({ length: 11 }, (_, index) => ({
        elementId: `element-${index}`,
        handle: `R${index + 1}`,
        kind: "requirement",
        classification: "added",
        directlyChanged: true,
        summary: "New requirement",
      })),
      planStale: false,
    };
    const fixture = createCcRuntimeFixture({ respond: () => jsonReply(diff) });
    const result = await fixture.run([
      "spec",
      "diff",
      "native-sdd",
      "--baseline",
      "governance",
      "--project",
      "other-project",
      "--server",
      "https://other.test",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const reveal = z
      .object({
        path: z.string(),
        args: z.array(z.string()),
        flags: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean()]),
        ),
      })
      .parse(JSON.parse(result.stdout).payload.data.disclosure.reveal);
    const argv = [
      ...reveal.path.split(" "),
      ...Object.entries(reveal.flags).map(([key, value]) =>
        value === true ? `--${key}` : `--${key}=${value}`,
      ),
      "--",
      ...reveal.args,
    ];
    const replay = createCcRuntimeFixture({ respond: () => jsonReply(diff) });
    const full = await replay.run(argv);
    expect(full.exitCode, full.stdout).toBe(0);
    expect(replay.requests.map((request) => request.url)).toEqual([
      "https://other.test/api/specs/other-project/native-sdd/diff?baseline=governance",
    ]);
    expect(JSON.parse(full.stdout).payload.data.diff.elements).toHaveLength(11);
  });

  it("keeps review and governance bases distinct and rejects conflicting bases before HTTP", async () => {
    const diff = {
      slug: "native-sdd",
      baseline: "governance",
      from: null,
      to: { revisionId: "r1", number: 1, state: "draft" },
      elements: [],
      planStale: false,
    };
    const fixture = createCcRuntimeFixture({ respond: () => jsonReply(diff) });
    const conflict = await fixture.run([
      "spec",
      "diff",
      "native-sdd",
      "--from",
      "r0",
      "--baseline",
      "governance",
    ]);
    expect(conflict.exitCode).toBe(2);
    expect(fixture.requests).toHaveLength(0);
    const result = await fixture.run([
      "spec",
      "diff",
      "native-sdd",
      "--baseline",
      "governance",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(
      new URL(fixture.requests[0]?.url ?? "http://invalid").searchParams.get(
        "baseline",
      ),
    ).toBe("governance");
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { diff } },
    });
  });

  it("returns an unresolved consistency finding as a failed verification with its remedy", async () => {
    const finding = {
      family: "proposal-integrity",
      code: "superseded_proposal",
      revisionId: "r1",
      revisionNumber: 1,
      supersededByRevisionId: "r2",
      detail: "A later approval superseded this proposal",
      remedy: "cctl spec withdraw native-sdd --revision r1",
    };
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          ok: true,
          checkedRevisionIds: ["r2"],
          mismatches: [],
          consistencyFindings: [finding],
        }),
    });
    const result = await fixture.run(["spec", "verify", "native-sdd"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { details: { serverCode: "spec_inconsistent" } },
      payload: { data: { report: { consistencyFindings: [finding] } } },
      instruction: "Run the remedy named on each finding, then verify again.",
    });
  });

  it("validates a comparison bundle before contacting the server", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => {
        throw new Error("must not fetch");
      },
      files: { "/invalid.json": "{}" },
    });
    const result = await fixture.run([
      "spec",
      "verify",
      "native-sdd",
      "--against",
      "/invalid.json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.details.serverCode).toBe(
      "integrity_mismatch",
    );
    expect(fixture.requests).toHaveLength(0);
  });

  it("reads the authored preview with optimistic concurrency and can project its graph outline", async () => {
    const launch = graphWorkflowLaunchExample();
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          stage: "draft",
          attemptId: "a1",
          specSlug: "native-sdd",
          draftRevision: 4,
          pinnedRevisionId: "r1",
          candidateHash: null,
          snapshotId: null,
          candidateId: null,
          approvable: false,
          approvability: "A draft attempt is never approvable.",
          launch,
          binding: { dispositions: [] },
        }),
    });
    const invalid = await fixture.run([
      "spec",
      "plan",
      "preview",
      "native-sdd",
      "--stage",
      "proposed",
      "--expected-draft-revision",
      "4",
    ]);
    expect(invalid.exitCode).toBe(2);
    expect(fixture.requests).toHaveLength(0);
    const result = await fixture.run([
      "spec",
      "plan",
      "preview",
      "native-sdd",
      "--stage",
      "draft",
      "--expected-draft-revision",
      "4",
      "--outline",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { outline: { name: launch.name } } },
    });
    expect(fixture.requests[0]?.url).toContain(
      "stage=draft&expectedDraftRevision=4",
    );
    expect(result.stdout).not.toContain(
      launch.definition.executionContexts[0]?.acceptanceCriteria,
    );
  });
});
