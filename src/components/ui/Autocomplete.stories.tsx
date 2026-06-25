import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  AutocompleteListbox,
  AutocompleteMatchText,
  AutocompleteNavFooter,
  AutocompleteOption,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
} from "./Autocomplete";

// The popup is `position: absolute` anchored to `bottom-full` of its container,
// so every story renders inside a relatively-positioned host with headroom above.
function PopupHost({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mt-[420px] w-[420px]">
      <div className="h-[44px] rounded-md border border-solid border-border-default bg-bg-surface" />
      {children}
    </div>
  );
}

const meta = {
  title: "UI/Autocomplete",
  component: AutocompleteListbox,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
  // Stories override the full tree via `render`; this default satisfies the
  // required `label` prop so render-only stories need no per-story args.
  args: { label: "Autocomplete" },
} satisfies Meta<typeof AutocompleteListbox>;

export default meta;
type Story = StoryObj<typeof meta>;

const COMMANDS = [
  {
    id: "/spec-init",
    name: "/spec-init",
    description: "Initialize a new specification",
    badge: "command",
    source: "user",
    matchIndices: [1, 2, 3, 4],
  },
  {
    id: "/kiro-impl",
    name: "/kiro-impl",
    description: "Implement spec tasks",
    badge: "command",
    source: "project",
  },
  {
    id: "$accessibility",
    name: "$accessibility",
    description: "Audit and improve web accessibility",
    badge: "skill",
    source: "user",
  },
];

/** Default command list with one active option, badges, and the match highlight. */
export const CommandList: Story = {
  render: () => (
    <PopupHost>
      <AutocompleteListbox
        label="Commands"
        activeIndex={0}
        maxHeightClassName="max-h-[340px]"
        isEmpty={false}
        header={
          <div className={autocompleteHeaderClass}>
            <span>Commands</span>
            <span className={autocompleteHeaderCountClass}>3 items</span>
          </div>
        }
        footer={<AutocompleteNavFooter />}
      >
        {COMMANDS.map((c, i) => (
          <AutocompleteOption
            key={c.id}
            active={i === 0}
            onHover={() => {}}
            onSelect={() => {}}
          >
            <AutocompleteMatchText
              text={c.name}
              indices={c.matchIndices ?? []}
              className="shrink-0 text-[0.8rem] whitespace-nowrap text-text-primary"
            />
            <span className="min-w-0 flex-1 overflow-hidden text-[0.72rem] text-ellipsis whitespace-nowrap text-text-secondary">
              {c.description}
            </span>
            <span className="shrink-0 text-[0.7rem] whitespace-nowrap text-text-tertiary">
              {c.source}
            </span>
          </AutocompleteOption>
        ))}
      </AutocompleteListbox>
    </PopupHost>
  ),
};

/** Two-line conversation rows (the `conversation` option variant) with status + archived dim. */
export const ConversationVariant: Story = {
  render: () => (
    <PopupHost>
      <AutocompleteListbox
        label="Conversations"
        activeIndex={0}
        maxHeightClassName="max-h-[380px]"
        header={
          <div className={autocompleteHeaderClass}>
            <span>Conversations — current project first</span>
            <span className={autocompleteHeaderCountClass}>2 of 50</span>
          </div>
        }
        footer={<AutocompleteNavFooter />}
      >
        <AutocompleteOption
          variant="conversation"
          active
          onHover={() => {}}
          onSelect={() => {}}
        >
          <div className="relative z-raised flex items-center gap-xs text-[0.82rem] text-text-primary">
            <AutocompleteMatchText
              text="Refactor parser"
              indices={[0, 1]}
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
            />
          </div>
          <div className="relative z-raised flex items-center gap-xs text-[0.72rem] text-text-secondary">
            <span className="text-text-tertiary">▸ </span>
            <span>current · main</span>
          </div>
        </AutocompleteOption>
        <AutocompleteOption
          variant="conversation"
          active={false}
          archived
          onHover={() => {}}
          onSelect={() => {}}
        >
          <div className="relative z-raised flex items-center gap-xs text-[0.82rem] text-text-primary">
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              Old experiment
            </span>
            <span className="rounded-full bg-[var(--cc-white-a04)] px-[5px] py-px text-[0.7rem] tracking-[0.04em] text-text-tertiary uppercase">
              archived
            </span>
          </div>
          <div className="relative z-raised flex items-center gap-xs text-[0.72rem] text-text-secondary">
            <span className="text-text-tertiary">▸ </span>
            <span>other-proj · feature</span>
          </div>
        </AutocompleteOption>
      </AutocompleteListbox>
    </PopupHost>
  ),
};

/** Loading state — the listbox is marked `aria-busy`. */
export const Loading: Story = {
  render: () => (
    <PopupHost>
      <AutocompleteListbox
        label="Files"
        maxHeightClassName="max-h-[340px]"
        loading
        loadingLabel="Scanning files..."
        header={
          <div className={autocompleteHeaderClass}>
            <span>Files</span>
          </div>
        }
        footer={<AutocompleteNavFooter />}
      />
    </PopupHost>
  ),
};

/** Empty state — no matching options. */
export const Empty: Story = {
  render: () => (
    <PopupHost>
      <AutocompleteListbox
        label="Files"
        maxHeightClassName="max-h-[340px]"
        isEmpty
        empty="No matching files"
        header={
          <div className={autocompleteHeaderClass}>
            <span>Files</span>
            <span className={autocompleteHeaderCountClass}>0 files</span>
          </div>
        }
        footer={<AutocompleteNavFooter />}
      />
    </PopupHost>
  ),
};

/** Error state. */
export const Error: Story = {
  render: () => (
    <PopupHost>
      <AutocompleteListbox
        label="Commands"
        maxHeightClassName="max-h-[340px]"
        error="Failed to load commands"
        header={
          <div className={autocompleteHeaderClass}>
            <span>Commands</span>
          </div>
        }
        footer={<AutocompleteNavFooter />}
      />
    </PopupHost>
  ),
};
