import { describe, expect, it } from "vitest";
import { projectIdentity } from "./project-identity";

describe("project identity", () => {
  it.each([
    ["command-center", "CC"],
    ["active-recall", "AR"],
    ["CommandCenter", "CC"],
    ["alpha", "AL"],
    ["  my_app  ", "MA"],
    ["Élan Notes", "ÉN"],
  ])("derives two initials for %s", (name, initials) => {
    expect(projectIdentity(name).initials).toBe(initials);
  });
  it("assigns stable colors independent of project ordering and capitalization", () => {
    const cc = projectIdentity("command-center");
    expect(projectIdentity("command-center")).toEqual(cc);
    expect(projectIdentity("COMMAND-CENTER").colorIndex).toBe(cc.colorIndex);
    expect(projectIdentity("active-recall").colorIndex).not.toBe(cc.colorIndex);
    expect(cc.colorIndex).toBeGreaterThanOrEqual(0);
    expect(cc.colorIndex).toBeLessThan(4);
  });
});
