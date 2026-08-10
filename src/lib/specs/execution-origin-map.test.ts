import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { materializeDeliveryPlan } from "./delivery-plan-materializer";
import {
  materializationInput,
  pinnedRevisionSnapshot,
} from "./delivery-plan-materializer.fixture";
import { readSpecExecutionOriginMap } from "./execution-origin-map";
import { legacyImportFixture } from "./legacy-import-fixtures";
import { readCompiledOriginMap } from "./compiler";

function materializedDefinition() {
  const result = materializeDeliveryPlan(materializationInput());
  if (!result.ok) {
    throw new Error(result.refusal.instruction);
  }
  return result.value.definition;
}

describe("readSpecExecutionOriginMap", () => {
  it("preserves the legacy compiled-origin path without loading a revision", async () => {
    let snapshotReads = 0;
    const fixture = legacyImportFixture("dynamic-graph-primitives");

    const origins = await readSpecExecutionOriginMap(
      fixture.launchedDefinition,
      async () => {
        snapshotReads += 1;
        return null;
      },
    );

    expect(origins).toEqual(readCompiledOriginMap(fixture.launchedDefinition));
    expect(snapshotReads).toBe(0);
  });

  it("reads delivery-plan provenance using the pinned evergreen revision", async () => {
    const snapshot = pinnedRevisionSnapshot();

    const origins = await readSpecExecutionOriginMap(
      materializedDefinition(),
      async (revisionId) =>
        revisionId === snapshot.revision.id ? snapshot : null,
    );

    expect(
      origins.map((origin) => ({
        contextId: origin.contextId,
        taskElementId: origin.taskElementId,
        criterionElementIds: origin.criterionElementIds,
        criterionHandles: origin.criterionHandles,
      })),
    ).toEqual([
      {
        contextId: "ctx-copy",
        taskElementId: "task-render",
        criterionElementIds: ["criterion-copy", "criterion-determinism"],
        criterionHandles: ["R1.1", "R1.2"],
      },
      {
        contextId: "ctx-copy",
        taskElementId: "task-determinism",
        criterionElementIds: ["criterion-copy", "criterion-determinism"],
        criterionHandles: ["R1.1", "R1.2"],
      },
      {
        contextId: "ctx-preflight",
        taskElementId: "task-preflight",
        criterionElementIds: ["criterion-preflight"],
        criterionHandles: ["R2.1"],
      },
      {
        contextId: "ctx-closeout",
        taskElementId: "task-closeout",
        criterionElementIds: [],
        criterionHandles: [],
      },
    ]);
    expect(origins[0]?.validationStrategies).toEqual({
      "criterion-copy": {
        kinds: ["validator_verdict"],
        note: "A byte-equality test over the rendered contract.",
      },
      "criterion-determinism": { kinds: ["test_run"] },
    });
    expect(origins[0]?.criterionBriefs).toEqual({
      "criterion-copy":
        "The materializer copies the authored acceptance contract verbatim.",
      "criterion-determinism":
        "Materializing the same snapshot twice is byte-identical.",
    });
  });

  it("refuses a delivery-plan definition whose pinned revision is missing", async () => {
    await expect(
      readSpecExecutionOriginMap(materializedDefinition(), async () => null),
    ).rejects.toThrow(
      "Delivery plan attempt-materializer pins missing revision revision-materializer-2",
    );
  });

  it("keeps a taskless context without inventing a task identity", async () => {
    const snapshot = pinnedRevisionSnapshot();
    const input = materializationInput();
    const result = materializeDeliveryPlan({
      ...input,
      document: {
        ...input.document,
        tasks: input.document.tasks.filter(
          (task) => task.contextId !== "ctx-closeout",
        ),
      },
    });
    if (!result.ok) {
      throw new Error(result.refusal.instruction);
    }

    const origins = await readSpecExecutionOriginMap(
      result.value.definition,
      async () => snapshot,
    );

    expect(
      origins.find((origin) => origin.contextId === "ctx-closeout"),
    ).toEqual({
      contextId: "ctx-closeout",
      taskElementId: null,
      taskHandle: null,
      touchedPaths: [],
      criterionElementIds: [],
      criterionHandles: [],
      validationStrategies: {},
      criterionBriefs: {},
    });
  });
});

describe("execution origin-map production wiring source ratchet", () => {
  it.each([
    "production-workflow-composition.ts",
    "service-factory.ts",
    "route-handlers.ts",
  ])("keeps %s on the sole shared legacy-or-DPA reader", (fileName) => {
    const source = readFileSync(new URL(fileName, import.meta.url), "utf8");

    expect(source).toContain("readSpecExecutionOriginMap");
    expect(source).not.toContain("readCompiledOriginMap");
  });
});
