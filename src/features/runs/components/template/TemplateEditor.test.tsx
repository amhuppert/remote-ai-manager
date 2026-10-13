// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type {
  RunTemplateContent,
  RunTemplateRecord,
} from "@/lib/run-templates/document";
import { backendModelCatalogSchema } from "@/lib/agent-backends/schemas";
import { RUN_SETTING_DEFAULTS } from "@/lib/runs/settings";
import {
  checkoutTemplate,
  modelOptions,
  profileOptions,
  quickCheckTemplate,
  templateList,
  validationCommands,
} from "../../template-fixtures";
import { contentOf, TEMPLATE_PART } from "../../template-model";
import {
  TemplateEditor,
  type TemplateEditorActions,
  type TemplateSaveResult,
} from "./TemplateEditor";
import { LaunchDialog } from "./LaunchDialog";

const options = {
  models: modelOptions,
  profiles: profileOptions,
  checks: validationCommands,
};

/** Saves stay pending unless a test settles them, so no update lands after it ends. */
function stubActions(
  overrides: {
    onSave?: TemplateEditorActions["onSave"];
    onReload?: TemplateEditorActions["onReload"];
  } = {},
) {
  return {
    onSelectTemplate: vi.fn<TemplateEditorActions["onSelectTemplate"]>(),
    onReload: vi.fn<TemplateEditorActions["onReload"]>(
      overrides.onReload ?? (() => checkoutTemplate),
    ),
    onSave: vi.fn<TemplateEditorActions["onSave"]>(
      overrides.onSave ?? (() => new Promise<TemplateSaveResult>(() => {})),
    ),
    onLaunch: vi.fn<TemplateEditorActions["onLaunch"]>(),
  };
}

function editorElement(
  actions: TemplateEditorActions,
  props: {
    template?: RunTemplateRecord;
    initialSelection?: string;
    initialDraft?: RunTemplateContent;
    initialSaveState?: "idle" | "conflict";
  } = {},
) {
  return (
    <TooltipProvider>
      <TemplateEditor
        templates={templateList}
        template={props.template ?? checkoutTemplate}
        tier="project"
        globals={RUN_SETTING_DEFAULTS}
        options={options}
        actions={actions}
        initialSelection={props.initialSelection ?? TEMPLATE_PART}
        {...(props.initialDraft === undefined
          ? {}
          : { initialDraft: props.initialDraft })}
        {...(props.initialSaveState === undefined
          ? {}
          : { initialSaveState: props.initialSaveState })}
      />
    </TooltipProvider>
  );
}

function editor(
  initialSelection = TEMPLATE_PART,
  template: RunTemplateRecord = checkoutTemplate,
) {
  const actions = stubActions();
  render(editorElement(actions, { initialSelection, template }));
  return actions;
}

function savedContent(actions: ReturnType<typeof stubActions>) {
  const call = actions.onSave.mock.calls.at(-1);
  if (call === undefined) throw new Error("not saved");
  return { content: call[0], baseRevision: call[1] };
}

function contextIn(content: RunTemplateContent, key: string) {
  const context = content.workflow.contexts.find((each) => each.key === key);
  if (context === undefined) throw new Error(`no context ${key}`);
  return context;
}

const saveButton = (revision = 5) =>
  screen.getByRole("button", { name: `Save as revision ${revision}` });

afterEach(cleanup);

