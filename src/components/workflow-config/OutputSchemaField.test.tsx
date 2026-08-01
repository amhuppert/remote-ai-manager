// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  OUTPUT_SCHEMA_TEMPLATE,
  OutputSchemaField,
  lintOutputSchemaText,
} from "./OutputSchemaField";
import {
  UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS,
  validateOutputSchemaDeclaration,
} from "@/lib/workflows/primitives/output-schema-subset";

const BROKEN_JSON = `{
  "type": "object",
  "properties": {
    "verdict": { "type": "string" }
    "confidence": { "type": "number" }
  }
}`;

const UNSUPPORTED = `{
  "type": "object",
  "properties": {
    "owner": { "$ref": "#/$defs/person" },
    "risk": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
    "dueDate": { "type": "string", "format": "date" }
  },
  "required": ["owner"]
}`;

const ONE_OF = `{
  "oneOf": [
    { "type": "object", "properties": { "kind": { "const": "pass" } } },
    { "type": "object", "properties": { "kind": { "const": "fail" } } }
  ]
}`;

function issueRows(): HTMLElement[] {
  return screen.queryAllByTestId("output-schema-issue");
}

function issuePaths(): string[] {
  return issueRows().map((row) => row.querySelector("code")?.textContent ?? "");
}

function renderField(
  props: Partial<React.ComponentProps<typeof OutputSchemaField>> = {},
) {
  const onChange = vi.fn();
  const utils = render(
    <OutputSchemaField value="" onChange={onChange} {...props} />,
  );
  return { onChange, ...utils };
}

describe("lintOutputSchemaText", () => {
  it("reports the empty stage for blank and whitespace-only text", () => {
    expect(lintOutputSchemaText("").stage).toBe("empty");
    expect(lintOutputSchemaText("   \n  ").stage).toBe("empty");
    expect(lintOutputSchemaText("").issues).toEqual([]);
  });

  it("locates a JSON syntax error by line and column", () => {
    const lint = lintOutputSchemaText(BROKEN_JSON);
    expect(lint.stage).toBe("invalid-json");
    expect(lint.issues).toHaveLength(1);
    // The break is the missing comma after the `verdict` entry: the parser
    // stops at the `"confidence"` key on line 5.
    expect(lint.issues[0]?.path).toBe("line 5 · col 5");
    expect(lint.schema).toBeNull();
  });

  it("summarises a fully-supported declaration", () => {
    const lint = lintOutputSchemaText(OUTPUT_SCHEMA_TEMPLATE);
    expect(lint.stage).toBe("ok");
    expect(lint.issues).toEqual([]);
    expect(lint.shape).toBe("object · 3 fields");
    expect(lint.summary).toBe("3 properties · 2 required");
    expect(lint.schema).toEqual(JSON.parse(OUTPUT_SCHEMA_TEMPLATE));
  });

  // R1.3: the lint IS the server walker, not a parallel keyword list.
  it("derives every unsupported-keyword issue from validateOutputSchemaDeclaration", () => {
    const lint = lintOutputSchemaText(UNSUPPORTED);
    expect(lint.stage).toBe("unsupported");
    expect(lint.schema).toBeNull();
    expect(lint.issues).toEqual(
      validateOutputSchemaDeclaration(JSON.parse(UNSUPPORTED)),
    );
    expect(lint.issues.map((issue) => issue.path)).toEqual([
      "$.properties.owner.$ref",
      "$.properties.risk.anyOf",
      "$.properties.dueDate.format",
    ]);
  });

  // R1.3: `format` is a real server refusal, not a softer warning tone.
  it("refuses `format` with the shared guidance message", () => {
    const lint = lintOutputSchemaText(UNSUPPORTED);
    const formatIssue = lint.issues.find((issue) =>
      issue.path.endsWith(".format"),
    );
    expect(formatIssue?.message).toBe(
      UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS.get("format"),
    );
  });

  // R1.3: the handoff prototype listed `oneOf` as unsupported. It is supported.
  it("accepts a `oneOf` root over object branches", () => {
    const lint = lintOutputSchemaText(ONE_OF);
    expect(lint.issues).toEqual([]);
    expect(lint.stage).toBe("ok");
    expect(lint.shape).toBe("oneOf · 2 variants");
    expect(lint.summary).toBe("2 variants");
  });

  it("refuses a non-object document through the shared walker", () => {
    const lint = lintOutputSchemaText('["a"]');
    expect(lint.stage).toBe("unsupported");
    expect(lint.issues[0]?.path).toBe("$");
  });
});

