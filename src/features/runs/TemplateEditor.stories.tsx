import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import type { RunTemplateContent } from "@/lib/run-templates/document";
import { RUN_SETTING_DEFAULTS } from "@/lib/runs/settings";
import { LaunchDialog } from "./components/template/LaunchDialog";
import {
  TemplateEditor,
  type TemplateEditorActions,
} from "./components/template/TemplateEditor";
import {
  checkoutTemplate,
  modelOptions,
  ownerChoices,
  profileOptions,
  quickCheckTemplate,
  templateList,
  validationCommands,
} from "./template-fixtures";
import {
  TEMPLATE_PART,
  contentOf,
  editContext,
  setContextSetting,
} from "./template-model";

const options = {
  models: modelOptions,
  profiles: profileOptions,
  checks: validationCommands,
};
const actions: TemplateEditorActions = {
  onReload: fn(() => checkoutTemplate),
  onSelectTemplate: fn(),
  onSave: fn((content: RunTemplateContent, baseRevision: number) => ({
    kind: "saved" as const,
    template: { ...checkoutTemplate, ...content, revision: baseRevision + 1 },
  })),
  onLaunch: fn(),
};

/** The same template after a few edits: a brief, a new task and a time-limit override. */
const edited: RunTemplateContent = setContextSetting(
  editContext(contentOf(checkoutTemplate), "ui", {
    brief:
      "Build the steps on the new API. Follow the copy in the spec; empty states point at the next action. Use the design system's form primitives.",
    tasks: [
      { title: "Payment step", instructions: "" },
      { title: "Review and confirmation steps", instructions: "" },
      { title: "Empty and error states", instructions: "" },
      { title: "Keyboard pass over every step", instructions: "" },
    ],
  }),
  "ui",
  "timeoutMs",
  1_800_000,
);

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
  args: {
    templates: templateList,
    template: checkoutTemplate,
    tier: "project",
    globals: RUN_SETTING_DEFAULTS,
    options,
    actions,
  },
} satisfies Meta<typeof TemplateEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The template's details and the defaults every context inherits. */
export const DetailsAndDefaults: Story = {};

/** A template that sets nothing: every setting is the Command Center default. */
export const CommandCenterDefaults: Story = {
  args: { template: quickCheckTemplate },
};

/** A context that sets its own implementer and reviewers; the rest is inherited. */
export const ContextWithOverrides: Story = {
  args: { initialSelection: "migrate" },
};

/** A context with an output schema, in a loop. */
export const ContextInALoop: Story = { args: { initialSelection: "polish" } };

/** Unsaved edits: the context and the save bar say so. */
export const UnsavedChanges: Story = {
  args: { initialSelection: "ui", initialDraft: edited },
};

/** A parameter token that names nothing the template declares. */
export const UndeclaredParameter: Story = {
  args: {
    initialSelection: "plan",
    initialDraft: editContext(contentOf(checkoutTemplate), "plan", {
      brief: "Read the {{inputs.spec}} spec and the current code.",
    }),
  },
};

/** Someone saved a newer revision while these edits were made. */
function ConflictExample() {
  const [template, setTemplate] = useState(checkoutTemplate);
  return (
    <TemplateEditor
      templates={templateList}
      template={template}
      tier="project"
      globals={RUN_SETTING_DEFAULTS}
      options={options}
      initialSelection="ui"
      initialDraft={edited}
      initialSaveState="conflict"
      actions={{
        ...actions,
        onReload: () => {
          const latest = {
            ...checkoutTemplate,
            revision: 5,
            description:
              "Latest saved revision: the rollout includes a read-only integration check.",
          };
          setTemplate(latest);
          return latest;
        },
      }}
    />
  );
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
        tier="project"
        globals={RUN_SETTING_DEFAULTS}
        options={options}
        initialSelection={TEMPLATE_PART}
        actions={{ ...actions, onLaunch: () => setOpen(true) }}
      />
      <LaunchDialog
        open={open}
        template={{
          tier: "project",
          id: checkoutTemplate.id,
          name: checkoutTemplate.name,
          revision: checkoutTemplate.revision,
          parameters: checkoutTemplate.parameters,
          contexts: checkoutTemplate.workflow.contexts.length,
        }}
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
      refusal={{
        message: "No flag named checkout-v3 exists in config/flags.ts.",
        parameter: "flag",
      }}
    />
  ),
};