describe("saving the authored document", () => {
  it("writes a default changed at the template tier to the defaults only, never into inheriting contexts", () => {
    const actions = editor();
    fireEvent.click(screen.getByRole("switch", { name: "Human approval" }));
    fireEvent.click(saveButton());
    const { content, baseRevision } = savedContent(actions);
    expect(baseRevision).toBe(4);
    expect(content).toEqual({
      ...contentOf(checkoutTemplate),
      defaults: { ...checkoutTemplate.defaults, humanApproval: true },
    });
    expect(content).not.toHaveProperty("revision");
  });

  it("deletes a context override when it is reset to the template default", () => {
    const actions = editor("migrate");
    const implementer = screen.getByRole("region", { name: "Implementer" });
    fireEvent.click(
      within(implementer).getByRole("button", {
        name: "Use the template default",
      }),
    );
    fireEvent.click(saveButton());
    const migrate = contextIn(savedContent(actions).content, "migrate");
    expect(migrate.settings).not.toHaveProperty("implementer");
    expect(migrate.settings?.checks).toEqual(["typecheck", "test"]);
  });

  it("names each setting's tier, and resets an override to the tier below it", () => {
    editor("ui");
    const approval = screen.getByRole("group", { name: "Human approval" });
    expect(approval).toHaveTextContent("set here");
    expect(
      within(approval).getByRole("button", {
        name: "Use the Command Center default",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Agent questions" }),
    ).toHaveTextContent("Command Center");
    const checks = screen.getByRole("region", { name: "Checks" });
    expect(within(checks).getByText("template")).toBeInTheDocument();
    const reviewers = screen.getByRole("region", { name: "Reviewers" });
    expect(
      within(reviewers).getByRole("button", {
        name: "Use the template default",
      }),
    ).toBeInTheDocument();
  });

  it("leaves a setting nobody set at the Command Center default, shown symbolically", () => {
    editor(TEMPLATE_PART, quickCheckTemplate);
    const implementer = screen.getByRole("region", { name: "Implementer" });
    expect(
      within(implementer).getByRole("combobox", { name: "Backend" }),
    ).toHaveTextContent("Command Center default");
    expect(
      within(implementer).getByRole("combobox", { name: "Model" }),
    ).toHaveTextContent("Command Center default");
    expect(
      screen.queryByRole("region", { name: "Unsaved changes" }),
    ).toBeNull();
  });
});

describe("template acknowledgments", () => {
  it("adopts the saved revision while keeping edits made after submission", async () => {
    const pending = Promise.withResolvers<TemplateSaveResult>();
    const actions = stubActions();
    actions.onSave.mockReturnValueOnce(pending.promise);
    const view = render(editorElement(actions));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "First edit" },
    });
    fireEvent.click(saveButton());
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "A later edit" },
    });
    const stored = { ...checkoutTemplate, revision: 5, name: "First edit" };
    await act(async () => pending.resolve({ kind: "saved", template: stored }));
    view.rerender(editorElement(actions, { template: stored }));
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "A later edit",
    );
    fireEvent.click(saveButton(6));
    expect(savedContent(actions)).toEqual({
      content: expect.objectContaining({
        name: "First edit",
        description: "A later edit",
      }),
      baseRevision: 5,
    });
  });

  it("turns a refused save into a conflict, and replaces the draft only after a confirmed reload", async () => {
    const latest = { ...checkoutTemplate, revision: 5, name: "Reloaded" };
    const actions = stubActions({
      onSave: () => ({ kind: "conflict" }),
      onReload: async () => latest,
    });
    render(editorElement(actions));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Local edit" },
    });
    fireEvent.click(saveButton());
    await screen.findByText("A newer revision was saved while you edited");
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    expect(actions.onReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Local edit",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and reload" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Reloaded",
      ),
    );
    expect(actions.onReload).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("region", { name: "Unsaved changes" }),
    ).toBeNull();
  });

  it("keeps dirty values and their base revision across an unsolicited refresh", () => {
    const actions = stubActions();
    const view = render(
      editorElement(actions, {
        initialDraft: { ...contentOf(checkoutTemplate), name: "Local edit" },
      }),
    );
    view.rerender(
      editorElement(actions, {
        template: { ...checkoutTemplate, revision: 5, name: "Remote edit" },
        initialDraft: { ...contentOf(checkoutTemplate), name: "Local edit" },
      }),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Local edit",
    );
    fireEvent.click(saveButton());
    expect(savedContent(actions).baseRevision).toBe(4);
  });

  it("follows a newer stored revision while it has no changes", () => {
    const actions = stubActions();
    const view = render(editorElement(actions));
    view.rerender(
      editorElement(actions, {
        template: { ...checkoutTemplate, revision: 5, name: "Remote edit" },
      }),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Remote edit",
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(actions.onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 5 }),
    );
  });
});

