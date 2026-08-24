import { z } from "zod";

import {
  specAssumptionCitationSnapshotSchema,
  specElementKindSchema,
  specElementPayloadSchema,
  type SpecAssumptionCitationSnapshot,
} from "./schemas";

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
    classification: z.enum(["added", "unchanged", "modified", "removed"]),
    directlyChanged: z.boolean(),
  })
  .strict();
export type ElementClassification = z.infer<typeof elementClassificationSchema>;

const semanticElementChangeSchema = z
  .object({
    elementId: z.string().min(1),
    kind: specElementKindSchema,
    change: z.enum(["added", "modified", "removed"]),
    summary: z.string().min(1),
  })
  .strict();

const semanticCitationChangeSchema = z
  .object({
    elementId: z.string().min(1),
    kind: z.literal("assumption_citation"),
    assumptionId: z.string().min(1),
    change: z.enum([
      "citation_added",
      "citation_removed",
      "citation_snapshot_changed",
    ]),
    summary: z.string().min(1),
  })
  .strict();

const semanticCitationContractChangeSchema = z
  .object({
    elementId: z.literal("revision"),
    kind: z.literal("citation_contract"),
    change: z.literal("citation_contract_changed"),
    summary: z.string().min(1),
  })
  .strict();

export const semanticChangeSchema = z.union([
  semanticElementChangeSchema,
  semanticCitationChangeSchema,
  semanticCitationContractChangeSchema,
]);
export type SemanticChange = z.infer<typeof semanticChangeSchema>;

export const revisionCitationSchema = z
  .object({
    elementId: z.string().min(1),
    assumptionId: z.string().min(1),
    snapshot: specAssumptionCitationSnapshotSchema,
  })
  .strict();
export type RevisionCitation = z.infer<typeof revisionCitationSchema>;

export interface RevisionCitationDiffContext {
  readonly baseCitationContractVersion: 1 | 2;
  readonly draftCitationContractVersion: 1 | 2;
  readonly baseCitations: readonly RevisionCitation[];
  readonly draftCitations: readonly RevisionCitation[];
}

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
  citationContext?: RevisionCitationDiffContext,
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
        baseRow === undefined
          ? "added"
          : baseRow.payloadHash === draftRow.payloadHash
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

  const citationChanges =
    citationContext === undefined ? [] : diffRevisionCitations(citationContext);
  const citationChangedElementIds = new Set(
    citationChanges.flatMap((change) =>
      change.kind === "assumption_citation" ? [change.elementId] : [],
    ),
  );
  for (const elementId of citationChangedElementIds) {
    const classification = classificationById.get(elementId);
    if (
      classification !== undefined &&
      classification.classification === "unchanged"
    ) {
      classification.classification = "modified";
      classification.directlyChanged = true;
    }
  }

  propagateCriterionChanges(
    classifications,
    classificationById,
    baseById,
    draftById,
  );

  return {
    classifications,
    changeList: [
      ...classifications.flatMap((classification) => {
        if (classification.classification === "unchanged") {
          return [];
        }
        const baseRow = baseById.get(classification.elementId);
        const draftRow = draftById.get(classification.elementId);
        const payloadChanged =
          baseRow === undefined ||
          draftRow === undefined ||
          baseRow.payloadHash !== draftRow.payloadHash;
        if (
          !payloadChanged &&
          citationChangedElementIds.has(classification.elementId)
        ) {
          return [];
        }

        return [semanticChangeFor(classification, baseById, draftById)];
      }),
      ...citationChanges,
    ],
    planStale: isPlanStale(baseById, draftById),
  };
}

function diffRevisionCitations(
  context: RevisionCitationDiffContext,
): SemanticChange[] {
  const baseByKey = indexCitations(context.baseCitations);
  const draftByKey = indexCitations(context.draftCitations);
  const changes: SemanticChange[] = [];
  const keys = [...new Set([...baseByKey.keys(), ...draftByKey.keys()])].sort();

  for (const key of keys) {
    const base = baseByKey.get(key);
    const draft = draftByKey.get(key);
    const citation = draft ?? base;
    if (citation === undefined) continue;
    const handle = `A${citation.snapshot.number}`;
    if (base === undefined) {
      changes.push({
        elementId: citation.elementId,
        kind: "assumption_citation",
        assumptionId: citation.assumptionId,
        change: "citation_added",
        summary: `Added assumption ${handle} citation to ${citation.elementId}.`,
      });
      continue;
    }
    if (draft === undefined) {
      changes.push({
        elementId: citation.elementId,
        kind: "assumption_citation",
        assumptionId: citation.assumptionId,
        change: "citation_removed",
        summary: `Removed assumption ${handle} citation from ${citation.elementId}.`,
      });
      continue;
    }
    if (!sameCanonicalValue(base.snapshot, draft.snapshot)) {
      changes.push({
        elementId: citation.elementId,
        kind: "assumption_citation",
        assumptionId: citation.assumptionId,
        change: "citation_snapshot_changed",
        summary: `Updated assumption ${handle} citation on ${citation.elementId} (${base.snapshot.disposition} → ${draft.snapshot.disposition}).`,
      });
    }
  }

  if (
    context.baseCitationContractVersion !== context.draftCitationContractVersion
  ) {
    changes.push({
      elementId: "revision",
      kind: "citation_contract",
      change: "citation_contract_changed",
      summary: `Changed assumption citation contract from ${context.baseCitationContractVersion} to ${context.draftCitationContractVersion}.`,
    });
  }
  return changes;
}

function indexCitations(
  citations: readonly RevisionCitation[],
): Map<string, RevisionCitation> {
  const index = new Map<string, RevisionCitation>();
  for (const citation of citations) {
    const key = `${citation.elementId}\u0000${citation.assumptionId}`;
    if (index.has(key)) throw new Error(`Duplicate revision citation: ${key}`);
    index.set(key, citation);
  }
  return index;
}

function sameCanonicalValue(
  left: SpecAssumptionCitationSnapshot,
  right: SpecAssumptionCitationSnapshot,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
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
    case "citation_added":
      return "Added";
    case "citation_removed":
      return "Removed";
    case "citation_snapshot_changed":
    case "citation_contract_changed":
      return "Modified";
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
