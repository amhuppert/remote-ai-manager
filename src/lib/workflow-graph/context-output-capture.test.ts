/**
 * Capture-side pure functions: the prompt and the path-keyed issue mapping.
 *
 * The issue mapping is the contract D4 conditional edges read, so the recorded
 * `path` must be the validator's ACTUAL instance path — including the
 * bracket-quoted form the canonical validator emits for any property name that
 * is not a plain identifier.
 */

import { describe, expect, it } from "vitest";
import {
  buildOutputCapturePrompt,
  toOutputSchemaIssues,
} from "./context-output-capture";
import { renderFormatTurnPrompt } from "@/lib/agent-backends/structured-output-prompt";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";

describe("toOutputSchemaIssues", () => {
  it("splits a plain identifier path from its description", () => {
    expect(toOutputSchemaIssues(["$.summary must be string"])).toEqual([
      { title: "$.summary", path: "$.summary", description: "must be string" },
    ]);
  });

  it("keeps a bare root path", () => {
    expect(toOutputSchemaIssues(["$ must be object"])).toEqual([
      { title: "$", path: "$", description: "must be object" },
    ]);
  });

  // The validator bracket-quotes any key that is not a plain identifier, so a
  // perfectly legal `outputSchema` property such as "risk owner" produces a
  // path CONTAINING a space. Splitting the message at its first space truncates
  // it to `$["risk`, which addresses nothing.
  it("keeps a bracket-quoted path whose property name contains a space", () => {
    expect(toOutputSchemaIssues(['$["risk owner"] is required'])).toEqual([
      {
        title: '$["risk owner"]',
        path: '$["risk owner"]',
        description: "is required",
      },
    ]);
  });

  it("keeps nested bracket, array-index, and dotted segments together", () => {
    expect(
      toOutputSchemaIssues(['$.plan["risk owner"][2].detail must be string']),
    ).toEqual([
      {
        title: '$.plan["risk owner"][2].detail',
        path: '$.plan["risk owner"][2].detail',
        description: "must be string",
      },
    ]);
  });

  // A `]` inside the quoted key must not end the segment early.
  it("respects a closing bracket inside a quoted property name", () => {
    expect(toOutputSchemaIssues(['$["a] b"] is not allowed'])).toEqual([
      { title: '$["a] b"]', path: '$["a] b"]', description: "is not allowed" },
    ]);
  });

  it("respects an escaped quote inside a quoted property name", () => {
    expect(toOutputSchemaIssues(['$["a\\" b"] is required'])).toEqual([
      {
        title: '$["a\\" b"]',
        path: '$["a\\" b"]',
        description: "is required",
      },
    ]);
  });

  // Real validator output, not a hand-written string: the mapping must agree
  // with whatever `joinPath` actually produces for a spaced property name.
  it("agrees with the canonical validator's own message for a spaced key", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { "risk owner": { type: "string" } },
      required: ["risk owner"],
    };
    const result = validateJsonSchemaSubset(schema, {});
    expect(result.valid).toBe(false);

    const issues = toOutputSchemaIssues(result.errors ?? []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('$["risk owner"]');
    // The description must not swallow the path, nor be empty.
    expect(issues[0]?.description).not.toContain("risk owner");
    expect(issues[0]?.description.length).toBeGreaterThan(0);
  });

  it("degrades an error that carries no instance path to a payload-level issue", () => {
    expect(toOutputSchemaIssues(["the model returned no JSON at all"])).toEqual(
      [
        {
          title: "$",
          path: "$",
          description: "the model returned no JSON at all",
        },
      ],
    );
  });
});

describe("buildOutputCapturePrompt", () => {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  };

  it("renders the full declared schema and the emit-JSON-only instruction", () => {
    const prompt = buildOutputCapturePrompt({
      contextTitle: "Plan the work",
      outputSchema: schema,
    });

    expect(prompt).toContain("Plan the work");
    expect(prompt).toContain(renderFormatTurnPrompt(schema));
    expect(prompt).not.toContain("previously rejected");
  });

  it("renders the previous rejection so a retry is not blind", () => {
    const prompt = buildOutputCapturePrompt({
      contextTitle: "Plan the work",
      outputSchema: schema,
      previousRejection: {
        summary: "Output did not satisfy the declared outputSchema",
        issues: [
          {
            title: '$["risk owner"]',
            path: '$["risk owner"]',
            description: "is required",
          },
        ],
      },
    });

    expect(prompt).toContain("Your previous output was rejected");
    expect(prompt).toContain(
      "Output did not satisfy the declared outputSchema",
    );
    expect(prompt).toContain('$["risk owner"]: is required');
  });
});
