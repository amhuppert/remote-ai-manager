import { expect, it } from "vitest";
import { specSummaryViewSchema as clientSpecSummaryViewSchema } from "./queries";

it("requires explicit import provenance on the summary", () => {
  expect(
    clientSpecSummaryViewSchema.shape.imported.safeParse(undefined).success,
  ).toBe(false);
});
