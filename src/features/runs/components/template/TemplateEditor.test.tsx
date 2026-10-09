// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { Template } from "../../template-model";
import { TemplateEditor } from "./TemplateEditor";
import { LaunchDialog } from "./LaunchDialog";
import { catalog, checkoutTemplate, efforts, profiles, templateList, validationCommands } from "../../template-fixtures";

const options = { catalog, efforts, profiles, checks: validationCommands };
function editor(initialSelection = "defaults", template = checkoutTemplate) {
  const actions = { onReload: vi.fn(() => checkoutTemplate), onSelectTemplate: vi.fn(), onSave: vi.fn(), onLaunch: vi.fn() };
  render(<TooltipProvider><TemplateEditor templates={templateList} template={template} options={options} actions={actions} initialSelection={initialSelection} /></TooltipProvider>);
  return actions;
}

afterEach(cleanup);

describe("template acknowledgments", () => {
  it("adopts the saved base revision while preserving edits made after submission", async () => {
    const pending = Promise.withResolvers<Template>();
    const actions = { onReload: vi.fn(() => checkoutTemplate), onSelectTemplate: vi.fn(), onSave: vi.fn().mockReturnValueOnce(pending.promise), onLaunch: vi.fn() };
    const view = render(<TooltipProvider><TemplateEditor templates={templateList} template={checkoutTemplate} options={options} actions={actions} /></TooltipProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "First edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 5" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "A later edit" } });
    const snapshot = { ...checkoutTemplate, revision: 5, name: "First edit" };
    await act(async () => pending.resolve(snapshot));
    view.rerender(<TooltipProvider><TemplateEditor templates={templateList} template={snapshot} options={options} actions={actions} /></TooltipProvider>);
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("A later edit");
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 6" }));
    expect(actions.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 5, name: "First edit", description: "A later edit" }));
  });

  it("replaces same-template values when an explicit reload is acknowledged", async () => {
    const snapshot = { ...checkoutTemplate, revision: 5, name: "Reloaded title" };
    const actions = { onReload: vi.fn().mockResolvedValue(snapshot), onSelectTemplate: vi.fn(), onSave: vi.fn(), onLaunch: vi.fn() };
    const view = render(<TooltipProvider><TemplateEditor templates={templateList} template={checkoutTemplate} initialDraft={{ ...checkoutTemplate, name: "Local edit" }} saveState="conflict" options={options} actions={actions} /></TooltipProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    expect(actions.onReload).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Local edit");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(actions.onReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and reload" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Reloaded title"));
    expect(actions.onReload).toHaveBeenCalledTimes(1);
    expect(actions.onSelectTemplate).not.toHaveBeenCalled();
    view.rerender(<TooltipProvider><TemplateEditor templates={templateList} template={snapshot} options={options} actions={actions} /></TooltipProvider>);
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();
  });

  it("preserves dirty values and their base revision across an unsolicited refresh", () => {
    const actions = { onReload: vi.fn(() => checkoutTemplate), onSelectTemplate: vi.fn(), onSave: vi.fn(), onLaunch: vi.fn() };
    const view = render(<TooltipProvider><TemplateEditor templates={templateList} template={checkoutTemplate} initialDraft={{ ...checkoutTemplate, name: "Local edit" }} options={options} actions={actions} /></TooltipProvider>);
    view.rerender(<TooltipProvider><TemplateEditor templates={templateList} template={{ ...checkoutTemplate, revision: 5, name: "Remote edit" }} options={options} actions={actions} /></TooltipProvider>);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Local edit");
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 5" }));
    expect(actions.onSave).toHaveBeenCalledWith(expect.objectContaining({ revision: 4, name: "Local edit" }));
  });
});

