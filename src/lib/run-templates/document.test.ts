import { describe, expect, it } from "vitest";
import {
  materializeRunTemplate,
  runTemplateContentSchema,
  validateRunTemplate,
  type RunTemplateContent,
} from "./document";
import { runTemplateParameterValuesSchema } from "@/lib/runs/schemas";

const writer = { tier: "project" as const, id: "api-writer" };
const other = { tier: "global" as const, id: "docs-writer" };
const reviewer = { tier: "builtin" as const, id: "general-reviewer" };

function template(
  workflow: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Ship a fix",
    description: "Fix, then document",
    parameters: [
      { name: "ticket", description: "Ticket number", required: true },
      { name: "note", description: "Extra guidance", required: false },
    ],
    defaults: {},
    workflow,
    ...overrides,
  };
}

function content(raw: Record<string, unknown>): RunTemplateContent {
  return runTemplateContentSchema.parse(raw);
}

describe("run template materialisation", () => {
  it("gives each context the template's settings unless it overrides one, which then replaces it whole", () => {
    const materialized = materializeRunTemplate(
      content(
        template(
          {
            contexts: [
              { key: "fix", brief: "Fix {{inputs.ticket}}" },
              {
                key: "docs",
                brief: "Document {{inputs.ticket}}. {{inputs.note}}",
                dependsOn: ["fix"],
                settings: { implementer: { profile: other }, reviewers: [] },
              },
            ],
          },
          {
            defaults: {
              implementer: { profile: writer, backend: "codex" },
              reviewers: [{ authority: "blocking", profile: reviewer }],
              humanApproval: true,
            },
          },
        ),
      ),
      { ticket: "42", note: "" },
    );

    expect(materialized).toEqual({
      ok: true,
      request: {
        title: "Ship a fix",
        contexts: [
          {
            key: "fix",
            brief: "Fix 42",
            profile: writer,
            backend: "codex",
            reviewers: [{ authority: "blocking", profile: reviewer }],
            humanApproval: true,
          },
          {
            key: "docs",
            brief: "Document 42.",
            dependsOn: ["fix"],
            profile: other,
            reviewers: [],
            humanApproval: true,
          },
        ],
      },
    });
  });

  it("leaves every setting neither tier sets out of the request, for the resolver's global tier", () => {
    const materialized = materializeRunTemplate(
      content(template({ contexts: [{ key: "fix", brief: "Fix it" }] })),
      { ticket: "42" },
    );

    expect(materialized).toEqual({
      ok: true,
      request: {
        title: "Ship a fix",
        contexts: [{ key: "fix", brief: "Fix it" }],
      },
    });
  });

  it("locates a topology problem at its place in the template", () => {
    const materialized = materializeRunTemplate(
      content(
        template({
          contexts: [
            { key: "fix", brief: "Fix it" },
            { key: "fix", brief: "Fix it again", dependsOn: ["fix"] },
          ],
        }),
      ),
      { ticket: "42" },
    );

    expect(materialized.ok).toBe(false);
    if (materialized.ok) return;
    expect(materialized.issues.map((issue) => issue.path)).toContain(
      "workflow.contexts.1.key",
    );
  });

  it("refuses an owned path a write rule would read as a pattern on save, while a stored template that owns one still reads", () => {
    const raw = template({
      contexts: [
        {
          key: "fix",
          brief: "Fix {{inputs.ticket}}",
          scope: { mode: "owned", paths: ["src/app/[id]"] },
        },
      ],
    });

    const validated = validateRunTemplate(raw);
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues).toEqual([
      {
        path: "workflow.contexts.0.scope.paths.0",
        message: expect.stringContaining('own "src/app"'),
      },
    ]);
    // Refused on save or launch, not when stored content is decoded.
    expect(runTemplateContentSchema.safeParse(raw).success).toBe(true);
  });

  it("locates a problem a setting causes at the tier that set it", () => {
    const concurrent = {
      contexts: [
        {
          key: "api",
          brief: "Build the API",
          scope: { mode: "owned", paths: ["src/api"] },
        },
        {
          key: "ui",
          brief: "Build the UI",
          scope: { mode: "owned", paths: ["src/ui"] },
          settings: { checks: ["lint", "typecheck"] },
        },
      ],
    };
    const materialized = materializeRunTemplate(
      content(template(concurrent, { defaults: { checks: ["typecheck"] } })),
      { ticket: "42" },
    );

    expect(materialized.ok).toBe(false);
    if (materialized.ok) return;
    expect(materialized.issues.map((issue) => issue.path).sort()).toEqual([
      "defaults.checks.0",
      "workflow.contexts.1.settings.checks.0",
      "workflow.contexts.1.settings.checks.1",
    ]);
  });
});

