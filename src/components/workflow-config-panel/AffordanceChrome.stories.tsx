import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import {
  configAffordanceBanner,
  configSaveBar,
  READ_ONLY_REASON_TEXT,
  type ConfigBannerDescriptor,
} from "./affordance";
import {
  ConfigAffordanceBanner,
  ConfigSaveAlert,
  ConfigSaveBar,
} from "./AffordanceChrome";
import { ConfigTextArea } from "./ConfigControls";
import { outputSchemaSaveBlockReason } from "./schema-lint";
import type { ConfigAffordance, ConfigSaveState } from "./types";

/**
 * The execution host's chrome as a states catalogue. Every string here comes
 * back from the descriptors in `./affordance`, so a story showing the wrong
 * copy means the contract changed, not that the story drifted.
 */

const REFUSED_SCHEMA = `{
  "type": "object",
  "properties": { "owner": { "$ref": "#/$defs/person" } }
}`;

// The 420px right rail the panel is mounted in.
function Rail({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-[420px] flex-col border border-solid border-border-dim bg-bg-surface font-mono">
      {children}
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 px-lg py-sm font-mono text-[0.7rem] text-text-tertiary">
      {children}
    </p>
  );
}

function Banner({
  affordance,
  readOnlyReason,
  pausing,
}: {
  affordance: ConfigAffordance;
  readOnlyReason?: keyof typeof READ_ONLY_REASON_TEXT;
  pausing?: boolean;
}) {
  const banner: ConfigBannerDescriptor | null = configAffordanceBanner({
    host: "execution",
    affordance,
    readOnlyReason,
  });
  if (!banner) return <Caption>Editable — no banner.</Caption>;
  return (
    <ConfigAffordanceBanner
      banner={banner}
      onAction={fn()}
      pending={pausing}
      pendingLabel="Pausing…"
    />
  );
}

function SaveBar({
  saveState,
  blockedReason,
  errorMessage,
}: {
  saveState: ConfigSaveState;
  blockedReason?: string | null;
  errorMessage?: string;
}) {
  const saveBar = configSaveBar({
    host: "execution",
    affordance: "editable",
    saveState,
    blockedReason,
    errorMessage,
  });
  if (!saveBar) return null;
  return (
    <>
      {saveBar.alertText ? <ConfigSaveAlert text={saveBar.alertText} /> : null}
      <ConfigSaveBar saveBar={saveBar} onSave={fn()} onResume={fn()} />
    </>
  );
}

// Storybook's controls panel needs a concrete descriptor. It comes back from
// the same function the stories render, so no copy is restated here; the
// fallback is unreachable, `frozen` always produces a banner.
const FROZEN_BANNER: ConfigBannerDescriptor = configAffordanceBanner({
  host: "execution",
  affordance: "frozen",
}) ?? { text: "", icon: "lock", tone: "neutral", actionLabel: null };

const meta = {
  title: "WorkflowConfigPanel/AffordanceChrome",
  component: ConfigAffordanceBanner,
  args: { banner: FROZEN_BANNER },
} satisfies Meta<typeof ConfigAffordanceBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FrozenBanner: Story = {
  render: () => (
    <Rail>
      <Banner affordance="frozen" />
    </Rail>
  ),
};

export const PauseToEditBanner: Story = {
  render: () => (
    <Rail>
      <Banner affordance="pause-to-edit" />
    </Rail>
  ),
};

/** The action is in flight: the label becomes `Pausing…` and stops accepting. */
export const PauseToEditPending: Story = {
  render: () => (
    <Rail>
      <Banner affordance="pause-to-edit" pausing />
    </Rail>
  ),
};

/** All four classifier reasons, each carried verbatim. */
export const ReadOnlyBanners: Story = {
  render: () => (
    <div className="flex flex-col gap-md">
      {(
        Object.keys(
          READ_ONLY_REASON_TEXT,
        ) as (keyof typeof READ_ONLY_REASON_TEXT)[]
      ).map((reason) => (
        <Rail key={reason}>
          <Caption>{reason}</Caption>
          <Banner affordance="read-only" readOnlyReason={reason} />
        </Rail>
      ))}
    </div>
  ),
};

interface SaveBarCase {
  label: string;
  saveState: ConfigSaveState;
  blockedReason?: string;
  errorMessage?: string;
}

const SAVE_BAR_CASES: readonly SaveBarCase[] = [
  { label: "clean", saveState: "clean" },
  { label: "dirty", saveState: "dirty" },
  {
    label: "dirty · schema refused",
    saveState: "dirty",
    blockedReason: "The output schema cannot be parsed.",
  },
  {
    label: "dirty · placement refused",
    saveState: "dirty",
    blockedReason: "This placement is not a legal declaration.",
  },
  { label: "saving", saveState: "saving" },
  { label: "saved", saveState: "saved" },
  { label: "conflict", saveState: "conflict" },
  {
    label: "error",
    saveState: "error",
    errorMessage:
      "Live edit refused: lane delivery is mid-merge. Wait for the join to settle and retry.",
  },
];

/** The six save states, in the order an edit walks through them. */
export const SaveBarStates: Story = {
  render: () => (
    <div className="flex flex-col gap-md">
      {SAVE_BAR_CASES.map((testCase) => (
        <Rail key={testCase.label}>
          <Caption>{testCase.label}</Caption>
          <SaveBar
            saveState={testCase.saveState}
            blockedReason={testCase.blockedReason}
            errorMessage={testCase.errorMessage}
          />
        </Rail>
      ))}
    </div>
  ),
};

/**
 * The blocked note is not a story-authored string: the schema lint decides it.
 * Typing valid JSON in the accepted subset releases the Save button.
 */
export const SaveBlockedByLiveSchemaLint: Story = {
  render: function Render() {
    const [text, setText] = useState(REFUSED_SCHEMA);
    return (
      <Rail>
        <ConfigTextArea
          value={text}
          onChange={setText}
          ariaLabel="Output schema"
          rows={6}
          monospaceDense
        />
        <SaveBar
          saveState="dirty"
          blockedReason={outputSchemaSaveBlockReason(text)}
        />
      </Rail>
    );
  },
};
