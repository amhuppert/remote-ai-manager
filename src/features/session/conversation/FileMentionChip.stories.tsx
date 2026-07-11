import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { DocumentScopeProvider } from "@/components/conversation/document-scope";
import {
  FileMentionChipBody,
  FILE_MENTION_WRAPPER_CLASS,
} from "./FileMentionChip";

function MarkdownMentionStory(): React.JSX.Element {
  return (
    <DocumentScopeProvider
      value={{
        projectName: "command-center",
        sessionName: "markdown-access",
        worktreePath: "/workspace/command-center",
      }}
    >
      <span className={FILE_MENTION_WRAPPER_CLASS}>
        <FileMentionChipBody
          attrs={{ path: "docs/plan.md", basename: "plan.md", ext: "md" }}
          onRemove={fn()}
        />
      </span>
    </DocumentScopeProvider>
  );
}

const meta = {
  title: "Session/Prompt/FileMentionChip",
  component: MarkdownMentionStory,
  decorators: [
    (Story) => (
      <div className="bg-bg-void p-xl font-mono text-text-primary">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MarkdownMentionStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Markdown = {} satisfies Story;
