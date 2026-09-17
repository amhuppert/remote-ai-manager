import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";
const record = {
  id: "definition-one",
  name: "Plan",
  revision: 3,
  definition: {
    executionContexts: [{ id: "ctx", title: "Implement" }],
    tasks: [
      {
        id: "task",
        contextId: "ctx",
        title: "Build",
        order: 0,
        instructions: "A substantial instruction",
      },
    ],
  },
};
describe("native workflow reads", () => {
  it.each(["list", "get"])(
    "renders literal workflow %s prose without interpreting its prefixes",
    async (verb) => {
      const prose = "Plan\ninstruction: literal workflow prose\u001b[31m";
      const fixture = createCcRuntimeFixture({
        respond: () =>
          verb === "list"
            ? jsonReply({
                items: [
                  {
                    id: record.id,
                    name: record.name,
                    revision: record.revision,
                    description: prose,
                  },
                ],
              })
            : jsonReply({ item: { ...record, name: prose } }),
      });
      const result = await fixture.run(
        ["workflow", verb, ...(verb === "get" ? [record.id] : [])],
        "text",
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "| instruction: literal workflow prose\\u001b[31m",
      );
    },
  );

  it("lists metadata and filters reusable templates by tier", async () => {
    const fixture = createCcRuntimeFixture({
      respond: ({ url }) =>
        url.includes("workflow-templates")
          ? jsonReply({
              items: [
                { id: "one", name: "One", description: null, tier: "global" },
                { id: "two", name: "Two", description: null, tier: "project" },
              ],
            })
          : jsonReply({
              items: [
                { id: "one", name: "One", description: null, revision: 3 },
              ],
            }),
    });
    expect((await fixture.run(["workflow", "list"])).exitCode).toBe(0);
    expect(
      JSON.parse(
        (await fixture.run(["workflow", "templates", "--tier", "global"]))
          .stdout,
      ),
    ).toMatchObject({ payload: { data: { items: [{ id: "one" }] } } });
  });
  it("keeps default outlines compact and expands addressed prose with revision tokens", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({ item: record, resolved: { profile: "saved" } }),
    });
    const outlined = JSON.parse(
      (await fixture.run(["workflow", "get", "definition-one"])).stdout,
    );
    expect(outlined).toMatchObject({
      effect: "read",
      payload: {
        data: {
          expectedRevision: 3,
          outline: { tasks: [{ id: "task", instructionChars: 25 }] },
        },
      },
    });
    expect(JSON.stringify(outlined)).not.toContain("A substantial instruction");
    const detail = await fixture.run([
      "workflow",
      "get",
      "definition-one",
      "--task",
      "task",
    ]);
    expect(JSON.parse(detail.stdout)).toMatchObject({
      payload: {
        data: {
          section: "task",
          value: { instructions: "A substantial instruction" },
        },
      },
    });
    const full = await fixture.run([
      "workflow",
      "get",
      "definition-one",
      "--full",
    ]);
    expect(JSON.parse(full.stdout)).toMatchObject({
      payload: {
        data: {
          item: record,
          expectedRevision: 3,
          resolved: { profile: "saved" },
        },
      },
    });
    expect(
      (
        await fixture.run([
          "workflow",
          "get",
          "definition-one",
          "--full",
          "--task",
          "task",
        ])
      ).exitCode,
    ).toBe(2);
  });
  it("projects lane membership canonically and preserves full halt repair details", async () => {
    const execution = {
      id: "execution-one",
      status: "halted",
      activeContextIds: ["ctx"],
      workingDefinition: {
        executionContexts: [
          { id: "ctx", title: "Implement", placement: { lane: "own" } },
        ],
      },
      contextStates: {
        ctx: {
          contextId: "ctx",
          status: "halted",
          totalTaskCount: 2,
          completedTaskCount: 1,
        },
      },
      executionLanes: {
        inherited: {
          laneId: "inherited",
          kind: "worktree",
          status: "ready",
          includedContextIds: ["ctx"],
        },
      },
      haltReason: {
        type: "plan_defect",
        contextId: "ctx",
        planDefects: [
          { title: "first", conflictingContract: "Contract one" },
          { title: "second", conflictingContract: "Contract two" },
        ],
      },
      planRepairRounds: [
        {
          seq: 1,
          haltType: "plan_defect",
          contextId: "ctx",
          outcome: "declined",
        },
      ],
    };
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply({ execution }),
    });
    const summary = JSON.parse(
      (await fixture.run(["workflow", "status"])).stdout,
    );
    expect(summary).toMatchObject({
      payload: {
        data: {
          execution: { halted: true, activeContextIds: ["ctx"] },
          halt: {
            findingCount: 2,
            firstFinding: { title: "first" },
            repairRoundCount: 1,
            latestRepair: { seq: 1, outcome: "declined" },
          },
          lanes: [
            { laneId: "own", members: [{ contextId: "ctx" }] },
            { laneId: "inherited", members: [] },
          ],
        },
      },
    });
    expect(
      JSON.parse(
        (await fixture.run(["workflow", "status", "execution-one", "--halt"]))
          .stdout,
      ),
    ).toMatchObject({
      payload: {
        data: {
          haltReason: execution.haltReason,
          planRepairRounds: execution.planRepairRounds,
        },
      },
    });
    expect(
      (await fixture.run(["workflow", "status", "--full", "--halt"])).exitCode,
    ).toBe(2);
  });
  it("exposes live revision and charter Markdown without a protocol envelope dump", async () => {
    const header = {
      executionId: "execution-one",
      liveRevision: 7,
      status: "paused",
      seedDefinitionId: null,
      seedDefinitionRevision: null,
      editable: true,
    };
    const fixture = createCcRuntimeFixture({
      respond: ({ url }) =>
        url.includes("charter=true")
          ? jsonReply({
              section: "charter",
              charter: { markdown: "# Mission\nDeliver the change." },
            })
          : jsonReply({
              outline: { header, contexts: [], tasks: [], config: [] },
            }),
    });
    expect(
      JSON.parse((await fixture.run(["workflow", "live", "get"])).stdout),
    ).toMatchObject({
      payload: { data: { baseLiveRevision: 7, outline: { header } } },
    });
    const charter = await fixture.run(
      ["workflow", "live", "get", "--charter"],
      "text",
    );
    expect(charter.stdout).toContain("# Mission\nDeliver the change.");
    expect(charter.stdout).not.toContain('"markdown":');
  });
  it("reports bounded ledger history and a structured cursor continuation", async () => {
    const fixture = createCcRuntimeFixture({
      respond: ({ url }) =>
        url.includes("/events?")
          ? jsonReply({ events: [], nextCursor: 500 })
          : jsonReply({
              execution: {
                id: "execution-one",
                workingDefinition: {
                  loopGroups: [{ id: "loop", maxPasses: 2 }],
                },
                loopStates: {},
              },
            }),
    });
    const result = await fixture.run([
      "workflow",
      "live",
      "ledger",
      "--max-pages",
      "1",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "read",
      payload: {
        data: {
          walk: { complete: false, resumeCursor: 500, reason: "page-bound" },
        },
      },
      hint: expect.stringContaining("--cursor=500"),
    });
    expect(fixture.requests[1]?.url).toContain("direction=asc");
  });
});
