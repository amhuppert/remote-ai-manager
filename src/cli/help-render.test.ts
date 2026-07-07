import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildHelpJson,
  renderGroupHelpText,
  renderLeafHelpText,
  renderTopUsageText,
} from "./help-render";
import type { CommandHelpEntry } from "./help-types";

const leaf: CommandHelpEntry = {
  path: ["workflow", "create"],
  summary: "create a graph workflow from a plan file",
  description: "Create a workflow definition from a validated plan file.",
  usage: ["cctl workflow create --file plan.json [--json]"],
  flags: [
    {
      name: "file",
      kind: "value",
      valuePlaceholder: "<path>",
      description: "plan JSON produced per the graph-workflow-planning skill",
    },
  ],
  examples: [
    {
      invocation: "cctl workflow validate --file plan.json",
      explanation: "always validate first — exit 2 lists issues one per line",
    },
    {
      invocation: "cctl workflow create --file plan.json",
      explanation:
        "returns the workflow id; start it with 'cctl workflow start <id>'",
    },
  ],
  domainContext: "A workflow is a DAG of execution contexts.",
  related: [
    {
      command: "workflow validate",
      oneLiner: "pre-flight a plan without creating anything",
    },
    { command: "workflow start", oneLiner: "start a created workflow" },
  ],
  skills: [
    {
      name: "graph-workflow-planning",
      loadWhen: "before authoring or revising plan.json",
      path: ".claude/skills/graph-workflow-planning/SKILL.md",
    },
  ],
};

