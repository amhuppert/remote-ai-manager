import { describe, expect, it } from "vitest";
import { terminalIdentityMatches } from "./codex-terminal";
const marker = {
  pid: 42,
  started: "Fri Sep 18 15:00:00 2026",
  command: "/bin/sleep 120",
};
describe("running terminal ownership evidence", () => {
  it("accepts the exact recorded sleep child and birth identity", () => {
    expect(terminalIdentityMatches(marker, { ...marker })).toBe(true);
  });
  it.each([
    null,
    { ...marker, pid: 43 },
    { ...marker, started: "different birth" },
    { ...marker, command: "python3 other.py" },
  ])("rejects missing, reused or different child identity", (observed) => {
    expect(terminalIdentityMatches(marker, observed)).toBe(false);
  });
});
