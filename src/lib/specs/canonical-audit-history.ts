import type {
  SpecAssumptionCitation,
  SpecAssumptionCitationsMutatedEventPayload,
  SpecAssumptionRow,
  SpecEventRow,
  SpecQuestionRow,
  SpecRecordAuditSnapshot,
  SpecReviewRecordMutatedEventPayload,
  SpecRevision,
} from "./schemas";
import {
  specAssumptionCitationsMutatedEventPayloadSchema,
  specReviewRecordMutatedEventPayloadSchema,
} from "./schemas";
import { computeSpecRevisionCitationHash } from "../state-store/specs-repo";
import {
  assumptionAuditSnapshot,
  questionAuditSnapshot,
} from "./attention-records";

export interface CanonicalAuditRevisionSnapshot {
  readonly revision: Pick<
    SpecRevision,
    "id" | "citationContractVersion" | "citationVersion" | "citationHash"
  >;
  readonly assumptionCitations: readonly Pick<
    SpecAssumptionCitation,
    "elementId" | "assumptionId" | "snapshot"
  >[];
}

export interface CanonicalAuditHistoryInput {
  readonly questions: readonly SpecQuestionRow[];
  readonly assumptions: readonly SpecAssumptionRow[];
  readonly revisionSnapshots: readonly CanonicalAuditRevisionSnapshot[];
  readonly attentionAuditEvents: readonly SpecEventRow[];
}

export interface CanonicalAuditHistoryIssue {
  readonly path: string;
  readonly message: string;
}

export function validateCanonicalAuditHistory(
  input: CanonicalAuditHistoryInput,
): CanonicalAuditHistoryIssue | null {
  const parsedEvents = parseAttentionEvents(input.attentionAuditEvents);
  if ("issue" in parsedEvents) return parsedEvents.issue;

  const recordIssue = validateRecordHistory(input, parsedEvents.records);
  if (recordIssue !== null) return recordIssue;

  return validateCitationHistory(input, parsedEvents.citations);
}

interface IndexedRecordEvent {
  readonly eventId: number;
  readonly index: number;
  readonly payload: SpecReviewRecordMutatedEventPayload;
}

interface IndexedCitationEvent {
  readonly eventId: number;
  readonly index: number;
  readonly payload: SpecAssumptionCitationsMutatedEventPayload;
}

type ParsedAttentionEvents =
  | {
      readonly records: IndexedRecordEvent[];
      readonly citations: IndexedCitationEvent[];
    }
  | { readonly issue: CanonicalAuditHistoryIssue };

function parseAttentionEvents(
  events: readonly SpecEventRow[],
): ParsedAttentionEvents {
  const records: IndexedRecordEvent[] = [];
  const citations: IndexedCitationEvent[] = [];

  for (const [index, event] of events.entries()) {
    if (
      event.event_type !== "spec-review-record-mutated" &&
      event.event_type !== "spec-assumption-citations-mutated"
    ) {
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.payload_json);
    } catch {
      return {
        issue: {
          path: `attentionAuditEvents[${index}].payload_json`,
          message: "attention audit payload is not valid JSON",
        },
      };
    }

    if (event.event_type === "spec-review-record-mutated") {
      const parsed =
        specReviewRecordMutatedEventPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return {
          issue: schemaIssue(
            `attentionAuditEvents[${index}].payload_json`,
            parsed.error.issues[0]?.path ?? [],
            "record audit payload is invalid",
          ),
        };
      }
      records.push({ eventId: event.id, index, payload: parsed.data });
      continue;
    }

    const parsed =
      specAssumptionCitationsMutatedEventPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        issue: schemaIssue(
          `attentionAuditEvents[${index}].payload_json`,
          parsed.error.issues[0]?.path ?? [],
          "citation audit payload is invalid",
        ),
      };
    }
    citations.push({ eventId: event.id, index, payload: parsed.data });
  }

  return { records, citations };
}

function schemaIssue(
  basePath: string,
  segments: readonly PropertyKey[],
  message: string,
): CanonicalAuditHistoryIssue {
  return { path: appendPath(basePath, segments), message };
}

