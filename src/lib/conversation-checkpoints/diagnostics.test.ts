import { describe, expect, it } from "vitest";

import { checkpointErrorFields } from "./diagnostics";

/**
 * The seed text a leaking diagnostic would reproduce. Every case below throws
 * an error whose message quotes it, because that is the shape the invariant is
 * about: the exception, not the log call, is where conversation material
 * enters a failure path.
 */
const QUOTED_SOURCE =
  "user asked to ship the widget before Thursday's demo; API_HOST=prod-7";
const PROVIDER_REF = "sess_01JQ8ZK7YB4M2NRESUMETOKEN";

class SqliteError extends Error {
  readonly code = "SQLITE_BUSY";
  constructor(message: string) {
    super(message);
    this.name = "SqliteError";
  }
}

describe("checkpointErrorFields", () => {
  it("reports the error class without its message", () => {
    const fields = checkpointErrorFields(
      new TypeError(`cannot read seed: ${QUOTED_SOURCE}`),
    );

    expect(fields.errorKind).toBe("TypeError");
    expect(Object.values(fields).join(" ")).not.toContain("widget");
    expect(Object.values(fields).join(" ")).not.toContain("API_HOST");
  });

  it("carries a platform error code so a retryable fault stays diagnosable", () => {
    const fields = checkpointErrorFields(
      new SqliteError(`database is locked while writing ${QUOTED_SOURCE}`),
    );

    expect(fields).toEqual({
      errorKind: "SqliteError",
      errorCode: "SQLITE_BUSY",
      errorChars: `database is locked while writing ${QUOTED_SOURCE}`.length,
    });
  });

  it("counts the elided message rather than dropping the fact that detail existed", () => {
    const message = `resume ${PROVIDER_REF} rejected`;

    const fields = checkpointErrorFields(new Error(message));

    expect(fields.errorChars).toBe(message.length);
    expect(JSON.stringify(fields)).not.toContain("RESUMETOKEN");
  });

  it("classifies a non-Error throw by its runtime type", () => {
    expect(checkpointErrorFields(QUOTED_SOURCE)).toEqual({
      errorKind: "string",
      errorCode: null,
      errorChars: QUOTED_SOURCE.length,
    });
    expect(checkpointErrorFields(undefined)).toEqual({
      errorKind: "undefined",
      errorCode: null,
      errorChars: 0,
    });
  });

  it("ignores a non-string code property rather than coercing it", () => {
    const error = Object.assign(new Error("boom"), { code: 42 });

    expect(checkpointErrorFields(error).errorCode).toBeNull();
  });
});