describe("converging on the newest revision", () => {
  it("adopts a newer revision once the edits that held it back are undone", () => {
    const actions = stubActions();
    const view = render(editorElement(actions));
    const name = () => screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name(), { target: { value: "Local edit" } });
    const remote = { ...checkoutTemplate, revision: 5, name: "Remote edit" };
    view.rerender(editorElement(actions, { template: remote }));
    expect(name()).toHaveValue("Local edit");

    fireEvent.change(name(), { target: { value: checkoutTemplate.name } });

    expect(name()).toHaveValue("Remote edit");
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(actions.onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 5 }),
    );
  });

  it("adopts a newer revision that arrived while its own save was pending", async () => {
    const pending = Promise.withResolvers<TemplateSaveResult>();
    const actions = stubActions({ onSave: () => pending.promise });
    const view = render(editorElement(actions));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "First edit" },
    });
    fireEvent.click(saveButton());
    const theirs = { ...checkoutTemplate, revision: 6, name: "Their edit" };
    view.rerender(editorElement(actions, { template: theirs }));

    await act(async () =>
      pending.resolve({
        kind: "saved",
        template: { ...checkoutTemplate, revision: 5, name: "First edit" },
      }),
    );

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Their edit",
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(actions.onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 6 }),
    );
  });

  it("never steps back to an older revision a refresh brings", () => {
    const actions = stubActions();
    const view = render(
      editorElement(actions, {
        template: { ...checkoutTemplate, revision: 5, name: "Current" },
      }),
    );
    view.rerender(editorElement(actions, { template: checkoutTemplate }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Current",
    );
  });
});

describe("model aliases", () => {
  it("shows an authored alias as its canonical model, leaving the document as authored", () => {
    const catalog = backendModelCatalogSchema.parse({
      backend: "cursor",
      defaultModelId: "composer-2.5",
      models: [
        {
          id: "composer-2.5",
          label: "Composer 2.5",
          aliases: ["composer"],
          parameters: [],
          variants: [
            {
              selection: { modelId: "composer-2.5", parameters: {} },
              label: "Composer 2.5",
              isDefault: true,
            },
          ],
        },
      ],
      provenance: { source: "test" },
    });
    const aliased = {
      ...quickCheckTemplate,
      defaults: {
        implementer: {
          profile: { tier: "builtin", id: "standard-agent" },
          backend: "cursor",
          modelSelection: { modelId: "composer", parameters: {} },
        },
      },
    } satisfies RunTemplateRecord;
    render(
      <TooltipProvider>
        <TemplateEditor
          templates={templateList}
          template={aliased}
          tier="project"
          globals={RUN_SETTING_DEFAULTS}
          options={{
            ...options,
            models: [
              ...modelOptions,
              {
                backend: "cursor",
                models: [],
                defaultModelId: "composer-2.5",
                source: "catalog",
                modelCatalog: catalog,
                defaultSelection: { modelId: "composer-2.5", parameters: {} },
                diagnostics: [],
              },
            ],
          }}
          actions={stubActions()}
        />
      </TooltipProvider>,
    );
    const implementer = screen.getByRole("region", { name: "Implementer" });
    expect(
      within(implementer).getByRole("combobox", { name: "Model" }),
    ).toHaveTextContent("Composer 2.5");
    expect(
      screen.queryByRole("region", { name: "Unsaved changes" }),
    ).toBeNull();
  });
});

describe("focus is not an edit", () => {
  it("follows a newer inherited value in a focused, untouched field, and writes nothing on blur", () => {
    const actions = stubActions();
    const inheriting = {
      ...checkoutTemplate,
      defaults: { ...checkoutTemplate.defaults, timeoutMs: 600_000 },
    };
    const view = render(
      editorElement(actions, {
        template: inheriting,
        initialSelection: "plan",
      }),
    );
    const input = screen.getByRole("spinbutton", {
      name: "Turn time limit in minutes",
    });
    fireEvent.focus(input);
    view.rerender(
      editorElement(actions, {
        template: {
          ...inheriting,
          revision: 5,
          defaults: { ...inheriting.defaults, timeoutMs: 1_200_000 },
        },
        initialSelection: "plan",
      }),
    );
    expect(input).toHaveValue(20);

    fireEvent.blur(input);

    expect(
      screen.queryByRole("region", { name: "Unsaved changes" }),
    ).toBeNull();
  });
});

