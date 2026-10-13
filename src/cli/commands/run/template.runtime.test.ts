import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const content = {
  name: "Release checklist",
  description: "Prepare a release",
  parameters: [{ name: "version", description: "Version", required: true }],
  defaults: { humanApproval: true },
  workflow: {
    contexts: [{ key: "notes", brief: "Write notes for {{inputs.version}}" }],
  },
};

function record(revision: number) {
  return {
    ...content,
    format: 1,
    id: "release-checklist",
    revision,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T11:00:00.000Z",
  };
}

const globals = {
  implementer: { profile: { tier: "builtin", id: "standard-agent" } },
  reviewers: [],
  checks: [],
  humanApproval: false,
  ownerQuestions: true,
  timeoutMs: null,
};

function summary(tier: "project" | "global", id: string, name: string) {
  return {
    tier,
    id,
    name,
    description: "",
    contexts: 1,
    parameters: [],
    revision: 1,
    updatedAt: "2026-10-12T11:00:00.000Z",
  };
}

function bodyOf(init: { body?: unknown }): unknown {
  return typeof init.body === "string" ? JSON.parse(init.body) : undefined;
}

const LIBRARY = "http://cc.test/api/projects/project-one/run-templates";

describe("run template commands", () => {
  it("creates a template in this project with the content of the file", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/t.json": JSON.stringify(content) },
      respond: (request) =>
        request.url === LIBRARY
          ? jsonReply({ items: [], diagnostics: [] })
          : jsonReply({ template: record(1) }, 201),
    });

    const result = await fixture.run([
      "run",
      "template",
      "save",
      "release-checklist",
      "--file",
      "/t.json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]?.url).toBe(
      `${LIBRARY}/project/release-checklist`,
    );
    expect(fixture.requests[1]?.init.method).toBe("PUT");
    expect(bodyOf(fixture.requests[1]?.init ?? {})).toEqual({
      expectedRevision: null,
      template: content,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: {
          tier: "project",
          id: "release-checklist",
          revision: 1,
          action: "created",
        },
      },
    });
  });

  it("replaces a global template at the revision it was based on", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/t.json": JSON.stringify(content) },
      respond: () => jsonReply({ template: record(3) }),
    });

    const result = await fixture.run([
      "run",
      "template",
      "save",
      "release-checklist",
      "--tier",
      "global",
      "--based-on",
      "2",
      "--file",
      "/t.json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.requests[0]?.url).toBe(
      `${LIBRARY}/global/release-checklist`,
    );
    expect(bodyOf(fixture.requests[0]?.init ?? {})).toMatchObject({
      expectedRevision: 2,
    });
    expect(JSON.parse(result.stdout).payload.data).toMatchObject({
      revision: 3,
      action: "updated",
    });
  });

  it("replaces a template in the tier that holds it when --tier is omitted", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/t.json": JSON.stringify(content) },
      respond: (request) =>
        request.url === LIBRARY
          ? jsonReply({
              items: [
                summary("global", "release-checklist", "Release checklist"),
              ],
              diagnostics: [],
            })
          : jsonReply({ template: record(4) }),
    });

    const result = await fixture.run([
      "run",
      "template",
      "save",
      "release-checklist",
      "--based-on",
      "3",
      "--file",
      "/t.json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.requests[1]?.url).toBe(
      `${LIBRARY}/global/release-checklist`,
    );
    expect(bodyOf(fixture.requests[1]?.init ?? {})).toMatchObject({
      expectedRevision: 3,
    });
  });

  it("refuses to replace an id both tiers use without --tier, sending nothing", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/t.json": JSON.stringify(content) },
      respond: () =>
        jsonReply({
          items: [
            summary("project", "release-checklist", "Our release"),
            summary("global", "release-checklist", "Shared release"),
          ],
          diagnostics: [],
        }),
    });

    const result = await fixture.run(
      [
        "run",
        "template",
        "save",
        "release-checklist",
        "--based-on",
        "3",
        "--file",
        "/t.json",
      ],
      "text",
    );

    expect(result.exitCode).not.toBe(0);
    expect(fixture.requests).toHaveLength(1);
    expect(result.stderr).toContain(
      'global:release-checklist ("Shared release")',
    );
  });

  it("refuses to create a project template beside a global one of the same id unless --tier says so", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/t.json": JSON.stringify(content) },
      respond: () =>
        jsonReply({
          items: [summary("global", "release-checklist", "Shared release")],
          diagnostics: [],
        }),
    });

    const result = await fixture.run(
      ["run", "template", "save", "release-checklist", "--file", "/t.json"],
      "text",
    );

    expect(result.exitCode).not.toBe(0);
    expect(fixture.requests).toHaveLength(1);
    expect(result.stderr).toContain(
      'global:release-checklist ("Shared release")',
    );
  });

  it("reports a refused save as not applied, keeping the server's code", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/t.json": JSON.stringify(content) },
      respond: () =>
        jsonReply(
          {
            error:
              "Run template project:release-checklist is at revision 4, not 2",
            code: "run_template_revision_conflict",
            details: { currentRevision: 4 },
          },
          409,
        ),
    });

    const result = await fixture.run([
      "run",
      "template",
      "save",
      "release-checklist",
      "--tier",
      "project",
      "--based-on",
      "2",
      "--file",
      "/t.json",
    ]);

    expect(result.exitCode).not.toBe(0);
    const output = JSON.parse(result.stderr || result.stdout);
    expect(output).toMatchObject({
      effect: "not_applied",
      error: { details: { serverCode: "run_template_revision_conflict" } },
    });
  });

  it("checks a template locally, locating every token problem, without sending anything", async () => {
    const fixture = createCcRuntimeFixture({
      files: {
        "/t.json": JSON.stringify({
          ...content,
          workflow: {
            contexts: [
              { key: "notes", brief: "Notes for {{inputs.verison}}" },
              {
                key: "tag",
                brief: "Tag {{ inputs.version }}",
                dependsOn: ["notes"],
              },
            ],
          },
        }),
      },
      respond: () => jsonReply({}),
    });

    const result = await fixture.run([
      "run",
      "template",
      "save-check",
      "release-checklist",
      "--file",
      "/t.json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(fixture.requests).toHaveLength(0);
    const output = JSON.parse(result.stderr || result.stdout);
    expect(
      output.error.issues.map((issue: { path: string[] }) => issue.path),
    ).toEqual([["workflow.contexts.0.brief"], ["workflow.contexts.1.brief"]]);
  });

  it("refuses a setting written inside a context, saying where settings go", async () => {
    const fixture = createCcRuntimeFixture({
      files: {
        "/t.json": JSON.stringify({
          ...content,
          workflow: {
            contexts: [{ key: "notes", brief: "Notes", checks: ["lint"] }],
          },
        }),
      },
      respond: () => jsonReply({}),
    });

    const result = await fixture.run(
      [
        "run",
        "template",
        "save-check",
        "release-checklist",
        "--file",
        "/t.json",
      ],
      "text",
    );

    expect(result.exitCode).not.toBe(0);
    expect(fixture.requests).toHaveLength(0);
    expect(result.stderr).toContain("checks is a setting");
  });

  it("finds a template's tier by id and prints its content ready to save again", async () => {
    const fixture = createCcRuntimeFixture({
      respond: (request) =>
        request.url === LIBRARY
          ? jsonReply({
              items: [
                summary("global", "release-checklist", "Release checklist"),
              ],
              diagnostics: [],
            })
          : jsonReply({ template: record(2), globals }),
    });

    const result = await fixture.run(
      ["run", "template", "show", "release-checklist"],
      "text",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.requests.map((request) => request.url)).toEqual([
      LIBRARY,
      `${LIBRARY}/global/release-checklist`,
    ]);
    expect(JSON.parse(result.stdout)).toEqual(content);
  });

  it("refuses an id both tiers use, naming both templates", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          items: [
            summary("project", "release-checklist", "Our release"),
            summary("global", "release-checklist", "Shared release"),
          ],
          diagnostics: [],
        }),
    });

    const result = await fixture.run(
      ["run", "template", "show", "release-checklist"],
      "text",
    );

    expect(result.exitCode).not.toBe(0);
    expect(fixture.requests).toHaveLength(1);
    expect(result.stderr).toContain(
      'project:release-checklist ("Our release")',
    );
    expect(result.stderr).toContain(
      'global:release-checklist ("Shared release")',
    );
  });

  it("names the unreadable file among two templates that share an id", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          items: [summary("project", "release-checklist", "Our release")],
          diagnostics: [
            {
              tier: "global",
              id: "release-checklist",
              path: "/cc/run-templates/global.shared/release-checklist.json",
              reason: "invalid JSON: Unexpected end",
            },
          ],
        }),
    });

    const result = await fixture.run(
      ["run", "template", "show", "release-checklist"],
      "text",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      'project:release-checklist ("Our release")',
    );
    expect(result.stderr).toContain(
      "/cc/run-templates/global.shared/release-checklist.json",
    );
  });

  it("names the file to fix when the only template with an id cannot be read", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          items: [],
          diagnostics: [
            {
              tier: "project",
              id: "release-checklist",
              path: "/cc/run-templates/cHJvamVjdA/release-checklist.json",
              reason: "invalid JSON: Unexpected end",
            },
          ],
        }),
    });

    const result = await fixture.run(
      ["run", "template", "show", "release-checklist"],
      "text",
    );

    expect(result.exitCode).not.toBe(0);
    expect(fixture.requests).toHaveLength(1);
    expect(result.stderr).toContain(
      "fix or remove /cc/run-templates/cHJvamVjdA/release-checklist.json",
    );
  });

  it("lists templates within the limit, naming the read that shows the rest and each unreadable file", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          items: [
            summary("project", "a", "Alpha"),
            summary("global", "b", "Beta"),
          ],
          diagnostics: [
            {
              tier: "global",
              id: "broken",
              path: "/cc/run-templates/global.shared/broken.json",
              reason: "invalid JSON: Unexpected end",
            },
          ],
        }),
    });

    const result = await fixture.run(
      ["run", "template", "list", "--limit", "1"],
      "text",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("run templates: 2 total, 1 shown");
    expect(result.stdout).toContain("--limit=2");
    expect(result.stdout).toContain("project:a (rev 1) Alpha");
    expect(result.stdout).not.toContain("Beta");
    expect(result.stdout).toContain(
      "fix or remove /cc/run-templates/global.shared/broken.json",
    );
  });

  it("deletes a template at the revision named", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          ok: true,
          tier: "project",
          id: "release-checklist",
          revision: 3,
        }),
    });

    const result = await fixture.run([
      "run",
      "template",
      "delete",
      "release-checklist",
      "--tier",
      "project",
      "--based-on",
      "3",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.requests[0]?.url).toBe(
      `${LIBRARY}/project/release-checklist`,
    );
    expect(fixture.requests[0]?.init.method).toBe("DELETE");
    expect(bodyOf(fixture.requests[0]?.init ?? {})).toEqual({
      expectedRevision: 3,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { revision: 3 } },
    });
  });
});
