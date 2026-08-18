import { describe, expect, it } from "vitest";
import { allHelpEntries } from "./help-registry";
import { JSON_VOLUME_EXCEPTIONS } from "./json-volume-exceptions";
import { pathKey } from "./help-types";

const COMMAND_KEYS = new Set(
  allHelpEntries().map((entry) => pathKey(entry.path)),
);

/**
 * The declare-or-fail backstop for the `--json` volume rule
 * (docs/design/cc-cli/09 §10). The list is debt with an expiry date; these
 * assertions keep it from becoming a place to file new debt quietly, and from
 * describing commands that no longer exist.
 */
describe("json volume exceptions", () => {
  it("holds exactly the reviewed exceptions and no others", () => {
    // An exception is a deliberate edit here AND in `.kiro/steering/cli.md` —
    // the review this ratchet forces. Both entries are the validate surfaces
    // whose envelopes carry the full runner output their text bounds.
    expect(
      JSON_VOLUME_EXCEPTIONS.map((exception) => exception.command),
    ).toEqual(["validate run", "validate status"]);
  });

  it("names a live command in every entry", () => {
    const stale = JSON_VOLUME_EXCEPTIONS.map(
      (exception) => exception.command,
    ).filter((command) => !COMMAND_KEYS.has(command));

    expect(
      stale,
      "these exceptions name commands the registry no longer has — delete the entry with the command, or the list stops describing reality",
    ).toEqual([]);
  });

  it("records what each exception returns and what deletes it", () => {
    for (const exception of JSON_VOLUME_EXCEPTIONS) {
      expect(
        exception.payload.trim().length,
        `${exception.command}: an exception has to say what it returns in full`,
      ).toBeGreaterThan(20);
      expect(
        exception.deletionCondition.trim().length,
        `${exception.command}: an exception without a deletion condition is permanent`,
      ).toBeGreaterThan(40);
    }
  });
});