describe("template editing", () => {
  it("does not create an override by focusing and leaving an inherited field", () => {
    editor("plan");
    const input = screen.getByRole("spinbutton", {
      name: "Turn time limit in minutes",
    });
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(
      screen.queryByRole("region", { name: "Unsaved changes" }),
    ).toBeNull();
  });

  it("edits the time limit in minutes, stores milliseconds, and clears it to none", async () => {
    const actions = stubActions({
      onSave: (content, baseRevision) => ({
        kind: "saved",
        template: {
          ...checkoutTemplate,
          ...content,
          revision: baseRevision + 1,
        },
      }),
    });
    render(editorElement(actions));
    const timeout = screen.getByRole("spinbutton", {
      name: "Turn time limit in minutes",
    });
    fireEvent.focus(timeout);
    fireEvent.change(timeout, { target: { value: "" } });
    expect(timeout).toHaveValue(null);
    fireEvent.change(timeout, { target: { value: "12" } });
    fireEvent.blur(timeout);
    fireEvent.click(saveButton());
    expect(savedContent(actions).content.defaults.timeoutMs).toBe(720_000);
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Unsaved changes" }),
      ).toBeNull(),
    );
    fireEvent.focus(timeout);
    fireEvent.change(timeout, { target: { value: "" } });
    fireEvent.blur(timeout);
    fireEvent.click(saveButton(6));
    expect(savedContent(actions).content.defaults.timeoutMs).toBeNull();
  });

  it("keeps the parameter input focused across edits", () => {
    editor();
    const name = screen.getByRole("textbox", { name: "Parameter 1 name" });
    name.focus();
    fireEvent.change(name, { target: { value: "feature" } });
    expect(
      screen.getByRole("textbox", { name: "Parameter 1 name" }),
    ).toHaveFocus();
  });

  it("saves task instructions, and leaves empty ones out", () => {
    const actions = editor("plan");
    fireEvent.click(screen.getByText("Instructions for task 1"));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Task 1 instructions" }),
      { target: { value: "Start from the spec's summary." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove task 2" }));
    fireEvent.click(saveButton());
    expect(contextIn(savedContent(actions).content, "plan").tasks).toEqual([
      {
        title: "Read the spec and the current code",
        instructions: "Start from the spec's summary.",
      },
      {
        title: "Return the rollout plan",
        instructions: "Include the complete plan in your closing response.",
      },
    ]);
  });

  it("blocks saving malformed output JSON and launching an unsaved revision", () => {
    editor("api");
    fireEvent.change(screen.getByRole("textbox", { name: /Output schema/ }), {
      target: { value: "{" },
    });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("api · outputSchema");
  });

  it("commits a corrected output schema as an object", () => {
    const actions = editor("plan");
    fireEvent.change(screen.getByRole("textbox", { name: /Output schema/ }), {
      target: {
        value: '{"type":"object","properties":{"done":{"type":"boolean"}}}',
      },
    });
    fireEvent.click(saveButton());
    expect(
      contextIn(savedContent(actions).content, "plan").outputSchema,
    ).toEqual({ type: "object", properties: { done: { type: "boolean" } } });
  });

  it("gives every seat, reviewers included, a profile", () => {
    editor("api");
    expect(screen.getAllByRole("combobox", { name: "Profile" })).toHaveLength(
      3,
    );
  });

  it("allows removal of an unused parameter", () => {
    const template = {
      ...checkoutTemplate,
      parameters: [
        ...checkoutTemplate.parameters,
        { name: "unused", description: "Unused", required: false },
      ],
    };
    const actions = editor(TEMPLATE_PART, template);
    fireEvent.click(screen.getByRole("button", { name: "Remove parameter 2" }));
    fireEvent.click(saveButton());
    expect(savedContent(actions).content.parameters).toEqual(
      checkoutTemplate.parameters,
    );
  });

  it.each(["remove", "rename"])(
    "blocks saving when parameter %s leaves an {{inputs.<name>}} reference undeclared",
    (operation) => {
      editor();
      if (operation === "remove")
        fireEvent.click(
          screen.getByRole("button", { name: "Remove parameter 1" }),
        );
      else
        fireEvent.change(
          screen.getByRole("textbox", { name: "Parameter 1 name" }),
          { target: { value: "feature" } },
        );
      expect(saveButton()).toBeDisabled();
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(
        'plan · brief: {{inputs.flag}} names parameter "flag", which the template does not declare',
      );
      expect(alert).toHaveTextContent("api · brief");
    },
  );

  it("refuses a token in the old {{name}} grammar where parameters are substituted", () => {
    editor("plan");
    fireEvent.change(screen.getByRole("textbox", { name: "Brief" }), {
      target: { value: "Read the {{flag}} spec." },
    });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      'plan · brief: "{{flag}} spec." is not a parameter token',
    );
  });
});

