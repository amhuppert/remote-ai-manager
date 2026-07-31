import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { TemplateLibraryItem } from "@/lib/workflow-graph/template-library-service";
import TemplateLibrary from "./TemplateLibrary";

const parameterizedGlobal: TemplateLibraryItem = {
  tier: "global",
  id: "kiro-spec",
  name: "Kiro Spec Workflow",
  description:
    "Methodology-level spec-driven workflow, reusable across projects.",
  revision: 3,
  parameters: [
    {
      type: "string",
      name: "feature",
      label: "Feature name",
      required: true,
      default: "checkout-revamp",
    },
    {
      type: "enum",
      name: "mode",
      label: "Creation mode",
      required: true,
      options: ["fast", "focus", "thorough"],
      default: "focus",
    },
  ],
  prerequisites: [
    { kind: "path", path: ".kiro", label: "Kiro spec directory" },
    {
      kind: "skill",
      skill: "kiro-spec-design",
      backend: "claude",
      label: "Design generator",
    },
    { kind: "skill", skill: "kiro-spec-tasks" },
  ],
};

const projectNoPrereqs: TemplateLibraryItem = {
  tier: "project",
  id: "local-fix",
  name: "Local Fix Workflow",
  description: "Project-local quick-fix workflow with no prerequisites.",
  revision: 1,
  parameters: [],
  prerequisites: [],
};

const projectSameName: TemplateLibraryItem = {
  ...parameterizedGlobal,
  tier: "project",
  id: "kiro-spec-local",
  description: "A project-local template sharing a name with the global one.",
};

const items: TemplateLibraryItem[] = [
  parameterizedGlobal,
  projectNoPrereqs,
  projectSameName,
];

const meta = {
  title: "Workflows/TemplateLibrary",
  component: TemplateLibrary,
  parameters: {
    a11y: { test: "error" },
  },
  args: {
    items,
    onLaunch: fn(),
    onSelectTemplate: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 520, padding: 16, background: "var(--bg-base)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TemplateLibrary>;

export default meta;
type Story = StoryObj<typeof meta>;

// Both tiers in one listing, each tagged; same-name templates across tiers
// shown distinctly (R7.1). No template selected yet.
export const Browsing = {} satisfies Story;

// A parameterized global template selected: its prerequisites (path + scoped /
// unscoped skills) are visible before launch, and the parameter form is shown
// (R7.2, R7.3).
export const SelectedWithPrerequisites = {
  args: {
    selectedTemplate: { id: "kiro-spec", tier: "global" },
  },
} satisfies Story;

// A project template with no parameters and no prerequisites — the "no
// prerequisites" indication and a zero-input launch form (R7.2, R7.6).
export const SelectedNoPrerequisites = {
  args: {
    selectedTemplate: { id: "local-fix", tier: "project" },
  },
} satisfies Story;

// The start-time prerequisite gate rejected the launch: each missing
// prerequisite is itemized by kind (with its scoped backend and a reason that
// distinguishes definitively-absent from could-not-be-evaluated), and the run
// is reflected as not started (R7.4).
export const PrerequisitesUnmet = {
  args: {
    selectedTemplate: { id: "kiro-spec", tier: "global" },
    launchOutcome: {
      status: "prerequisites_unmet",
      missing: [
        { kind: "path", path: ".kiro", label: null, reason: "absent" },
        {
          kind: "skill",
          skill: "kiro-spec-design",
          backend: "claude",
          label: null,
          reason: "probe_error",
        },
        {
          kind: "skill",
          skill: "kiro-spec-tasks",
          backend: null,
          label: null,
          reason: "absent",
        },
      ],
    },
  },
} satisfies Story;

// A non-prerequisite rejection (e.g. uncommitted changes): the distinct reason
// is surfaced and the run is reflected as not started (R7.5).
export const Rejected = {
  args: {
    selectedTemplate: { id: "kiro-spec", tier: "global" },
    launchOutcome: {
      status: "rejected",
      reason: "Worktree has uncommitted changes. Commit or stash them first.",
    },
  },
} satisfies Story;

// A launch that passed all gates and started (R7.6).
export const Started = {
  args: {
    selectedTemplate: { id: "local-fix", tier: "project" },
    launchOutcome: { status: "started" },
  },
} satisfies Story;

// No templates available in either tier → an EmptyState (R7.7).
export const Empty = {
  args: {
    items: [],
  },
} satisfies Story;
