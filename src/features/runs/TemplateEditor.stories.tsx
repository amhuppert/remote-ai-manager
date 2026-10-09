import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { LaunchDialog } from "./components/template/LaunchDialog";
import { TemplateEditor, type TemplateEditorActions } from "./components/template/TemplateEditor";
import { catalog, checkoutTemplate, efforts, ownerChoices, profiles, templateList, validationCommands } from "./template-fixtures";
import type { Template } from "./template-model";

const options = { catalog, efforts, profiles, checks: validationCommands };
const actions: TemplateEditorActions = { onReload: fn(() => checkoutTemplate), onSelectTemplate: fn(), onSave: fn(), onLaunch: fn() };

/** The same template after a few edits: a brief, an approval setting and a new task. */
const edited: Template = {
  ...checkoutTemplate,
  contexts: checkoutTemplate.contexts.map((context) =>
    context.key === "ui"
      ? {
          ...context,
          brief: `${context.brief} Use the design system's form primitives.`,
          tasks: [...context.tasks, { id: "t4", title: "Keyboard pass over every step", instructions: "" }],
          config: { ...context.config, validationRetries: { value: 4, from: "context" } },
        }
      : context,
  ),
};

const meta = {
  title: "Runs/Template editor",
  component: TemplateEditor,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[100dvh]">
        <Story />
      </div>
    ),
  ],
  args: { templates: templateList, template: checkoutTemplate, options, actions },
} satisfies Meta<typeof TemplateEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The template's details and the defaults every context inherits. */
export const DetailsAndDefaults: Story = {};

/** A context that sets its own implementer and reviewers; the rest is inherited. */
export const ContextWithOverrides: Story = { args: { initialSelection: "migrate" } };

/** A context with an output schema, in a loop. */
export const ContextInALoop: Story = { args: { initialSelection: "polish" } };

/** Unsaved edits: the context and the save bar say so. */
export const UnsavedChanges: Story = { args: { initialSelection: "ui", initialDraft: edited } };

/** Someone saved a newer revision while these edits were made. */
function ConflictExample() {
  const [template, setTemplate] = useState(checkoutTemplate);
  const [conflict, setConflict] = useState(true);
  return <TemplateEditor templates={templateList} template={template} options={options} initialSelection="ui" initialDraft={edited} saveState={conflict ? "conflict" : "idle"} actions={{
    ...actions,
    onReload: () => {
      const latest = { ...checkoutTemplate, revision: 5, description: "Latest saved revision: the rollout includes a read-only integration check." };
      setTemplate(latest);
      setConflict(false);
      return latest;
    },
  }} />;
}
export const SaveConflict: Story = { render: () => <ConflictExample /> };

/** The template's structure, read-only; selecting a context opens it for editing. */
export const Structure: Story = { args: { initialView: "diagram" } };

function EditorWithLaunch({
  refusal,
  values,
}: {
  refusal?: { message: string; parameter?: string };
  values?: Record<string, string>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <TemplateEditor
        templates={templateList}
        template={checkoutTemplate}
        options={options}
        actions={{ ...actions, onLaunch: () => setOpen(true) }}
      />
      <LaunchDialog
        open={open}
        template={checkoutTemplate}
        sessionName="Graph Workflow Overhaul"
        owners={ownerChoices}
        refusal={refusal ?? null}
        initialValues={values ?? {}}
        onOpenChange={setOpen}
        onLaunch={fn()}
      />
    </>
  );
}

/** Launching: pick the owner conversation, fill the parameters. */
export const Launch: Story = { render: () => <EditorWithLaunch /> };

/** A launch the server refused, located at its parameter. */
export const LaunchRefused: Story = {
  render: () => (
    <EditorWithLaunch
      values={{ flag: "checkout-v3" }}
      refusal={{ message: "No flag named checkout-v3 exists in config/flags.ts.", parameter: "flag" }}
    />
  ),
};