describe("template editing", () => {
  it("keeps a cleared number empty until blur and saves the replacement value", () => {
    const actions = editor();
    const input = screen.getByRole("spinbutton", { name: "Candidate changes" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue(null);
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 5" }));
    expect(actions.onSave).toHaveBeenCalledWith(expect.objectContaining({ defaults: expect.objectContaining({ instabilityLimit: { value: 4, from: "template" } }) }));
  });

  it("clamps a number only on blur and allows an empty time limit", () => {
    const actions = editor();
    const retries = screen.getByRole("spinbutton", { name: "Task retries" });
    fireEvent.focus(retries);
    fireEvent.change(retries, { target: { value: "-2" } });
    expect(retries).toHaveValue(-2);
    fireEvent.blur(retries);
    expect(retries).toHaveValue(0);
    const timeout = screen.getByRole("spinbutton", { name: "Turn time limit in minutes" });
    fireEvent.focus(timeout);
    fireEvent.change(timeout, { target: { value: "12" } });
    fireEvent.blur(timeout);
    fireEvent.focus(timeout);
    fireEvent.change(timeout, { target: { value: "" } });
    fireEvent.blur(timeout);
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 5" }));
    expect(actions.onSave).toHaveBeenCalledWith(expect.objectContaining({ defaults: expect.objectContaining({ timeoutMinutes: { value: null, from: "template" } }) }));
  });

  it("saves a context override reset with its inherited provenance", () => {
    const actions = editor("migrate");
    fireEvent.click(screen.getAllByRole("button", { name: "Use the template default" })[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 5" }));
    expect(actions.onSave).toHaveBeenCalledWith(expect.objectContaining({
      contexts: expect.arrayContaining([expect.objectContaining({ key: "migrate", config: expect.objectContaining({ implementer: checkoutTemplate.defaults.implementer }) })]),
    }));
  });

  it("keeps the parameter input focused across edits", () => {
    editor();
    const name = screen.getByRole("textbox", { name: "Parameter 1 name" });
    name.focus();
    fireEvent.change(name, { target: { value: "feature" } });
    expect(screen.getByRole("textbox", { name: "Parameter 1 name" })).toHaveFocus();
  });

  it("does not reuse a surviving task ID after deleting a task", () => {
    const actions = editor("plan");
    fireEvent.click(screen.getByRole("button", { name: "Remove t2" }));
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "task 3" }), { target: { value: "Check the rollout" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 5" }));
    const saved = actions.onSave.mock.calls[0]?.[0];
    const tasks = saved.contexts.find((context: { key: string }) => context.key === "plan").tasks;
    expect(new Set(tasks.map((task: { id: string }) => task.id)).size).toBe(tasks.length);
    expect(tasks.find((task: { id: string }) => task.id === "t3").title).toBe("Return the rollout plan");
  });

  it("exposes and saves task instructions", () => {
    const actions = editor("plan");
    fireEvent.click(screen.getByText("Instructions for t3"));
    fireEvent.change(screen.getByRole("textbox", { name: "Task t3 instructions" }), { target: { value: "Publish the agreed rollout plan." } });
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 5" }));
    expect(actions.onSave).toHaveBeenCalledWith(expect.objectContaining({ contexts: expect.arrayContaining([
      expect.objectContaining({ key: "plan", tasks: expect.arrayContaining([expect.objectContaining({ id: "t3", instructions: "Publish the agreed rollout plan." })]) }),
    ]) }));
  });

  it("blocks saving malformed output JSON and launching an unsaved revision", () => {
    editor("api");
    fireEvent.change(screen.getByRole("textbox", { name: /Output schema/ }), { target: { value: "{" } });
    expect(screen.getByRole("button", { name: "Save as revision 5" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  it("includes reviewer profiles in the editable seat configuration", () => {
    editor("api");
    expect(screen.getAllByRole("combobox", { name: "Profile" })).toHaveLength(3);
  });

  it("allows removal of an unused parameter", () => {
    const template = { ...checkoutTemplate, parameters: [...checkoutTemplate.parameters, { name: "unused", description: "Unused", required: false }] };
    const actions = editor("defaults", template);
    fireEvent.click(screen.getByRole("button", { name: "Remove parameter 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as revision 5" }));
    expect(actions.onSave).toHaveBeenCalledWith(expect.objectContaining({ parameters: checkoutTemplate.parameters }));
  });

  it("locates undeclared references across every editable context content field", () => {
    const template: Template = {
      ...checkoutTemplate,
      contexts: checkoutTemplate.contexts.map((context) => context.key === "plan" ? {
        ...context,
        title: "Title {{missing_title}}",
        brief: "Brief {{missing_brief}}",
        tasks: [{ id: "t1", title: "Task {{missing_task}}", instructions: "Follow {{missing_instructions}}" }],
        criteria: [{ id: "ac-1", text: "Prove {{missing_criterion}}" }],
        outputSchema: '{"type":"object","description":"{{missing_schema}}"}',
      } : context),
    };
    editor("plan", template);
    const alert = screen.getByRole("alert");
    for (const [field, parameter] of [["Title", "missing_title"], ["Brief", "missing_brief"], ["Task t1 title", "missing_task"], ["Task t1 instructions", "missing_instructions"], ["Criterion ac-1", "missing_criterion"], ["Output schema", "missing_schema"]]) {
      expect(alert).toHaveTextContent(`plan: ${field} references undeclared parameter {{${parameter}}}.`);
    }
  });

  it.each(["remove", "rename"])("blocks saving when parameter %s leaves a reference undeclared", (operation) => {
    editor();
    if (operation === "remove") fireEvent.click(screen.getByRole("button", { name: "Remove parameter 1" }));
    else fireEvent.change(screen.getByRole("textbox", { name: "Parameter 1 name" }), { target: { value: "feature" } });
    expect(screen.getByRole("button", { name: "Save as revision 5" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("plan: Brief references undeclared parameter {{flag}}.");
    expect(screen.getByRole("alert")).toHaveTextContent("api: Brief references undeclared parameter {{flag}}.");
  });
});

describe("template launch", () => {
  it("clears a field refusal when that parameter is corrected", () => {
    render(<TooltipProvider><LaunchDialog open template={checkoutTemplate} sessionName="Test session" owners={[]} initialValues={{ flag: "old" }} refusal={{ parameter: "flag", message: "No such flag." }} onOpenChange={vi.fn()} onLaunch={vi.fn()} /></TooltipProvider>);
    const input = screen.getByRole("textbox", { name: /^flag/ });
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(input, { target: { value: "corrected" } });
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("No such flag.")).not.toBeInTheDocument();
  });

  it("resets launch inputs and owner state when the template tier changes", () => {
    const props = { open: true, sessionName: "Test session", owners: [], onOpenChange: vi.fn(), onLaunch: vi.fn() };
    const view = render(<TooltipProvider><LaunchDialog {...props} template={checkoutTemplate} initialValues={{ flag: "old" }} /></TooltipProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Previous owner" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^flag/ }), { target: { value: "edited" } });
    view.rerender(<TooltipProvider><LaunchDialog {...props} template={{ ...checkoutTemplate, tier: "global", name: "Another template" }} initialValues={{ flag: "fresh" }} /></TooltipProvider>);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Another template owner");
    expect(screen.getByRole("textbox", { name: /^flag/ })).toHaveValue("fresh");
  });

  it("requires a name for a new owner before launching", () => {
    const onLaunch = vi.fn();
    render(<TooltipProvider><LaunchDialog open template={checkoutTemplate} sessionName="Test session" owners={[]} initialValues={{ flag: "checkout-v3" }} onOpenChange={vi.fn()} onLaunch={onLaunch} /></TooltipProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Launch run" }));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByText("Enter a name for the owner conversation.")).toBeVisible();
  });
});


describe("numeric setting provenance", () => {
  it("does not create an override just by focusing and leaving an inherited field", () => {
    editor();
    const input = screen.getByRole("spinbutton", { name: "Candidate changes" });
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();
  });
});