function appendPath(
  basePath: string,
  segments: readonly PropertyKey[],
): string {
  let path = basePath;
  for (const segment of segments) {
    path +=
      typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`;
  }
  return path;
}

function validateRecordHistory(
  input: CanonicalAuditHistoryInput,
  recordEvents: readonly IndexedRecordEvent[],
): CanonicalAuditHistoryIssue | null {
  const grouped = new Map<string, IndexedRecordEvent[]>();
  for (const event of recordEvents) {
    const key = `${event.payload.recordKind}\u0000${event.payload.recordId}`;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }

  const questions = new Map(input.questions.map((row) => [row.id, row]));
  const assumptions = new Map(input.assumptions.map((row) => [row.id, row]));
  const successorByPredecessor = new Map<string, string>();
  for (const row of input.assumptions) {
    if (row.supersedes_assumption_id !== null) {
      successorByPredecessor.set(row.supersedes_assumption_id, row.id);
    }
  }

  for (const events of grouped.values()) {
    events.sort((left, right) => left.eventId - right.eventId);
    const first = events[0];
    if (first === undefined) continue;
    const immutableBaseline = first.payload.before ?? first.payload.after;
    let precedingAfter: SpecRecordAuditSnapshot | null = null;

    for (const event of events) {
      const eventPath = `attentionAuditEvents[${event.index}].payload_json`;
      if (precedingAfter !== null) {
        if (event.payload.before === null) {
          return {
            path: `${eventPath}.before`,
            message:
              "record event history does not continue from the preceding snapshot",
          };
        }
        const difference = firstDifferencePath(
          precedingAfter,
          event.payload.before,
          `${eventPath}.before`,
        );
        if (difference !== null) {
          return {
            path: difference,
            message:
              "record event history does not continue from the preceding snapshot",
          };
        }
      }

      for (const [name, snapshot] of [
        ["before", event.payload.before],
        ["after", event.payload.after],
      ] as const) {
        if (snapshot === null) continue;
        const immutableIssue = immutableRecordIssue(
          immutableBaseline,
          snapshot,
          `${eventPath}.${name}`,
        );
        if (immutableIssue !== null) return immutableIssue;
      }
      precedingAfter = event.payload.after;
    }

    const latest = events.at(-1);
    if (latest === undefined) continue;
    const current =
      latest.payload.recordKind === "question"
        ? questions.get(latest.payload.recordId)
        : assumptions.get(latest.payload.recordId);
    if (current === undefined) {
      return {
        path: `attentionAuditEvents[${latest.index}].payload_json.recordId`,
        message: "record event does not name a current durable record",
      };
    }
    const currentSnapshot =
      latest.payload.recordKind === "question"
        ? questionAuditSnapshot(current as SpecQuestionRow)
        : assumptionAuditSnapshot(
            current as SpecAssumptionRow,
            successorByPredecessor.get(current.id) ?? null,
          );
    const difference = firstDifferencePath(
      currentSnapshot,
      latest.payload.after,
      `attentionAuditEvents[${latest.index}].payload_json.after`,
    );
    if (difference !== null) {
      return {
        path: difference,
        message:
          "latest record event does not match the current durable record",
      };
    }
  }

  return null;
}

function immutableRecordIssue(
  baseline: SpecRecordAuditSnapshot,
  snapshot: SpecRecordAuditSnapshot,
  path: string,
): CanonicalAuditHistoryIssue | null {
  const numberDifference = firstDifferencePath(
    baseline.number,
    snapshot.number,
    `${path}.number`,
  );
  if (numberDifference !== null) {
    return {
      path: numberDifference,
      message: "record creation provenance must remain immutable",
    };
  }
  const createdAtDifference = firstDifferencePath(
    baseline.createdAt,
    snapshot.createdAt,
    `${path}.createdAt`,
  );
  if (createdAtDifference !== null) {
    return {
      path: createdAtDifference,
      message: "record creation provenance must remain immutable",
    };
  }

  if (baseline.kind !== snapshot.kind) {
    return {
      path: `${path}.kind`,
      message: "record creation provenance must remain immutable",
    };
  }

  if (baseline.kind === "question" && snapshot.kind === "question") {
    const difference = firstDifferencePath(
      baseline.provenance,
      snapshot.provenance,
      `${path}.provenance`,
    );
    return difference === null
      ? null
      : {
          path: difference,
          message: "record creation provenance must remain immutable",
        };
  }

  if (baseline.kind === "assumption" && snapshot.kind === "assumption") {
    const proposedByDifference = firstDifferencePath(
      baseline.proposedBy,
      snapshot.proposedBy,
      `${path}.proposedBy`,
    );
    if (proposedByDifference !== null) {
      return {
        path: proposedByDifference,
        message: "record creation provenance must remain immutable",
      };
    }
    const predecessorDifference = firstDifferencePath(
      baseline.supersedesAssumptionId,
      snapshot.supersedesAssumptionId,
      `${path}.supersedesAssumptionId`,
    );
    if (predecessorDifference !== null) {
      return {
        path: predecessorDifference,
        message: "record creation provenance must remain immutable",
      };
    }
  }

  return null;
}

function validateCitationHistory(
  input: CanonicalAuditHistoryInput,
  citationEvents: readonly IndexedCitationEvent[],
): CanonicalAuditHistoryIssue | null {
  const grouped = new Map<string, IndexedCitationEvent[]>();
  for (const event of citationEvents) {
    const group = grouped.get(event.payload.revisionId) ?? [];
    group.push(event);
    grouped.set(event.payload.revisionId, group);
  }
  const revisions = new Map(
    input.revisionSnapshots.map((snapshot) => [snapshot.revision.id, snapshot]),
  );

  for (const [revisionId, events] of grouped) {
    events.sort((left, right) => left.eventId - right.eventId);
    const revision = revisions.get(revisionId);
    const latest = events.at(-1);
    if (revision === undefined && latest !== undefined) {
      return {
        path: `attentionAuditEvents[${latest.index}].payload_json.revisionId`,
        message: "citation event does not name a current revision",
      };
    }
    if (revision === undefined || latest === undefined) continue;

    if (
      latest.payload.afterCitationVersion !== revision.revision.citationVersion
    ) {
      return {
        path: `attentionAuditEvents[${latest.index}].payload_json.afterCitationVersion`,
        message:
          "latest citation event version does not match the current revision",
      };
    }
    if (latest.payload.afterCitationHash !== revision.revision.citationHash) {
      return {
        path: `attentionAuditEvents[${latest.index}].payload_json.afterCitationHash`,
        message:
          "latest citation event hash does not match the current revision",
      };
    }

    const citations = new Map(
      revision.assumptionCitations.map((citation) => [
        citationKey(citation),
        citation,
      ]),
    );
    let currentVersion = revision.revision.citationVersion;
    let currentHash = revision.revision.citationHash;

    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex--) {
      const event = events[eventIndex];
      if (event === undefined) continue;
      const path = `attentionAuditEvents[${event.index}].payload_json`;
      if (event.payload.afterCitationVersion !== currentVersion) {
        return {
          path: `${path}.afterCitationVersion`,
          message:
            "citation event version does not continue from the following event",
        };
      }
      if (event.payload.afterCitationHash !== currentHash) {
        return {
          path: `${path}.afterCitationHash`,
          message:
            "citation event hash does not continue from the following event",
        };
      }

      for (const [index, added] of event.payload.added.entries()) {
        const key = citationKey(added);
        const current = citations.get(key);
        const entryPath = `${path}.added[${index}]`;
        if (current === undefined) {
          return {
            path: entryPath,
            message:
              "added citation is missing from the resulting citation set",
          };
        }
        const difference = firstDifferencePath(
          current.snapshot,
          added.snapshot,
          `${entryPath}.snapshot`,
        );
        if (difference !== null) {
          return {
            path: difference,
            message:
              "added citation snapshot does not match the current citation",
          };
        }
        citations.delete(key);
      }

      for (const [index, removed] of event.payload.removed.entries()) {
        const key = citationKey(removed);
        const entryPath = `${path}.removed[${index}]`;
        if (citations.has(key)) {
          return {
            path: entryPath,
            message: "removed citation remains in the resulting citation set",
          };
        }
        citations.set(key, removed);
      }

      for (const [index, refreshed] of event.payload.refreshed.entries()) {
        const key = citationKey(refreshed);
        const current = citations.get(key);
        const entryPath = `${path}.refreshed[${index}]`;
        if (current === undefined) {
          return {
            path: entryPath,
            message:
              "refreshed citation is missing from the resulting citation set",
          };
        }
        const difference = firstDifferencePath(
          current.snapshot,
          refreshed.afterSnapshot,
          `${entryPath}.afterSnapshot`,
        );
        if (difference !== null) {
          return {
            path: difference,
            message:
              "refreshed citation after snapshot does not match the current citation",
          };
        }
        citations.set(key, {
          elementId: refreshed.elementId,
          assumptionId: refreshed.assumptionId,
          snapshot: refreshed.beforeSnapshot,
        });
      }

      const reconstructedHash = computeSpecRevisionCitationHash(
        revision.revision.citationContractVersion,
        [...citations.values()].sort((left, right) =>
          compareCodeUnits(citationKey(left), citationKey(right)),
        ),
      );
      if (reconstructedHash !== event.payload.beforeCitationHash) {
        return {
          path: `${path}.beforeCitationHash`,
          message:
            "citation event before hash does not match the reconstructed citation set",
        };
      }

      currentVersion = event.payload.beforeCitationVersion;
      currentHash = event.payload.beforeCitationHash;
    }
  }

  return null;
}

function citationKey(input: {
  readonly elementId: string;
  readonly assumptionId: string;
}): string {
  return `${input.elementId}\u0000${input.assumptionId}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function firstDifferencePath(
  expected: unknown,
  actual: unknown,
  path: string,
): string | null {
  if (Object.is(expected, actual)) return null;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  ) {
    return path;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return path;
    if (expected.length !== actual.length) return path;
    for (let index = 0; index < expected.length; index++) {
      const difference = firstDifferencePath(
        expected[index],
        actual[index],
        `${path}[${index}]`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }

  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = [
    ...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]),
  ].sort(compareCodeUnits);
  for (const key of keys) {
    if (!(key in expectedRecord) || !(key in actualRecord)) {
      return `${path}.${key}`;
    }
    const difference = firstDifferencePath(
      expectedRecord[key],
      actualRecord[key],
      `${path}.${key}`,
    );
    if (difference !== null) return difference;
  }
  return null;
}
