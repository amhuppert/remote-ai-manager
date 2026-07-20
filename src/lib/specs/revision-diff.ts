import { z } from "zod";

import { specElementKindSchema, specElementPayloadSchema } from "./schemas";

export const revisionElementSchema = z
  .object({
    elementId: z.string().min(1),
    parentElementId: z.string().min(1).nullable(),
    payloadHash: z.string().min(1),
    payload: specElementPayloadSchema,
  })
  .strict();
export type RevisionElement = z.infer<typeof revisionElementSchema>;

export const elementClassificationSchema = z
  .object({
    elementId: z.string().min(1),
    kind: specElementKindSchema,
    classification: z.enum(["unchanged", "modified", "removed"]),
    directlyChanged: z.boolean(),
  })
  .strict();
export type ElementClassification = z.infer<typeof elementClassificationSchema>;

export const semanticChangeSchema = z
  .object({
    elementId: z.string().min(1),
    kind: specElementKindSchema,
    change: z.enum(["added", "modified", "removed"]),
    summary: z.string().min(1),
  })
  .strict();
export type SemanticChange = z.infer<typeof semanticChangeSchema>;

export const revisionDiffResultSchema = z
  .object({
    classifications: z.array(elementClassificationSchema),
    changeList: z.array(semanticChangeSchema),
    planStale: z.boolean(),
  })
  .strict();
export type RevisionDiffResult = z.infer<typeof revisionDiffResultSchema>;

export function diffRevisions(
  baseRows: RevisionElement[],
  draftRows: RevisionElement[],
): RevisionDiffResult {
  const baseById = indexRows(baseRows);
  const draftById = indexRows(draftRows);
  const classifications: ElementClassification[] = [];
  const classificationById = new Map<string, ElementClassification>();

  for (const draftRow of draftRows) {
    const baseRow = baseById.get(draftRow.elementId);
    const classification: ElementClassification = {
      elementId: draftRow.elementId,
      kind: draftRow.payload.kind,
      classification:
        baseRow?.payloadHash === draftRow.payloadHash
          ? "unchanged"
          : "modified",
      directlyChanged: baseRow?.payloadHash !== draftRow.payloadHash,
    };
    classifications.push(classification);
    classificationById.set(classification.elementId, classification);
  }

  for (const baseRow of baseRows) {
    if (draftById.has(baseRow.elementId)) {
      continue;
    }

    const classification: ElementClassification = {
      elementId: baseRow.elementId,
      kind: baseRow.payload.kind,
      classification: "removed",
      directlyChanged: true,
    };
    classifications.push(classification);
    classificationById.set(classification.elementId, classification);
  }

  propagateCriterionChanges(
    classifications,
    classificationById,
    baseById,
    draftById,
  );

  return {
    classifications,
    changeList: classifications.flatMap((classification) => {
      if (classification.classification === "unchanged") {
        return [];
      }

      return [semanticChangeFor(classification, baseById, draftById)];
    }),
    planStale: isPlanStale(baseById, draftById),
  };
}

function indexRows(rows: RevisionElement[]): Map<string, RevisionElement> {
  const index = new Map<string, RevisionElement>();
  for (const row of rows) {
    if (index.has(row.elementId)) {
      throw new Error(`Duplicate revision element id: ${row.elementId}`);
    }
    index.set(row.elementId, row);
  }

  return index;
}

function propagateCriterionChanges(
  classifications: ElementClassification[],
  classificationById: Map<string, ElementClassification>,
  baseById: Map<string, RevisionElement>,
  draftById: Map<string, RevisionElement>,
): void {
  for (const classification of classifications) {
    if (
      classification.kind !== "criterion" ||
      classification.classification === "unchanged"
    ) {
      continue;
    }

    const baseParentId = baseById.get(
      classification.elementId,
    )?.parentElementId;
    const draftParentId = draftById.get(
      classification.elementId,
    )?.parentElementId;
    const parentIds = new Set(
      [baseParentId, draftParentId].filter(
        (parentId): parentId is string =>
          parentId !== null && parentId !== undefined,
      ),
    );

    for (const parentId of parentIds) {
      const parentClassification = classificationById.get(parentId);
      if (
        parentClassification?.kind !== "requirement" ||
        parentClassification.classification !== "unchanged"
      ) {
        continue;
      }

      parentClassification.classification = "modified";
      parentClassification.directlyChanged = false;
    }
  }
}

function semanticChangeFor(
  classification: ElementClassification,
  baseById: Map<string, RevisionElement>,
  draftById: Map<string, RevisionElement>,
): SemanticChange {
  const baseRow = baseById.get(classification.elementId);
  const draftRow = draftById.get(classification.elementId);
  const change =
    baseRow === undefined
      ? "added"
      : draftRow === undefined
        ? "removed"
        : "modified";
  const payload = draftRow?.payload ?? baseRow?.payload;
  if (payload === undefined) {
    throw new Error(`Missing revision element: ${classification.elementId}`);
  }

  return {
    elementId: classification.elementId,
    kind: classification.kind,
    change,
    summary:
      classification.kind === "requirement" && !classification.directlyChanged
        ? `Modified requirement criteria: ${payloadLabel(payload)}`
        : `${changeVerb(change)} ${kindLabel(classification.kind)}: ${payloadLabel(payload)}`,
  };
}

function isPlanStale(
  baseById: Map<string, RevisionElement>,
  draftById: Map<string, RevisionElement>,
): boolean {
  const elementIds = new Set([...baseById.keys(), ...draftById.keys()]);
  for (const elementId of elementIds) {
    const baseRow = baseById.get(elementId);
    const draftRow = draftById.get(elementId);
    const basePayload = baseRow?.payload;
    const draftPayload = draftRow?.payload;
    const baseIsTask = basePayload?.kind === "task";
    const draftIsTask = draftPayload?.kind === "task";

    if (baseIsTask !== draftIsTask) {
      return true;
    }
    if (
      !baseIsTask ||
      !draftIsTask ||
      baseRow === undefined ||
      draftRow === undefined
    ) {
      continue;
    }

    if (baseRow.payloadHash !== draftRow.payloadHash) {
      return true;
    }
  }

  return false;
}

function changeVerb(change: SemanticChange["change"]): string {
  switch (change) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "removed":
      return "Removed";
  }
}

function kindLabel(kind: SemanticChange["kind"]): string {
  return kind === "criterion" ? "acceptance criterion" : kind;
}

function payloadLabel(payload: RevisionElement["payload"]): string {
  switch (payload.kind) {
    case "section":
      return payload.title;
    case "requirement":
      return payload.statement;
    case "criterion":
      return payload.text;
    case "decision":
    case "task":
      return payload.title;
  }
}