describe("template launch", () => {
  const launchable = {
    tier: "project" as const,
    id: checkoutTemplate.id,
    name: checkoutTemplate.name,
    revision: checkoutTemplate.revision,
    parameters: checkoutTemplate.parameters,
    contexts: checkoutTemplate.workflow.contexts.length,
  };

  it("sends the revision it showed, the owner and the parameter values", () => {
    const onLaunch = vi.fn();
    render(
      <TooltipProvider>
        <LaunchDialog
          open
          template={launchable}
          sessionName="Test session"
          owners={[]}
          onOpenChange={vi.fn()}
          onLaunch={onLaunch}
        />
      </TooltipProvider>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /^flag/ }), {
      target: { value: "checkout-v3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch run" }));
    expect(onLaunch).toHaveBeenCalledWith({
      template: { tier: "project", id: checkoutTemplate.id, revision: 4 },
      owner: { kind: "new", title: "Checkout rollout owner" },
      parameters: { flag: "checkout-v3" },
    });
  });

  it("clears a field refusal when that parameter is corrected", () => {
    render(
      <TooltipProvider>
        <LaunchDialog
          open
          template={launchable}
          sessionName="Test session"
          owners={[]}
          initialValues={{ flag: "old" }}
          refusal={{ parameter: "flag", message: "No such flag." }}
          onOpenChange={vi.fn()}
          onLaunch={vi.fn()}
        />
      </TooltipProvider>,
    );
    const input = screen.getByRole("textbox", { name: /^flag/ });
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(input, { target: { value: "corrected" } });
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("No such flag.")).not.toBeInTheDocument();
  });

  it("resets launch inputs and owner state when the template tier changes", () => {
    const props = {
      open: true,
      sessionName: "Test session",
      owners: [],
      onOpenChange: vi.fn(),
      onLaunch: vi.fn(),
    };
    const view = render(
      <TooltipProvider>
        <LaunchDialog
          {...props}
          template={launchable}
          initialValues={{ flag: "old" }}
        />
      </TooltipProvider>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Previous owner" },
    });
    view.rerender(
      <TooltipProvider>
        <LaunchDialog
          {...props}
          template={{ ...launchable, tier: "global", name: "Another" }}
          initialValues={{ flag: "fresh" }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Another owner",
    );
    expect(screen.getByRole("textbox", { name: /^flag/ })).toHaveValue("fresh");
  });

  it("requires a name for a new owner before launching", () => {
    const onLaunch = vi.fn();
    render(
      <TooltipProvider>
        <LaunchDialog
          open
          template={launchable}
          sessionName="Test session"
          owners={[]}
          initialValues={{ flag: "checkout-v3" }}
          onOpenChange={vi.fn()}
          onLaunch={onLaunch}
        />
      </TooltipProvider>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: " " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch run" }));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Enter a name for the owner conversation.",
      ),
    ).toBeVisible();
  });
});