describe("run template launch values", () => {
  const fixTicket = () =>
    content(
      template(
        {
          contexts: [
            { key: "fix", brief: "Fix {{inputs.ticket}} in {{inputs.area}}" },
          ],
        },
        {
          parameters: [
            { name: "ticket", description: "Ticket", required: true },
            { name: "area", description: "Area", required: true },
            { name: "note", description: "Note", required: false },
          ],
        },
      ),
    );

  it("refuses unknown, missing and blank values at their parameters, all at once", () => {
    const materialized = materializeRunTemplate(fixTicket(), {
      ticket: "  ",
      tickt: "42",
    });

    expect(materialized.ok).toBe(false);
    if (materialized.ok) return;
    expect(materialized.issues.map((issue) => issue.path).sort()).toEqual([
      "parameters.area",
      "parameters.ticket",
      "parameters.tickt",
    ]);
  });

  it("keeps every key a launch body sends, so a value named __proto__ is refused rather than dropped", () => {
    const decode = (body: string) =>
      runTemplateParameterValuesSchema.parse(JSON.parse(body));

    expect(
      materializeRunTemplate(
        fixTicket(),
        decode('{"ticket":"42","area":"billing"}'),
      ),
    ).toMatchObject({
      ok: true,
      request: { contexts: [{ brief: "Fix 42 in billing" }] },
    });
    const refused = materializeRunTemplate(
      fixTicket(),
      decode('{"ticket":"42","area":"billing","__proto__":"x"}'),
    );
    expect(refused).toEqual({
      ok: false,
      issues: [
        {
          path: "parameters.__proto__",
          message: expect.stringContaining("__proto__"),
        },
      ],
    });
  });
});

describe("run template validation", () => {
  it("accepts a template whose workflow launches with its required parameters filled", () => {
    const raw = template({
      contexts: [
        { key: "fix", brief: "Fix {{inputs.ticket}} {{inputs.note}}" },
      ],
    });

    expect(validateRunTemplate(raw)).toEqual({
      ok: true,
      content: content(raw),
    });
  });

  it("refuses a setting written inside a context, naming where settings go", () => {
    const validated = validateRunTemplate(
      template({
        contexts: [{ key: "fix", brief: "Fix it", checks: ["lint"] }],
      }),
    );

    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues).toEqual([
      {
        path: "workflow.contexts.0",
        message: expect.stringContaining("settings"),
      },
    ]);
  });

  it("refuses a document that names a run's revision", () => {
    const validated = validateRunTemplate(
      template({
        contexts: [{ key: "fix", brief: "Fix it" }],
        documents: [
          {
            path: "notes.md",
            contents: "x",
            description: "Notes",
            revision: 2,
          },
        ],
      }),
    );

    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues.map((issue) => issue.path)).toEqual([
      "workflow.documents.0",
    ]);
  });

  it("refuses an optional parameter that would leave a required field empty when omitted", () => {
    const validated = validateRunTemplate(
      template({ contexts: [{ key: "fix", brief: "{{inputs.note}}" }] }),
    );

    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues.map((issue) => issue.path)).toEqual([
      "workflow.contexts.0.brief",
    ]);
  });

  it("reports every token problem at once", () => {
    const validated = validateRunTemplate(
      template({
        contexts: [
          { key: "fix", brief: "Fix {{inputs.tickt}}" },
          {
            key: "docs",
            brief: "Docs",
            dependsOn: ["fix"],
            title: "{{ticket}}",
          },
        ],
      }),
    );

    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues.map((issue) => issue.path)).toEqual([
      "workflow.contexts.0.brief",
      "workflow.contexts.1.title",
    ]);
  });

  it("refuses a parameter declared twice", () => {
    const validated = validateRunTemplate(
      template(
        { contexts: [{ key: "fix", brief: "Fix {{inputs.ticket}}" }] },
        {
          parameters: [
            { name: "ticket", description: "Ticket", required: true },
            { name: "ticket", description: "Again", required: false },
          ],
        },
      ),
    );

    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues.map((issue) => issue.path)).toEqual([
      "parameters.1.name",
    ]);
  });

  it("refuses a parameter named __proto__, which no launch body could supply", () => {
    const validated = validateRunTemplate(
      template(
        { contexts: [{ key: "fix", brief: "Fix {{inputs.__proto__}}" }] },
        {
          parameters: [
            { name: "__proto__", description: "Ticket", required: true },
          ],
        },
      ),
    );

    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues.map((issue) => issue.path)).toEqual([
      "parameters.0.name",
    ]);
  });

  it("refuses a name longer than a run title can be", () => {
    const validated = validateRunTemplate(
      template(
        { contexts: [{ key: "fix", brief: "Fix it" }] },
        { name: "x".repeat(121) },
      ),
    );

    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues.map((issue) => issue.path)).toEqual(["name"]);
  });
});
