import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MergeConflictsPage from "@/features/session/dialogs/MergeConflictsPage";
import type { ConflictEntry } from "@/features/session/dialogs/MergeConflictsPage";

const sampleConflicts: ConflictEntry[] = [
  {
    file: "src/lib/sessions.ts",
    description:
      "Both branches modified the createSession function — main added input validation with Zod, feature branch changed the return type to include a status field.",
    resolution:
      "Keep both: apply the Zod validation from main and the extended return type from the feature branch. The validation runs before the return statement, so they compose cleanly.",
    rationale:
      "The changes are additive and non-overlapping. The validation guards apply before the return, so both can coexist without losing work from either branch.",
  },
  {
    file: "src/app/api/projects/[name]/sessions/route.ts",
    description:
      "Main refactored the POST handler to extract logic into a createSessionHandler helper function; feature branch added a new 'template' query parameter to the original inline handler.",
    resolution:
      "Use main's refactored structure as the base and port the template query parameter handling into the createSessionHandler helper function.",
    rationale:
      "Main's refactoring is structural and affects the overall code organization — it should be the base. The template parameter is a localized addition that can be cleanly ported into the new function structure.",
  },
  {
    file: "src/types/index.ts",
    description:
      "Both branches added new type exports at the end of the file — main added MergeResult and MergeError, feature branch added ConflictEntry and ConflictResolution.",
    resolution:
      "Keep all four type exports — they are independent additions that don't overlap.",
    rationale:
      "No overlap exists. Each pair of types is used in different parts of the codebase (merge flow vs. conflict resolution) and they can coexist without any naming conflicts.",
  },
  {
    file: "src/lib/git-operations.ts",
    description:
      "Main updated the squashMerge function to handle the --no-ff flag; feature branch modified the same function to add a pre-merge validation step that checks for untracked files.",
    resolution:
      "Merge both changes: keep the --no-ff flag handling from main and add the pre-merge untracked file validation from the feature branch before the merge command execution.",
    rationale:
      "Both changes modify different aspects of the same function. The --no-ff flag is a merge strategy concern, while the untracked file check is a pre-condition. They should be sequenced: validate first, then merge with --no-ff.",
  },
  {
    file: "package.json",
    description:
      "Both branches added dependencies — main added 'zod-validation-error@3.4.0', feature branch added 'diff-match-patch@1.0.5'. Both are in the dependencies section at similar positions.",
    resolution:
      "Keep both dependencies. Sort them alphabetically as is the convention.",
    rationale:
      "Independent package additions that don't conflict. Alphabetical sorting resolves the positional overlap in a deterministic way.",
  },
];

const meta = {
  title: "Session/MergeConflictsPage",
  component: MergeConflictsPage,
  args: {
    projectName: "my-app",
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    conflicts: sampleConflicts,
    onAcceptAll: fn(),
    onFixApproved: fn(),
    onBack: fn(),
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof MergeConflictsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default state — all conflicts pending review */
export const Default = {
  args: {},
} satisfies Story;

/** Single conflict */
export const SingleConflict = {
  args: {
    conflicts: [sampleConflicts[0]!],
  },
} satisfies Story;

/** Many conflicts (5 files) */
export const ManyConflicts = {
  args: {},
} satisfies Story;
