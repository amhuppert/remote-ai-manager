import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { fn } from "storybook/test";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import type {
  ValidatorAssignment,
  ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import {
  CohortEditor,
  toggleCohortEnabled,
  type CohortCascadeProvenance,
} from "./CohortEditor";

// The cohort editor reads its options through the production library query, so
// the canvas seeds that query's cache rather than passing options in — the
// story then exercises the same wiring a real surface gets.
const PROJECT = "acme-web";

const LISTING: AgentProfileLibraryListing = {
  profiles: [
    {
      ref: { tier: "builtin", id: "general-reviewer" },
      name: "General Reviewer",
      description: "Reviews a diff against the context's acceptance criteria.",
      revision: 1,
      recommendedFor: ["workflow_validator"],
      tags: [],
      readOnly: true,
    },
    {
      ref: { tier: "global", id: "security-reviewer" },
      name: "Security Reviewer",
      description: "Reads a diff for exploitable defects.",
      revision: 4,
      recommendedFor: ["workflow_validator"],
      tags: ["security"],
      readOnly: false,
    },
    {
      ref: { tier: "project", id: "house-style" },
      name: "House Style",
      description: "Holds this repo's conventions.",
      revision: 2,
      recommendedFor: ["workflow_implementer", "workflow_validator"],
      tags: [],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

function assignment(
  id: string,
  overrides: Partial<ValidatorAssignment> = {},
): ValidatorAssignment {
  return {
    id,
    profile: { tier: "builtin", id: "general-reviewer" },
    authority: "blocking",

    agent: {
      backend: "claude",
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    },
    ...overrides,
  };
}

// The realistic shape: one authored blocking seat (the acceptance-criteria
// verifier) alongside specialists that only advise.
const COHORT: ValidatorCohort = {
  enabled: true,
  assignments: [
    assignment("general"),
    assignment("security", {
      profile: { tier: "global", id: "security-reviewer" },
      authority: "advisory",
      focus: "auth boundaries and session fixation",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    }),
    assignment("house-style", {
      profile: { tier: "project", id: "house-style" },
      authority: "advisory",
    }),
  ],
};

function Canvas({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
    return queryClient;
  });
  return (
    <QueryClientProvider client={client}>
      <div
        style={{ width: 460, padding: 16, background: "var(--bg-surface)" }}
        className="flex flex-col gap-md"
      >
        {children}
      </div>
    </QueryClientProvider>
  );
}

/** Stateful harness: the editor is pure value+onChange, so this is all it needs. */
function Harness({
  initial = COHORT,
  cascade,
  readOnly,
  withReset,
}: {
  initial?: ValidatorCohort;
  cascade?: CohortCascadeProvenance;
  readOnly?: boolean;
  withReset?: boolean;
}) {
  const [cohort, setCohort] = useState<ValidatorCohort>(initial);
  return (
    <Canvas>
      <label className="flex items-center gap-sm font-mono text-[0.72rem] text-text-secondary">
        <input
          type="checkbox"
          checked={cohort.enabled}
          onChange={(event) =>
            setCohort(toggleCohortEnabled(cohort, event.target.checked))
          }
        />
        Context validator enabled
      </label>
      <CohortEditor
        value={cohort}
        onChange={setCohort}
        libraryProjectName={PROJECT}
        readOnly={readOnly}
        {...(cascade ? { cascade } : {})}
        {...(withReset ? { onResetAssignment: fn() } : {})}
      />
    </Canvas>
  );
}

const meta = {
  title: "WorkflowConfig/CohortEditor",
  component: CohortEditor,
  args: { value: COHORT, onChange: fn() },
} satisfies Meta<typeof CohortEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three required validators reviewing one frozen candidate, in order. */
export const Default: Story = {
  render: () => <Harness />,
};

/** One assignment: the seeded shape, where Remove is refused. */
export const SingleAssignment: Story = {
  render: () => (
    <Harness
      initial={{ enabled: true, assignments: [assignment("general")] }}
    />
  ),
};

/** Validation off — every assignment stays visible, dormant, and restorable. */
export const DormantCohort: Story = {
  render: () => <Harness initial={{ ...COHORT, enabled: false }} />,
};

/** Inherited from the tier above: the cohort on screen is not authored here. */
export const InheritedFromGlobalDefaults: Story = {
  render: () => (
    <Harness
      cascade={{ state: "inherit", origin: "global defaults" }}
      readOnly
    />
  ),
};

/** Authored at this tier — the affordances say which tier they edit. */
export const OverriddenForThisContext: Story = {
  render: () => <Harness cascade={{ state: "use", origin: "this context" }} />,
};

/** Turned off for this context specifically, with the dormant set intact. */
export const DisabledForThisContext: Story = {
  render: () => (
    <Harness
      initial={{ ...COHORT, enabled: false }}
      cascade={{ state: "disabled", origin: "this context" }}
    />
  ),
};

/** A legal roster with no blocking seat at all: every finding is a suggestion. */
export const AdvisoryOnlyRoster: Story = {
  render: () => (
    <Harness
      initial={{
        enabled: true,
        assignments: [
          assignment("security", {
            profile: { tier: "global", id: "security-reviewer" },
            authority: "advisory",
          }),
          assignment("house-style", {
            profile: { tier: "project", id: "house-style" },
            authority: "advisory",
          }),
        ],
      }}
    />
  ),
};

/** A focus carrying a reserved sequence: refused inline, where it is authored. */
export const FocusRefusal: Story = {
  render: () => (
    <Harness
      initial={{
        enabled: true,
        assignments: [
          assignment("general", {
            focus: "review the ```ts blocks in the diff",
          }),
        ],
      }}
    />
  ),
};

/** The runtime surface: each lane can be reset without disturbing its siblings. */
export const WithPerAssignmentReset: Story = {
  render: () => <Harness withReset />,
};
