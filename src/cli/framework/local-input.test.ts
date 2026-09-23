import { expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import { createCcRuntimeFixture } from "../testing/framework";

it.each(["json", "text"] as const)(
  "identifies the draft input and failure stage before any server call in %s",
  async (format) => {
    const fixture = createCcRuntimeFixture({
      respond() {
        throw new Error("Invalid local input must not reach the server");
      },
    });
    const host = createTestHost({
      files: {
        "/invalid-utf8-draft.json": new Uint8Array([0xc3, 0x28]),
        "/malformed-draft.json":
          '{\n  "sensitive": "private-input-marker",\n}\n',
      },
    });
    for (const [file, stage, cause] of [
      ["/missing-draft.json", "could not be read", "file does not exist"],
      ["/invalid-utf8-draft.json", "not valid UTF-8", "not valid UTF-8 text"],
      ["/malformed-draft.json", "not valid JSON", "line 3 column 1"],
    ] as const) {
      const result = await runForTest(
        fixture.cli,
        ["spec", "draft-check", "native-sdd", "--file", file],
        { host, format },
      );
      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain(file);
      expect(output).toContain(stage);
      expect(output).toContain(cause);
      expect(output).not.toContain("private-input-marker");
      if (format === "json") {
        expect(result.envelope).toMatchObject({
          ok: false,
          effect: "read",
          error: {
            code: "KERNEL_INPUT",
            exitClass: "usage",
            message: expect.stringContaining(stage),
            why: expect.stringContaining(file),
          },
        });
      }
    }
    expect(fixture.requests).toEqual([]);
  },
);

it.each(["json", "text"] as const)(
  "preserves draft schema issue paths and messages in %s",
  async (format) => {
    const fixture = createCcRuntimeFixture({
      files: {
        "/invalid-schema-draft.json": JSON.stringify({
          elementId: "requirement-one",
          kind: "requirement",
          parentElementId: null,
          baseElementVersion: 1,
          payload: {
            kind: "requirement",
            statement: 42,
            priority: "must",
            risk: "low",
          },
        }),
      },
      respond() {
        throw new Error("Invalid schema input must not reach the server");
      },
    });
    const result = await fixture.run(
      [
        "spec",
        "draft-check",
        "native-sdd",
        "--file",
        "/invalid-schema-draft.json",
      ],
      format,
    );
    expect(result.exitCode).toBe(2);
    if (format === "json") {
      expect(result.envelope).toMatchObject({
        ok: false,
        effect: "read",
        error: {
          code: "KERNEL_INPUT",
          issues: [
            {
              code: "schema",
              path: ["payload", "statement"],
              message: "Invalid input: expected string, received number",
            },
          ],
        },
      });
    } else {
      expect(result.stdout + result.stderr).toContain(
        '["payload","statement"]',
      );
      expect(result.stdout + result.stderr).toContain(
        "Invalid input: expected string, received number",
      );
    }
    expect(fixture.requests).toEqual([]);
  },
);
