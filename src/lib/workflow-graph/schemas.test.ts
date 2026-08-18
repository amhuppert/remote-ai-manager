import { describe, expect, it } from "vitest";

import { stableStringify } from "@/lib/state-store/serialization";

import type { CriterionRecord } from "./criteria/criterion-records";
import { resolvedWorkflowSemanticDefinitionSchema } from "./definition-schemas";
import { assertExecutionSupported } from "./schema-cutover-guard";
import { graphWorkflowExecutionSchema } from "./schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { workingDefinitionHash } from "./working-definition-hash";

const RECORDS: CriterionRecord[] = [
  { id: "records-survive-reload", statement: "Records reload verbatim." },
  { id: "hash-is-stable", statement: "The stored hash does not move." },
];

/**
 * The decisive no-read-renormalization regression: a stored execution loads
 * through the real decode boundary (`assertExecutionSupported`), its working
 * definition re-serializes byte-identical, and `workingDefinitionHash` — the
 * identity every amendment audit row compares against — does not move. Run
 * for BOTH criteria shapes so neither the legacy prose branch nor the records
 * branch of the union ever grows a read-time rewrite.
 */
function expectStoredExecutionReloadsVerbatim(
  acceptanceCriteria: string | CriterionRecord[],
): void {
  const workingDefinition = resolvedWorkflowSemanticDefinitionSchema.parse(
    createResolvedWorkflowDefinition({
      executionContexts:
        createResolvedWorkflowDefinition().executionContexts.map(
          (context, index) =>
            index === 0 ? { ...context, acceptanceCriteria } : context,
        ),
    }),
  );
  const execution = graphWorkflowExecutionSchema.parse(
    createWorkflowExecution({ workingDefinition }),
  );
  const storedBytes = JSON.stringify(execution);
  const storedDefinitionBytes = stableStringify(execution.workingDefinition);
  const storedHash = workingDefinitionHash(execution.workingDefinition);

  const reloaded = assertExecutionSupported(JSON.parse(storedBytes));

  expect(stableStringify(reloaded.workingDefinition)).toBe(
    storedDefinitionBytes,
  );
  expect(workingDefinitionHash(reloaded.workingDefinition)).toBe(storedHash);
  expect(
    reloaded.workingDefinition.executionContexts[0]?.acceptanceCriteria,
  ).toEqual(acceptanceCriteria);
}

describe("stored working-definition acceptance criteria (no-read-renormalization)", () => {
  it("reloads a prose-criteria working definition byte-identical with an unchanged workingDefinitionHash", () => {
    expectStoredExecutionReloadsVerbatim(
      "The stored prose survives reload untouched.",
    );
  });

  it("reloads a records-criteria working definition byte-identical with an unchanged workingDefinitionHash", () => {
    expectStoredExecutionReloadsVerbatim(RECORDS);
  });
});
