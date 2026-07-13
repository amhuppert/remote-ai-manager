// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ParameterDeclaration } from "@/lib/workflows/schemas";
import ParameterDeclarationEditor, {
  changeType,
} from "./ParameterDeclarationEditor";

function lastCall<T>(mock: ReturnType<typeof vi.fn>): T {
  const calls = mock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as T;
}

function getRow(name: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-param-row="${name}"]`);
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("ParameterDeclarationEditor", () => {
  it("shows the explicit voice limitation for a global template", () => {
    render(
      <ParameterDeclarationEditor
        parameters={[
          {
            type: "text",
            name: "brief",
            label: "Brief",
            required: false,
          },
        ]}
        onChange={vi.fn()}
        voiceProjectName={null}
      />,
    );

    expect(
      screen.getByTitle("Voice input requires a project-scoped workflow"),
    ).toBeDisabled();
  });

  describe("empty state", () => {
    it("renders an Add parameter affordance and no rows when there are no declarations", () => {
      render(<ParameterDeclarationEditor parameters={[]} onChange={vi.fn()} />);
      expect(
        screen.getByRole("button", { name: /add parameter/i }),
      ).toBeInTheDocument();
      expect(document.querySelector("[data-param-row]")).toBeNull();
    });
  });

  describe("adding declarations (R8.1)", () => {
    it("appends a new string declaration with sensible defaults", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <ParameterDeclarationEditor parameters={[]} onChange={onChange} />,
      );
      await user.click(screen.getByRole("button", { name: /add parameter/i }));
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next).toHaveLength(1);
      expect(next[0]).toEqual({
        type: "string",
        name: "",
        label: "",
        required: false,
      });
    });

    it("appends onto an existing array", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const existing: ParameterDeclaration[] = [
        { type: "string", name: "feature", label: "Feature", required: true },
      ];
      render(
        <ParameterDeclarationEditor
          parameters={existing}
          onChange={onChange}
        />,
      );
      await user.click(screen.getByRole("button", { name: /add parameter/i }));
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next).toHaveLength(2);
      expect(next[0]).toEqual(existing[0]);
    });
  });

  describe("editing common fields (R8.1)", () => {
    const base: ParameterDeclaration[] = [
      { type: "string", name: "feature", label: "Feature", required: false },
    ];

    it("edits the name", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <ParameterDeclarationEditor parameters={base} onChange={onChange} />,
      );
      const row = getRow("feature");
      const nameInput = within(row).getByLabelText(/name/i);
      await user.type(nameInput, "X");
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next[0]!.name).toBe("featureX");
    });

    it("edits the label", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <ParameterDeclarationEditor parameters={base} onChange={onChange} />,
      );
      const row = getRow("feature");
      const labelInput = within(row).getByLabelText(/label/i);
      await user.type(labelInput, "Y");
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next[0]!.label).toBe("FeatureY");
    });

    it("toggles required", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <ParameterDeclarationEditor parameters={base} onChange={onChange} />,
      );
      const row = getRow("feature");
      const requiredToggle = within(row).getByLabelText(/required/i);
      await user.click(requiredToggle);
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next[0]!.required).toBe(true);
    });

    it("edits the default value", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <ParameterDeclarationEditor parameters={base} onChange={onChange} />,
      );
      const row = getRow("feature");
      const defaultInput = within(row).getByLabelText(/default/i);
      await user.type(defaultInput, "Z");
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next[0]).toEqual({
        type: "string",
        name: "feature",
        label: "Feature",
        required: false,
        default: "Z",
      });
    });
  });

  describe("type switching (R8.1)", () => {
    // The type→declaration transition is a pure function; test it directly. The
    // picker itself is the Radix Select primitive, whose pointer-driven selection
    // is unreliable under jsdom (covered by live Storybook verification instead).
    it("switching to enum gives an empty options list and keeps common fields", () => {
      const next = changeType(
        {
          type: "string",
          name: "feature",
          label: "Feature",
          required: true,
          default: "kept",
        },
        "enum",
      );
      expect(next).toEqual({
        type: "enum",
        name: "feature",
        label: "Feature",
        required: true,
        options: [],
        default: "kept",
      });
    });

    it("switching away from enum drops options", () => {
      const next = changeType(
        {
          type: "enum",
          name: "mode",
          label: "Mode",
          required: false,
          options: ["a", "b"],
        },
        "text",
      );
      expect(next).toEqual({
        type: "text",
        name: "mode",
        label: "Mode",
        required: false,
      });
      expect(next).not.toHaveProperty("options");
    });

    it("renders the type control as a Select showing the current type", () => {
      render(
        <ParameterDeclarationEditor
          parameters={[
            {
              type: "enum",
              name: "mode",
              label: "Mode",
              required: false,
              options: [],
            },
          ]}
          onChange={vi.fn()}
        />,
      );
      const row = getRow("mode");
      const typeControl = within(row).getByLabelText(/type/i);
      expect(typeControl.getAttribute("role")).toBe("combobox");
      expect(typeControl.textContent).toContain("Enum");
    });
  });

  describe("enum options management (R8.4)", () => {
    const enumBase: ParameterDeclaration[] = [
      {
        type: "enum",
        name: "mode",
        label: "Mode",
        required: false,
        options: ["alpha", "beta"],
      },
    ];

    it("adds an option", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <ParameterDeclarationEditor
          parameters={enumBase}
          onChange={onChange}
        />,
      );
      const row = getRow("mode");
      await user.click(
        within(row).getByRole("button", { name: /add option/i }),
      );
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next[0]).toMatchObject({
        type: "enum",
        options: ["alpha", "beta", ""],
      });
    });

    it("edits an option", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <ParameterDeclarationEditor
          parameters={enumBase}
          onChange={onChange}
        />,
      );
      const row = getRow("mode");
      const optionInput = within(row).getByLabelText(/^option 1$/i);
      await user.type(optionInput, "X");
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next[0]).toMatchObject({ options: ["alphaX", "beta"] });
    });

    it("removes an option", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <ParameterDeclarationEditor
          parameters={enumBase}
          onChange={onChange}
        />,
      );
      const row = getRow("mode");
      await user.click(
        within(row).getByRole("button", { name: /remove option 1/i }),
      );
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next[0]).toMatchObject({ options: ["beta"] });
    });
  });

  describe("removing a declaration (R8.1)", () => {
    it("removes the declaration at its index", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const base: ParameterDeclaration[] = [
        { type: "string", name: "a", label: "A", required: false },
        { type: "text", name: "b", label: "B", required: false },
      ];
      render(
        <ParameterDeclarationEditor parameters={base} onChange={onChange} />,
      );
      const row = getRow("a");
      await user.click(
        within(row).getByRole("button", { name: /remove parameter/i }),
      );
      const next = lastCall<ParameterDeclaration[]>(onChange);
      expect(next).toHaveLength(1);
      expect(next[0]!.name).toBe("b");
    });
  });

  describe("duplicate-name detection before save (R8.2)", () => {
    it("surfaces an inline error on both offending rows and marks their name inputs aria-invalid", () => {
      const dupes: ParameterDeclaration[] = [
        { type: "string", name: "feature", label: "Feature", required: false },
        { type: "text", name: "feature", label: "Feature 2", required: false },
      ];
      render(
        <ParameterDeclarationEditor parameters={dupes} onChange={vi.fn()} />,
      );
      const errors = screen.getAllByText(/duplicate parameter name/i);
      expect(errors.length).toBe(2);
      const nameInputs = screen.getAllByLabelText(/name/i);
      for (const input of nameInputs) {
        expect(input.getAttribute("aria-invalid")).toBe("true");
      }
    });

    it("does not flag distinct names", () => {
      const ok: ParameterDeclaration[] = [
        { type: "string", name: "a", label: "A", required: false },
        { type: "string", name: "b", label: "B", required: false },
      ];
      render(<ParameterDeclarationEditor parameters={ok} onChange={vi.fn()} />);
      expect(screen.queryByText(/duplicate parameter name/i)).toBeNull();
    });
  });

  describe("accept-time save error (R8.3)", () => {
    it("renders the saveError prominently as an alert", () => {
      render(
        <ParameterDeclarationEditor
          parameters={[
            {
              type: "string",
              name: "feature",
              label: "Feature",
              required: false,
            },
          ]}
          onChange={vi.fn()}
          saveError="Field tasks[0].instructions references undeclared parameter {{inputs.missing}}"
        />,
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/undeclared parameter/i);
      expect(alert).toHaveTextContent(/inputs.missing/);
    });

    it("renders no alert when saveError is absent", () => {
      render(<ParameterDeclarationEditor parameters={[]} onChange={vi.fn()} />);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
