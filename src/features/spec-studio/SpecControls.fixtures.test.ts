import { describe, expect, it } from "vitest";
import {
  specDetailViewSchema,
  specGateAdmissionViewSchema,
} from "@/lib/specs/view-schemas";

import {
  denseSpecControlsDetailFixture,
  draftingSpecControlsDetailFixture,
  policyAdmissionViewFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";

/**
 * Spec Studio renders whatever `/api/specs/.../detail` returns, so these
 * fixtures are only evidence if they are the same shape as that payload. The
 * snake_case-to-camelCase execution/admission migration reached the server
 * while these fixtures kept the old shape, which left every component test
 * green against a surface that was broken in the running app. Parsing through
 * the response schema is what makes the next server-side shape change fail
 * here instead of diverging silently.
 */
describe("spec-studio fixtures", () => {
  it.each([
    { name: "no execution", detail: specControlsDetailFixture() },
    {
      name: "definition review",
      detail: specControlsDetailFixture(),
    },
    { name: "running", detail: specControlsDetailFixture() },
    {
      name: "dense running",
      detail: denseSpecControlsDetailFixture(),
    },
    {
      name: "dense no execution",
      detail: denseSpecControlsDetailFixture(),
    },
    { name: "drafting", detail: draftingSpecControlsDetailFixture("design") },
  ])("conforms to the spec detail response schema ($name)", ({ detail }) => {
    const parsed = specDetailViewSchema.safeParse(detail);

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("builds policy admissions in the gate-admission response shape", () => {
    const parsed = specGateAdmissionViewSchema.safeParse(
      policyAdmissionViewFixture(),
    );

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});
