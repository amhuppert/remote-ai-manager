import { describe, expect, it } from "vitest";

import {
  EVIDENCE_PRODUCERS,
  evidenceKindsForSourceEvent,
} from "./evidence-producers";

describe("evidence producer registry", () => {
  it("drives every source-event to evidence-kind production mapping", () => {
    const declaringStrategy = {
      kinds: EVIDENCE_PRODUCERS.map(({ kind }) => kind),
    };

    for (const producer of EVIDENCE_PRODUCERS) {
      expect(
        evidenceKindsForSourceEvent(producer.sourceEvent, declaringStrategy),
      ).toContain(producer.kind);
    }
  });

  it("does not mint a strategy-gated kind when the strategy omits it", () => {
    expect(
      evidenceKindsForSourceEvent("graph-workflow-validation-result", {
        kinds: ["validator_verdict"],
      }),
    ).toEqual(["validator_verdict"]);
  });
});