describe("OutputSchemaField — the five designed states", () => {
  it("renders the dashed empty box with an add action", () => {
    const { onChange } = renderField({ value: "" });

    const field = screen.getByTestId("output-schema-field");
    expect(field).toHaveAttribute("data-stage", "empty");
    expect(screen.getByTestId("output-schema-empty")).toHaveTextContent(
      "No output schema — this context produces free-form work.",
    );
    expect(
      screen.queryByLabelText("Output schema JSON"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("output-schema-gutter"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Add schema" }));
    expect(onChange).toHaveBeenCalledWith(OUTPUT_SCHEMA_TEMPLATE);
  });

  it("renders the shape chip and the green summary line when valid", () => {
    renderField({ value: OUTPUT_SCHEMA_TEMPLATE });

    const field = screen.getByTestId("output-schema-field");
    expect(field).toHaveAttribute("data-stage", "ok");
    expect(screen.getByTestId("output-schema-shape")).toHaveTextContent(
      "object · 3 fields",
    );
    expect(screen.getByTestId("output-schema-valid")).toHaveTextContent(
      "Schema valid · 3 properties · 2 required",
    );
    expect(
      screen.queryByTestId("output-schema-issues"),
    ).not.toBeInTheDocument();
  });

  it("locates an invalid-JSON error by line and column", () => {
    renderField({ value: BROKEN_JSON });

    const field = screen.getByTestId("output-schema-field");
    expect(field).toHaveAttribute("data-stage", "invalid-json");
    const issues = screen.getByTestId("output-schema-issues");
    expect(issues).toHaveAttribute("role", "alert");
    expect(
      within(issues).getByTestId("output-schema-headline"),
    ).toHaveTextContent("Invalid JSON");
    expect(issuePaths()).toEqual(["line 5 · col 5"]);
    expect(screen.queryByTestId("output-schema-valid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("output-schema-shape")).not.toBeInTheDocument();
  });

  it("lists every unsupported keyword against its JSON path with repair guidance", () => {
    renderField({ value: UNSUPPORTED });

    const field = screen.getByTestId("output-schema-field");
    expect(field).toHaveAttribute("data-stage", "unsupported");
    expect(screen.getByTestId("output-schema-headline")).toHaveTextContent(
      "Unsupported schema",
    );
    expect(issuePaths()).toEqual([
      "$.properties.owner.$ref",
      "$.properties.risk.anyOf",
      "$.properties.dueDate.format",
    ]);
    // Guidance prose, not just the keyword name.
    expect(issueRows()[2]).toHaveTextContent(
      UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS.get("format") ?? "MISSING",
    );
  });

  it("offers an undo after clearing, and names the downstream consequence", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <OutputSchemaField value={OUTPUT_SCHEMA_TEMPLATE} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith("");

    rerender(<OutputSchemaField value="" onChange={onChange} />);
    const notice = screen.getByTestId("output-schema-cleared");
    expect(notice).toHaveTextContent(
      "Schema cleared — downstream prompts will no longer carry an output from this context.",
    );

    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    expect(onChange).toHaveBeenLastCalledWith(OUTPUT_SCHEMA_TEMPLATE);
  });

  it("drops the cleared notice once the author types again", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <OutputSchemaField value={OUTPUT_SCHEMA_TEMPLATE} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    rerender(<OutputSchemaField value="" onChange={onChange} />);
    expect(screen.getByTestId("output-schema-cleared")).toBeInTheDocument();

    rerender(<OutputSchemaField value="{}" onChange={onChange} />);
    expect(
      screen.queryByTestId("output-schema-cleared"),
    ).not.toBeInTheDocument();
  });

  // The undo affordance outlives the keystroke that produced it, so it can be
  // on screen when the OWNER goes read-only underneath it (an SSE status change
  // freezing the context). Every other affordance is gated on `readOnly`; this
  // one must be too, or it stays the single live write into a disabled draft.
  it("withdraws the cleared notice when the owner turns read-only", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <OutputSchemaField value={OUTPUT_SCHEMA_TEMPLATE} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    rerender(<OutputSchemaField value="" onChange={onChange} />);
    expect(screen.getByTestId("output-schema-cleared")).toBeInTheDocument();

    onChange.mockClear();
    rerender(
      <OutputSchemaField
        value=""
        onChange={onChange}
        readOnly
        readOnlyHint="Frozen."
      />,
    );

    expect(
      screen.queryByTestId("output-schema-cleared"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("OutputSchemaField — editor chrome", () => {
  it("numbers every line of the schema in the gutter", () => {
    renderField({ value: '{\n  "type": "object"\n}' });

    const gutter = screen.getByTestId("output-schema-gutter");
    expect(gutter).toHaveAttribute("aria-hidden", "true");
    expect(Array.from(gutter.children).map((line) => line.textContent)).toEqual(
      ["1", "2", "3"],
    );
  });

  it("reports every keystroke to the owner", () => {
    const { onChange } = renderField({ value: "{}" });

    fireEvent.change(screen.getByLabelText("Output schema JSON"), {
      target: { value: '{ "type": "object" }' },
    });
    expect(onChange).toHaveBeenCalledWith('{ "type": "object" }');
  });

  it("disables the editor and explains why in read-only mode", () => {
    renderField({
      value: OUTPUT_SCHEMA_TEMPLATE,
      readOnly: true,
      readOnlyHint: "The output was already captured against this schema.",
    });

    expect(screen.getByLabelText("Output schema JSON")).toBeDisabled();
    expect(screen.getByTestId("output-schema-readonly-hint")).toHaveTextContent(
      "The output was already captured against this schema.",
    );
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
  });

  it("offers no add action in read-only mode", () => {
    renderField({ value: "", readOnly: true, readOnlyHint: "Frozen." });

    expect(screen.getByTestId("output-schema-empty")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "+ Add schema" }),
    ).not.toBeInTheDocument();
  });
});
