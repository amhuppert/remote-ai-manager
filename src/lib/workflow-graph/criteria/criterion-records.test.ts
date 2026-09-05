import { describe, expect, it } from "vitest";

import {
  acceptanceCriteriaRecordListText,
  acceptanceCriteriaSchema,
  acceptanceCriteriaText,
  criterionRecordSchema,
  criterionRecordsOf,
  criterionRecordsSchema,
  type CriterionRecord,
} from "./criterion-records";

function makeRecord(overrides: Partial<CriterionRecord> = {}): CriterionRecord {
  return {
    id: "round-trip-proven",
    statement:
      "The stored value reloads byte-identical through the repository.",
    ...overrides,
  };
}

describe("criterionRecordSchema", () => {
  it("preserves opaque coverage ids through parsing and prompt rendering", () => {
    const record = {
      ...makeRecord(),
      covers: ["spec-criterion-one", "external:criterion/two"],
    };
    const parsed = criterionRecordSchema.parse(record);
    expect(parsed).toEqual(record);
    expect(acceptanceCriteriaRecordListText([parsed])).toBe(
      "1. [round-trip-proven] The stored value reloads byte-identical through the repository. (covers: spec-criterion-one, external:criterion/two)",
    );
  });

  it("accepts a kebab-case id with a non-empty statement", () => {
    const parsed = criterionRecordSchema.safeParse(makeRecord());
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["uppercase", "Round-Trip"],
    ["spaces", "round trip"],
    ["leading hyphen", "-round-trip"],
    ["trailing hyphen", "round-trip-"],
    ["consecutive hyphens", "round--trip"],
    ["underscore", "round_trip"],
  ])("refuses a non-kebab-case id (%s)", (_label, id) => {
    const parsed = criterionRecordSchema.safeParse(makeRecord({ id }));
    expect(parsed.success).toBe(false);
  });

  it("refuses an empty statement", () => {
    const parsed = criterionRecordSchema.safeParse(
      makeRecord({ statement: "" }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("criterionRecordsSchema", () => {
  it("refuses an empty records array", () => {
    const parsed = criterionRecordsSchema.safeParse([]);
    expect(parsed.success).toBe(false);
  });

  it("refuses a duplicate id with the offending index and field located", () => {
    const parsed = criterionRecordsSchema.safeParse([
      makeRecord({ id: "shared-id" }),
      makeRecord({ id: "unique-id" }),
      makeRecord({ id: "shared-id" }),
    ]);
    expect(parsed.success).toBe(false);
    const duplicate = parsed.error?.issues.find((issue) =>
      issue.message.includes("duplicate criterion id 'shared-id'"),
    );
    expect(duplicate?.path).toEqual([2, "id"]);
    expect(duplicate?.message).toContain("index 0");
  });

  it("accepts distinct ids", () => {
    const parsed = criterionRecordsSchema.safeParse([
      makeRecord({ id: "first" }),
      makeRecord({ id: "second" }),
    ]);
    expect(parsed.success).toBe(true);
  });
});

describe("acceptanceCriteriaSchema", () => {
  it("accepts legacy prose", () => {
    const parsed = acceptanceCriteriaSchema.safeParse("The feature works.");
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe("The feature works.");
  });

  it("accepts a records array and surfaces a located duplicate-id refusal", () => {
    expect(acceptanceCriteriaSchema.safeParse([makeRecord()]).success).toBe(
      true,
    );
    const duplicate = acceptanceCriteriaSchema.safeParse([
      makeRecord({ id: "dup" }),
      makeRecord({ id: "dup" }),
    ]);
    expect(duplicate.success).toBe(false);
    expect(
      duplicate.error?.issues.some(
        (issue) =>
          issue.message.includes("duplicate criterion id 'dup'") &&
          issue.path.join(".") === "1.id",
      ),
    ).toBe(true);
  });

  it("refuses empty prose", () => {
    expect(acceptanceCriteriaSchema.safeParse("   ").success).toBe(false);
  });
});

describe("criterionRecordsOf", () => {
  it("wraps prose as exactly one record with the deterministic id ac-1", () => {
    expect(criterionRecordsOf("The feature works end to end.")).toEqual([
      { id: "ac-1", statement: "The feature works end to end." },
    ]);
  });

  it("returns records unchanged", () => {
    const records = [makeRecord({ id: "first" }), makeRecord({ id: "second" })];
    expect(criterionRecordsOf(records)).toEqual(records);
  });

  it("returns a fresh array so callers cannot mutate the input", () => {
    const records = [makeRecord()];
    const result = criterionRecordsOf(records);
    expect(result).not.toBe(records);
  });
});

describe("acceptanceCriteriaText", () => {
  it("returns prose unchanged", () => {
    expect(acceptanceCriteriaText("The feature works.")).toBe(
      "The feature works.",
    );
  });

  it("renders records as numbered lines citing each id", () => {
    expect(
      acceptanceCriteriaText([
        makeRecord({ id: "first-thing", statement: "First outcome." }),
        makeRecord({ id: "second-thing", statement: "Second outcome." }),
      ]),
    ).toBe(
      "1. [first-thing] First outcome.\n2. [second-thing] Second outcome.",
    );
  });
});

describe("acceptanceCriteriaRecordListText", () => {
  it("renders prose as a one-record numbered list under the deterministic wrap id", () => {
    expect(acceptanceCriteriaRecordListText("The feature works.")).toBe(
      "1. [ac-1] The feature works.",
    );
  });

  it("renders records as the same numbered list shape", () => {
    expect(
      acceptanceCriteriaRecordListText([
        makeRecord({ id: "first-thing", statement: "First outcome." }),
        makeRecord({ id: "second-thing", statement: "Second outcome." }),
      ]),
    ).toBe(
      "1. [first-thing] First outcome.\n2. [second-thing] Second outcome.",
    );
  });
});
