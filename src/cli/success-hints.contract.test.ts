import { describe, expect, it } from "vitest";

import { deliveryPlanNextAct } from "@/lib/specs/delivery-plan-next-act";
import type { DeliveryPlanAttemptView } from "@/lib/specs/delivery-plan-views";

import {
  allHelpEntries,
  buildHelpRegistry,
  resolveHelpEntry,
  successHintRows,
} from "./help-registry";

const ENTRIES = allHelpEntries();
const REGISTRY = buildHelpRegistry(ENTRIES);

/**
 * The CLI-owned rows, read back through the registry rather than off a
 * standalone constant: the help entry is where a success hint is declared, so
 * a row nobody attached to an entry is a row this sweep must not see.
 */
const CLI_OWNED_ROWS = successHintRows(ENTRIES);

/** Whether the registry carries this exact command path, not merely a parent. */
function resolvesExactly(tokens: readonly string[]): boolean {
  const entry = resolveHelpEntry(REGISTRY, [...tokens]);
  return entry !== undefined && entry.path.length === tokens.length;
}

/**
 * The command each attempt status sends its reader to. Declared here rather
 * than parsed out of the rendered text: the point of the sweep is that a
 * renamed verb fails, and a parser lenient enough to skip a slug is lenient
 * enough to skip the rename too.
 */
const ATTEMPT_STATUS_ROWS: readonly {
  status: DeliveryPlanAttemptView["status"];
  names: readonly string[];
}[] = [
  { status: "draft", names: ["workflow", "validate"] },
  { status: "proposed", names: ["spec", "plan", "sign-off"] },
  { status: "approved", names: ["spec", "start"] },
  { status: "parked", names: ["spec", "plan", "sign-off"] },
  { status: "launched", names: ["spec", "status"] },
  { status: "abandoned", names: ["spec", "plan", "open"] },
];

function nextActFor(status: DeliveryPlanAttemptView["status"]) {
  return deliveryPlanNextAct({
    status,
    specSlug: "native-sdd",
    workflowDefinitionId: "managed-wf",
    signOffRequiresHuman: true,
    parkedApproved: false,
  });
}

/**
 * The launch sequence walked end to end (#80 design 3.6). Both halves are
 * checked here — the server's attempt-status rows and the CLI's own — because
 * the defect the chain exists to prevent is a gap BETWEEN them: a receipt whose
 * successor nobody authored, or one naming a verb the registry no longer has.
 */
describe("the launch hint chain", () => {
  it("declares the CLI-owned rows exactly once, on their own help entries", () => {
    // Sorted, because the registry's order is the command order, not the
    // chain's; what the sweep pins is the SET, and that each row appears once
    // even though `workflow replace` and `workflow edit` both declare two.
    expect([...CLI_OWNED_ROWS.map((row) => row.after)].sort()).toEqual(
      [
        "spec abandon --execution",
        "spec start",
        "workflow replace or edit on a managed draft (findings refuse propose)",
        "workflow replace or edit on a managed draft (nothing refuses propose)",
        "workflow validate --definition (findings refuse propose)",
        "workflow validate --definition (nothing refuses propose)",
      ].sort(),
    );
  });

  it("declares every CLI-owned row on the entry whose receipt renders it", () => {
    const declaredBy = new Map<string, string[]>();
    for (const entry of ENTRIES) {
      for (const row of entry.successHints ?? []) {
        declaredBy.set(row.after, [
          ...(declaredBy.get(row.after) ?? []),
          entry.path.join(" "),
        ]);
      }
    }

    expect(Object.fromEntries(declaredBy)).toEqual({
      "workflow validate --definition (nothing refuses propose)": [
        "workflow validate",
      ],
      "workflow validate --definition (findings refuse propose)": [
        "workflow validate",
      ],
      "workflow replace or edit on a managed draft (nothing refuses propose)": [
        "workflow replace",
        "workflow edit",
      ],
      "workflow replace or edit on a managed draft (findings refuse propose)": [
        "workflow replace",
        "workflow edit",
      ],
      "spec start": ["spec start"],
      "spec abandon --execution": ["spec abandon"],
    });
  });

  it("names a resolvable command in every CLI-owned row", () => {
    const unresolved = CLI_OWNED_ROWS.filter(
      (row) => !resolvesExactly(row.names),
    ).map((row) => row.names.join(" "));

    expect(
      unresolved,
      "a chain row names a command the help registry does not have",
    ).toEqual([]);
  });

  it("renders each CLI-owned row's own command into its hint text", () => {
    for (const row of CLI_OWNED_ROWS) {
      expect(row.sample(), row.after).toContain(`cctl ${row.names.join(" ")} `);
    }
  });

  it("names a resolvable command in every attempt-status row", () => {
    const unresolved = ATTEMPT_STATUS_ROWS.filter(
      (row) => !resolvesExactly(row.names),
    ).map((row) => row.names.join(" "));

    expect(unresolved).toEqual([]);
  });

  it("renders each attempt-status row's own command into its next act", () => {
    for (const row of ATTEMPT_STATUS_ROWS) {
      expect(nextActFor(row.status).command, row.status).toContain(
        `cctl ${row.names.join(" ")} `,
      );
    }
  });

  it("carries the server-authored attempt-status rows unchanged", () => {
    expect(nextActFor("draft")).toEqual({
      actor: "agent",
      command:
        "author .cc/temp/plan.json with the graph-workflow-planning skill, then cctl workflow validate --file .cc/temp/plan.json --definition managed-wf",
      reason:
        "A managed draft is authored as an ordinary plan.json; the preflight reports everything that refuses propose before you replace it.",
    });
    expect(nextActFor("proposed")).toMatchObject({
      actor: "human",
      command: "cctl spec plan sign-off native-sdd",
    });
    expect(nextActFor("approved")).toMatchObject({
      actor: "agent",
      command: "cctl spec start native-sdd",
    });
  });

  it("no longer sends a draft author to spec plan edit", () => {
    const act = nextActFor("draft");

    expect(`${act.command} ${act.reason}`).not.toContain("spec plan edit");
    expect(`${act.command} ${act.reason}`).not.toContain("workflow edit");
  });
});
