import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import type { WorkflowSemanticDefinition } from "../definition-schemas";

/**
 * The D6 catalog gate (R1.1).
 *
 * Every pattern proof asserts its own semantics; this file asserts the property
 * the CATALOG has to hold as a set — that the six canonical vision patterns and
 * the approved composite exist as checked-in plan documents, and that each one
 * is a plan `cctl workflow validate` / `cctl workflow create` accepts, with
 * explicit placement on every authored context and no warning left unexplained.
 *
 * It reads the directory rather than a hand-listed set of paths, so a plan
 * added or deleted without a decision shows up here as a failure instead of
 * quietly widening or narrowing the catalog.
 */

const CATALOG_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The catalog, by file, mapped to the vision pattern each file expresses. The
 * mapping is the point: `docs/VISION.md` names six patterns, and D6 adds one
 * approved composite, so a catalog that does not cover exactly these has either
 * lost a pattern or grown one nobody approved.
 */
const CATALOG = [
  { file: "classify-and-act.plan.json", pattern: "Classify-And-Act" },
  { file: "fanout-and-synthesize.plan.json", pattern: "Fanout-And-Synthesize" },
  {
    file: "adversarial-verification.plan.json",
    pattern: "Adversarial Verification",
  },
  { file: "generate-and-filter.plan.json", pattern: "Generate-And-Filter" },
  { file: "tournament.plan.json", pattern: "Tournament" },
  { file: "loop-until-done.plan.json", pattern: "Loop Until Done" },
  {
    file: "fanout-adversarial-composite.plan.json",
    pattern: "Fanout-And-Synthesize + Adversarial Verification (composite)",
  },
] as const;

function catalogFilesOnDisk(): string[] {
  return readdirSync(CATALOG_DIR)
    .filter((entry) => entry.endsWith(".plan.json"))
    .sort();
}

function readPlan(file: string): unknown {
  return JSON.parse(readFileSync(path.join(CATALOG_DIR, file), "utf8"));
}

function acceptedDefinition(file: string): WorkflowSemanticDefinition {
  const result = validateWorkflowPlan(readPlan(file));
  if (!result.ok) {
    throw new Error(
      `${file} is not an acceptable plan:\n${result.issues
        .map((issue) => `  ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  return result.draft.definition;
}

describe("the D6 pattern catalog (R1.1)", () => {
  it("holds exactly the six vision patterns plus the approved composite", () => {
    expect(catalogFilesOnDisk()).toEqual(
      CATALOG.map((entry) => entry.file).sort(),
    );
  });

  describe.each(CATALOG)("$pattern ($file)", ({ file }) => {
    it("is accepted by the production authoring path with no warnings", () => {
      const result = validateWorkflowPlan(readPlan(file));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
    });

    it("declares explicit placement on every authored context", () => {
      const definition = acceptedDefinition(file);

      // The plan parses, so every placement is well-formed; what this asserts
      // is that the CATALOG never leans on a migration or a default to supply
      // one — every context says where it runs and what it may write.
      const withoutPlacement = definition.executionContexts
        .filter((context) => context.placement === undefined)
        .map((context) => context.id);
      expect(withoutPlacement).toEqual([]);

      // A loop body is cloned per pass, so a body context missing a placement
      // would resurrect deterministic assignment one pass in. An AUTHORED group
      // names its body by reference (`bodyContextIds`) — the versioned template
      // only exists after `resolveLoopGroups` — so the guarantee is that every
      // referenced id resolves to a context the check above already covered.
      const placedContextIds = new Set(
        definition.executionContexts
          .filter((context) => context.placement !== undefined)
          .map((context) => context.id),
      );
      const unplacedBodyContextIds = (definition.loopGroups ?? []).flatMap(
        (group) =>
          group.bodyContextIds.filter((id) => !placedContextIds.has(id)),
      );
      expect(unplacedBodyContextIds).toEqual([]);
    });

    it("gives every read-only context the output contract that is its only delivery channel", () => {
      const definition = acceptedDefinition(file);

      const readOnlyWithoutOutput = definition.executionContexts
        .filter(
          (context) =>
            context.placement?.mode === "readOnly" &&
            context.outputSchema === undefined,
        )
        .map((context) => context.id);
      expect(readOnlyWithoutOutput).toEqual([]);
    });
  });
});
