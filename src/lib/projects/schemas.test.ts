import { describe, expect, it } from "vitest";
import { commandCenterProjectResponseSchema } from "./schemas";

describe("commandCenterProjectResponseSchema", () => {
  it.each(["command-center", null])("accepts projectName %j", (projectName) => {
    expect(commandCenterProjectResponseSchema.parse({ projectName })).toEqual({
      projectName,
    });
  });

  it("rejects an empty resolved project name", () => {
    expect(
      commandCenterProjectResponseSchema.safeParse({ projectName: "" }).success,
    ).toBe(false);
  });
});
