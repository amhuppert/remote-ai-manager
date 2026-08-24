import { describe, expect, it } from "vitest";

import {
  assumptionAuditSnapshot,
  assumptionCitationSnapshot,
  questionAuditSnapshot,
} from "./attention-records";
import {
  type CanonicalAuditHistoryInput,
  validateCanonicalAuditHistory,
} from "./canonical-audit-history";
import type {
  SpecAssumptionCitationsMutatedEventPayload,
  SpecAssumptionRow,
  SpecEventRow,
  SpecQuestionRow,
  SpecReviewRecordMutatedEventPayload,
} from "./schemas";
import { computeSpecRevisionCitationHash } from "../state-store/specs-repo";
import { stableStringify } from "../state-store/serialization";

const SPEC_ID = "spec-audit-history";
const REVISION_ID = "revision-audit-history";
const CREATED_AT = "2026-08-23T10:00:00.000Z";
const EDITED_AT = "2026-08-23T11:00:00.000Z";
const EDITED_AGAIN_AT = "2026-08-23T12:00:00.000Z";
const CREATOR = { kind: "agent", conversationId: "creator" } as const;

function question(overrides: Partial<SpecQuestionRow> = {}): SpecQuestionRow {
  return {
    id: "question-1",
    spec_id: SPEC_ID,
    number: 1,
    element_id: null,
    text: "Initial question",
    provenance_json: stableStringify(CREATOR),
    record_version: 1,
    status: "open",
    answer: null,
    answered_at: null,
    withdrawn_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function assumption(
  overrides: Partial<SpecAssumptionRow> = {},
): SpecAssumptionRow {
  return {
    id: "assumption-1",
    spec_id: SPEC_ID,
    number: 1,
    element_id: null,
    text: "Initial assumption",
    proposed_by_json: stableStringify(CREATOR),
    record_version: 1,
    disposition: "proposed",
    disposed_at: null,
    withdrawn_at: null,
    supersedes_assumption_id: null,
    supersession_operation_id: null,
    supersession_request_hash: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function recordEvent(
  id: number,
  payload: SpecReviewRecordMutatedEventPayload,
): SpecEventRow {
  return {
    id,
    spec_id: SPEC_ID,
    occurred_at: EDITED_AT,
    event_type: "spec-review-record-mutated",
    actor_json: stableStringify(CREATOR),
    payload_json: stableStringify(payload),
  };
}

function citationEvent(
  id: number,
  payload: SpecAssumptionCitationsMutatedEventPayload,
): SpecEventRow {
  return {
    id,
    spec_id: SPEC_ID,
    occurred_at: EDITED_AT,
    event_type: "spec-assumption-citations-mutated",
    actor_json: stableStringify(CREATOR),
    payload_json: stableStringify(payload),
  };
}

function input(
  overrides: Partial<CanonicalAuditHistoryInput> = {},
): CanonicalAuditHistoryInput {
  return {
    questions: [],
    assumptions: [],
    revisionSnapshots: [],
    attentionAuditEvents: [],
    ...overrides,
  };
}

function editPayload(
  before: SpecQuestionRow,
  after: SpecQuestionRow,
): SpecReviewRecordMutatedEventPayload {
  return {
    schemaVersion: 1,
    recordKind: "question",
    recordId: after.id,
    recordNumber: after.number,
    attentionId: after.id,
    operation: "edited",
    active: true,
    before: questionAuditSnapshot(before),
    after: questionAuditSnapshot(after),
  };
}

function citationFixture() {
  const row = assumption();
  const snapshot = assumptionCitationSnapshot(row, CREATED_AT);
  const citation = {
    elementId: "requirement-1",
    assumptionId: row.id,
    snapshot,
  };
  const emptyHash = computeSpecRevisionCitationHash(2, []);
  const citationHash = computeSpecRevisionCitationHash(2, [citation]);
  const payload: SpecAssumptionCitationsMutatedEventPayload = {
    schemaVersion: 1,
    revisionId: REVISION_ID,
    beforeCitationVersion: 1,
    afterCitationVersion: 2,
    beforeCitationHash: emptyHash,
    afterCitationHash: citationHash,
    added: [citation],
    removed: [],
    refreshed: [],
  };
  return { row, snapshot, citation, emptyHash, citationHash, payload };
}

describe("validateCanonicalAuditHistory", () => {
  it("accepts a continuous record history whose latest snapshot is current", () => {
    const first = question();
    const second = question({
      text: "Second question",
      record_version: 2,
      updated_at: EDITED_AT,
    });
    const third = question({
      text: "Third question",
      record_version: 3,
      updated_at: EDITED_AGAIN_AT,
    });

    expect(
      validateCanonicalAuditHistory(
        input({
          questions: [third],
          attentionAuditEvents: [
            recordEvent(1, editPayload(first, second)),
            recordEvent(2, editPayload(second, third)),
          ],
        }),
      ),
    ).toBeNull();
  });

  it("rejects a record event whose before snapshot does not continue the chain", () => {
    const first = question();
    const second = question({
      text: "Second question",
      record_version: 2,
      updated_at: EDITED_AT,
    });
    const disconnectedSecond = { ...second, text: "Disconnected question" };
    const third = question({
      text: "Third question",
      record_version: 3,
      updated_at: EDITED_AGAIN_AT,
    });

    expect(
      validateCanonicalAuditHistory(
        input({
          questions: [third],
          attentionAuditEvents: [
            recordEvent(1, editPayload(first, second)),
            recordEvent(2, editPayload(disconnectedSecond, third)),
          ],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[1].payload_json.before.text",
      message:
        "record event history does not continue from the preceding snapshot",
    });
  });

  it("rejects a latest record event that does not match the durable row", () => {
    const first = question();
    const eventAfter = question({
      text: "Event question",
      record_version: 2,
      updated_at: EDITED_AT,
    });
    const current = { ...eventAfter, text: "Current question" };

    expect(
      validateCanonicalAuditHistory(
        input({
          questions: [current],
          attentionAuditEvents: [
            recordEvent(1, editPayload(first, eventAfter)),
          ],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[0].payload_json.after.text",
      message: "latest record event does not match the current durable record",
    });
  });

  it("rejects changes to question creation provenance", () => {
    const first = question();
    const changed = question({
      provenance_json: stableStringify({
        kind: "agent",
        conversationId: "different-creator",
      }),
      record_version: 2,
      updated_at: EDITED_AT,
    });

    expect(
      validateCanonicalAuditHistory(
        input({
          questions: [changed],
          attentionAuditEvents: [recordEvent(1, editPayload(first, changed))],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[0].payload_json.after.provenance.conversationId",
      message: "record creation provenance must remain immutable",
    });
  });

  it("rejects changes to assumption creation time", () => {
    const first = assumption();
    const changed = assumption({
      record_version: 2,
      created_at: EDITED_AT,
      updated_at: EDITED_AT,
    });
    const payload: SpecReviewRecordMutatedEventPayload = {
      schemaVersion: 1,
      recordKind: "assumption",
      recordId: changed.id,
      recordNumber: changed.number,
      attentionId: changed.id,
      operation: "edited",
      active: true,
      before: assumptionAuditSnapshot(first, null),
      after: assumptionAuditSnapshot(changed, null),
    };

    expect(
      validateCanonicalAuditHistory(
        input({
          assumptions: [changed],
          attentionAuditEvents: [recordEvent(1, payload)],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[0].payload_json.after.createdAt",
      message: "record creation provenance must remain immutable",
    });
  });

  it("allows durable records with no pre-cutover audit events", () => {
    expect(
      validateCanonicalAuditHistory(
        input({ questions: [question()], assumptions: [assumption()] }),
      ),
    ).toBeNull();
  });

  it("accepts a citation event that reconstructs the prior citation set", () => {
    const fixture = citationFixture();

    expect(
      validateCanonicalAuditHistory(
        input({
          assumptions: [fixture.row],
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 2,
                citationVersion: 2,
                citationHash: fixture.citationHash,
              },
              assumptionCitations: [fixture.citation],
            },
          ],
          attentionAuditEvents: [citationEvent(1, fixture.payload)],
        }),
      ),
    ).toBeNull();
  });

  it("rejects a latest citation event version that is not current", () => {
    const fixture = citationFixture();

    expect(
      validateCanonicalAuditHistory(
        input({
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 2,
                citationVersion: 3,
                citationHash: fixture.citationHash,
              },
              assumptionCitations: [fixture.citation],
            },
          ],
          attentionAuditEvents: [citationEvent(1, fixture.payload)],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[0].payload_json.afterCitationVersion",
      message:
        "latest citation event version does not match the current revision",
    });
  });

  it("rejects an added snapshot that differs from the current citation", () => {
    const fixture = citationFixture();
    const payload = {
      ...fixture.payload,
      added: [
        {
          ...fixture.citation,
          snapshot: { ...fixture.snapshot, text: "Different snapshot" },
        },
      ],
    };

    expect(
      validateCanonicalAuditHistory(
        input({
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 2,
                citationVersion: 2,
                citationHash: fixture.citationHash,
              },
              assumptionCitations: [fixture.citation],
            },
          ],
          attentionAuditEvents: [citationEvent(1, payload)],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[0].payload_json.added[0].snapshot.text",
      message: "added citation snapshot does not match the current citation",
    });
  });

  it("rejects an event whose before hash does not match the reversed delta", () => {
    const fixture = citationFixture();
    const payload = {
      ...fixture.payload,
      beforeCitationHash: "0".repeat(64),
    };

    expect(
      validateCanonicalAuditHistory(
        input({
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 2,
                citationVersion: 2,
                citationHash: fixture.citationHash,
              },
              assumptionCitations: [fixture.citation],
            },
          ],
          attentionAuditEvents: [citationEvent(1, payload)],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[0].payload_json.beforeCitationHash",
      message:
        "citation event before hash does not match the reconstructed citation set",
    });
  });

  it("reverse-applies removed and refreshed citation snapshots", () => {
    const fixture = citationFixture();
    const removedPayload: SpecAssumptionCitationsMutatedEventPayload = {
      ...fixture.payload,
      beforeCitationHash: fixture.citationHash,
      afterCitationHash: fixture.emptyHash,
      added: [],
      removed: [fixture.citation],
    };
    const refreshedSnapshot = {
      ...fixture.snapshot,
      recordVersion: 2,
      text: "Refreshed assumption",
      updatedAt: EDITED_AT,
    };
    const refreshedCitation = {
      ...fixture.citation,
      snapshot: refreshedSnapshot,
    };
    const refreshedHash = computeSpecRevisionCitationHash(2, [
      refreshedCitation,
    ]);
    const refreshedPayload: SpecAssumptionCitationsMutatedEventPayload = {
      ...fixture.payload,
      beforeCitationHash: fixture.citationHash,
      afterCitationHash: refreshedHash,
      added: [],
      refreshed: [
        {
          elementId: fixture.citation.elementId,
          assumptionId: fixture.citation.assumptionId,
          beforeSnapshot: fixture.snapshot,
          afterSnapshot: refreshedSnapshot,
        },
      ],
    };

    expect(
      validateCanonicalAuditHistory(
        input({
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 2,
                citationVersion: 2,
                citationHash: fixture.emptyHash,
              },
              assumptionCitations: [],
            },
          ],
          attentionAuditEvents: [citationEvent(1, removedPayload)],
        }),
      ),
    ).toBeNull();

    expect(
      validateCanonicalAuditHistory(
        input({
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 2,
                citationVersion: 2,
                citationHash: refreshedHash,
              },
              assumptionCitations: [refreshedCitation],
            },
          ],
          attentionAuditEvents: [citationEvent(1, refreshedPayload)],
        }),
      ),
    ).toBeNull();
  });

  it("rejects a refreshed after snapshot that differs from current state", () => {
    const fixture = citationFixture();
    const currentSnapshot = {
      ...fixture.snapshot,
      recordVersion: 2,
      text: "Current refreshed assumption",
      updatedAt: EDITED_AT,
    };
    const currentCitation = {
      ...fixture.citation,
      snapshot: currentSnapshot,
    };
    const currentHash = computeSpecRevisionCitationHash(2, [currentCitation]);
    const payload: SpecAssumptionCitationsMutatedEventPayload = {
      ...fixture.payload,
      afterCitationHash: currentHash,
      added: [],
      refreshed: [
        {
          elementId: fixture.citation.elementId,
          assumptionId: fixture.citation.assumptionId,
          beforeSnapshot: fixture.snapshot,
          afterSnapshot: {
            ...currentSnapshot,
            text: "Different refreshed assumption",
          },
        },
      ],
    };

    expect(
      validateCanonicalAuditHistory(
        input({
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 2,
                citationVersion: 2,
                citationHash: currentHash,
              },
              assumptionCitations: [currentCitation],
            },
          ],
          attentionAuditEvents: [citationEvent(1, payload)],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[0].payload_json.refreshed[0].afterSnapshot.text",
      message:
        "refreshed citation after snapshot does not match the current citation",
    });
  });

  it("chains citation event versions and hashes backwards", () => {
    const fixture = citationFixture();
    const currentSnapshot = {
      ...fixture.snapshot,
      recordVersion: 2,
      text: "Current refreshed assumption",
      updatedAt: EDITED_AT,
    };
    const currentCitation = {
      ...fixture.citation,
      snapshot: currentSnapshot,
    };
    const currentHash = computeSpecRevisionCitationHash(2, [currentCitation]);
    const refreshPayload: SpecAssumptionCitationsMutatedEventPayload = {
      schemaVersion: 1,
      revisionId: REVISION_ID,
      beforeCitationVersion: 2,
      afterCitationVersion: 3,
      beforeCitationHash: fixture.citationHash,
      afterCitationHash: currentHash,
      added: [],
      removed: [],
      refreshed: [
        {
          elementId: fixture.citation.elementId,
          assumptionId: fixture.citation.assumptionId,
          beforeSnapshot: fixture.snapshot,
          afterSnapshot: currentSnapshot,
        },
      ],
    };
    const brokenAddPayload = {
      ...fixture.payload,
      afterCitationHash: "0".repeat(64),
    };

    expect(
      validateCanonicalAuditHistory(
        input({
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 2,
                citationVersion: 3,
                citationHash: currentHash,
              },
              assumptionCitations: [currentCitation],
            },
          ],
          attentionAuditEvents: [
            citationEvent(1, brokenAddPayload),
            citationEvent(2, refreshPayload),
          ],
        }),
      ),
    ).toEqual({
      path: "attentionAuditEvents[0].payload_json.afterCitationHash",
      message: "citation event hash does not continue from the following event",
    });
  });

  it("allows revisions with no pre-cutover citation events", () => {
    expect(
      validateCanonicalAuditHistory(
        input({
          revisionSnapshots: [
            {
              revision: {
                id: REVISION_ID,
                citationContractVersion: 1,
                citationVersion: 1,
                citationHash: computeSpecRevisionCitationHash(1, []),
              },
              assumptionCitations: [],
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