describe("renderLeafHelpText", () => {
  it("opens with the 'cctl <path> — <summary>' header line", () => {
    const text = renderLeafHelpText(leaf);
    expect(
      text.startsWith("cctl workflow create — create a graph workflow"),
    ).toBe(true);
  });

  it("renders sections in the doc-04 §3.2 order", () => {
    const text = renderLeafHelpText(leaf);
    const order = [
      "usage:",
      "flags:",
      "examples:",
      "context:",
      "related:",
      "skills:",
    ];
    const positions = order.map((section) => text.indexOf(section));
    expect(positions.every((p) => p >= 0)).toBe(true);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("puts the description between the header and usage", () => {
    const text = renderLeafHelpText(leaf);
    const descPos = text.indexOf("Create a workflow definition");
    expect(descPos).toBeGreaterThan(0);
    expect(descPos).toBeLessThan(text.indexOf("usage:"));
  });

  it("renders each example as a '$' invocation with an indented explanation", () => {
    const text = renderLeafHelpText(leaf);
    expect(text).toContain("  $ cctl workflow validate --file plan.json");
    expect(text).toContain(
      "      always validate first — exit 2 lists issues one per line",
    );
  });

  it("renders the domainContext under context:", () => {
    const text = renderLeafHelpText(leaf);
    const ctxPos = text.indexOf("context:");
    expect(text.indexOf("A workflow is a DAG")).toBeGreaterThan(ctxPos);
  });

  it("ends with a single global-flags pointer line", () => {
    const text = renderLeafHelpText(leaf);
    expect(text.trimEnd().endsWith("global flags: run 'cctl --help'")).toBe(
      true,
    );
    // exactly one pointer line, never a repeated global-flags block
    const matches = text.match(/global flags:/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("omits empty sections entirely rather than rendering an empty header", () => {
    const bare: CommandHelpEntry = {
      path: ["doctor"],
      summary: "check connectivity, auth, and build parity",
      description: "Run it whenever a command exits 3.",
      usage: ["cctl doctor"],
      flags: [],
      examples: [{ invocation: "cctl doctor", explanation: "diagnose exit 3" }],
      related: [],
    };
    const text = renderLeafHelpText(bare);
    // line-anchored so the always-present "global flags:" pointer is not a false positive
    expect(text).not.toMatch(/^flags:/m);
    expect(text).not.toMatch(/^related:/m);
    expect(text).not.toMatch(/^skills:/m);
    expect(text).not.toMatch(/^context:/m);
    // still renders the sections it does have
    expect(text).toContain("usage:");
    expect(text).toContain("examples:");
  });

  it("renders dynamic context blocks passed through the seam", () => {
    const text = renderLeafHelpText(leaf, [
      { title: "dev servers", body: "web — running (http://localhost:5010)" },
    ]);
    const ctxPos = text.indexOf("context:");
    expect(ctxPos).toBeGreaterThan(0);
    expect(text.indexOf("web — running")).toBeGreaterThan(ctxPos);
  });
});

describe("renderGroupHelpText", () => {
  const group: CommandHelpEntry = {
    path: ["dev"],
    summary: "list, ensure, and stop dev servers",
    description: "Manage this session's dev servers.",
    usage: ["cctl dev <list|ensure|stop>"],
    flags: [],
    examples: [],
    related: [],
  };
  const children: CommandHelpEntry[] = [
    {
      path: ["dev", "list"],
      summary: "show configured servers with status and URLs",
      description: "d",
      usage: ["cctl dev list"],
      flags: [],
      examples: [{ invocation: "cctl dev list", explanation: "e" }],
      related: [],
    },
    {
      path: ["dev", "ensure"],
      summary: "start a server and block until it is live",
      description: "d",
      usage: ["cctl dev ensure"],
      flags: [],
      examples: [{ invocation: "cctl dev ensure", explanation: "e" }],
      related: [],
    },
  ];

  it("opens with the group header and lists one line per child", () => {
    const text = renderGroupHelpText(group, children);
    expect(
      text.startsWith("cctl dev — list, ensure, and stop dev servers"),
    ).toBe(true);
    // child command paths are alignment-padded before the em dash (like related:)
    expect(text).toMatch(
      /dev list\s+— show configured servers with status and URLs/,
    );
    expect(text).toMatch(
      /dev ensure\s+— start a server and block until it is live/,
    );
  });

  it("does not render leaf-only sections (usage/flags/examples)", () => {
    const text = renderGroupHelpText(group, children);
    // line-anchored so the always-present "global flags:" pointer is not a false positive
    expect(text).not.toMatch(/^usage:/m);
    expect(text).not.toMatch(/^flags:/m);
    expect(text).not.toMatch(/^examples:/m);
  });
});

describe("renderTopUsageText", () => {
  const level1: CommandHelpEntry[] = [
    {
      path: ["docs"],
      summary: "register, list, and delete reference documents",
      description: "d",
      usage: ["cctl docs <register|list|delete>"],
      flags: [],
      examples: [],
      related: [],
    },
    {
      path: ["dev"],
      summary: "list, ensure, and stop dev servers",
      description: "d",
      usage: ["cctl dev <list|ensure|stop>"],
      flags: [],
      examples: [],
      related: [],
    },
  ];

  it("lists each level-1 summary under commands: and keeps the global-flags block", () => {
    const text = renderTopUsageText(level1);
    expect(text).toContain("usage: cctl <command> [flags]");
    expect(text).toContain("commands:");
    expect(text).toContain("register, list, and delete reference documents");
    expect(text).toContain("list, ensure, and stop dev servers");
    expect(text).toContain("global flags:");
    expect(text).toContain("--server <url>");
    expect(text).toContain("--json");
  });
});

const helpJsonSchema = z.object({
  ok: z.literal(true),
  help: z
    .object({
      command: z.string(),
      summary: z.string(),
      description: z.string(),
      usage: z.array(z.string()),
      flags: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(["value", "boolean"]),
          valuePlaceholder: z.string().optional(),
          description: z.string(),
          repeatable: z.boolean().optional(),
        }),
      ),
      examples: z.array(
        z.object({ invocation: z.string(), explanation: z.string() }),
      ),
      domainContext: z.string().optional(),
      related: z.array(z.object({ command: z.string(), oneLiner: z.string() })),
      skills: z
        .array(
          z.object({
            name: z.string(),
            loadWhen: z.string(),
            path: z.string(),
          }),
        )
        .optional(),
      context: z
        .object({
          blocks: z.array(z.object({ title: z.string(), body: z.string() })),
        })
        .optional(),
    })
    .strict(),
});

describe("buildHelpJson", () => {
  it("produces {ok, help:{…structured entry…}} per doc-04 §3.3", () => {
    const parsed = helpJsonSchema.safeParse(buildHelpJson(leaf));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.help.command).toBe("workflow create");
      expect(parsed.data.help.flags[0]?.name).toBe("file");
    }
  });

  it("carries no duplicated rendered-text field", () => {
    const { help } = buildHelpJson(leaf);
    expect("rendered" in help).toBe(false);
    expect(help.usage).toBeInstanceOf(Array); // usage is the structured array, not a text blob
  });

  it("includes context.blocks when dynamic blocks are supplied (doc 04 §3.3)", () => {
    const blocks = [{ title: "dev servers", body: "web — running" }];
    const parsed = helpJsonSchema.safeParse(buildHelpJson(leaf, blocks));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.help.context).toEqual({ blocks });
    }
  });

  it("omits context entirely when no dynamic blocks are supplied", () => {
    const { help } = buildHelpJson(leaf);
    expect("context" in help).toBe(false);
  });

  it("omits context entirely for an empty block list (byte-identical to no-arg)", () => {
    expect(JSON.stringify(buildHelpJson(leaf, []))).toBe(
      JSON.stringify(buildHelpJson(leaf)),
    );
  });

  it("omits optional fields (domainContext/skills) when absent", () => {
    const bare: CommandHelpEntry = {
      path: ["version"],
      summary: "print the cctl build stamp",
      description: "Print the cctl build stamp.",
      usage: ["cctl version"],
      flags: [],
      examples: [
        { invocation: "cctl version", explanation: "print the stamp" },
      ],
      related: [],
    };
    const { help } = buildHelpJson(bare);
    expect("domainContext" in help).toBe(false);
    expect("skills" in help).toBe(false);
  });
});
