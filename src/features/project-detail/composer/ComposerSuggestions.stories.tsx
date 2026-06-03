import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import ComposerSuggestions from "./ComposerSuggestions";
import type { Suggestion } from "../components/command-suggestions";
import "./styles/composer.css";

const commandSuggestions: Suggestion[] = [
  { kind: "action", id: "new", label: "Create session", grp: "Actions" },
  {
    kind: "action",
    id: "capabilities",
    label: "Configure capabilities",
    grp: "Actions",
  },
  {
    kind: "action",
    id: "workflow-builder",
    label: "Open builder",
    grp: "Actions",
  },
];

const filterSuggestions: Suggestion[] = [
  {
    kind: "filter",
    cat: "status",
    key: "is",
    value: "running",
    label: "3 sessions",
    grp: "Filter",
  },
  {
    kind: "filter",
    cat: "target",
    key: "target",
    value: "main",
    label: "8 sessions",
    grp: "Filter",
  },
  {
    kind: "filter",
    cat: "archived",
    key: "only",
    value: "only",
    exclusive: true,
    label: "12 archived",
    grp: "Filter",
  },
];

const meta: Meta<typeof ComposerSuggestions> = {
  title: "Project Cockpit/Composer/Suggestions",
  component: ComposerSuggestions,
};
export default meta;

type Story = StoryObj<typeof ComposerSuggestions>;

export const CommandPalette: Story = {
  args: { suggestions: commandSuggestions, activeIndex: 0, onApply: fn() },
};

export const FilterSuggestions: Story = {
  args: { suggestions: filterSuggestions, activeIndex: 1, onApply: fn() },
};

/**
 * Demonstrates keyboard operability: ↑/↓ move the highlight, ⏎ applies the
 * highlighted suggestion. The composer drives `activeIndex` the same way.
 */
export const KeyboardNavigation: Story = {
  render: function KeyboardDemo() {
    const all = [...commandSuggestions, ...filterSuggestions];
    const [activeIndex, setActiveIndex] = useState(0);
    const [applied, setApplied] = useState<string | null>(null);
    return (
      <div
        tabIndex={0}
        style={{ outline: "none", width: 320 }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, all.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const s = all[activeIndex];
            if (s)
              setApplied(
                s.kind === "action" ? `/${s.id}` : `${s.key}:${s.value}`,
              );
          }
        }}
      >
        <div style={{ marginBottom: 8, color: "var(--text-tertiary)" }}>
          Focus me, then use ↑/↓ and ⏎. Applied: {applied ?? "—"}
        </div>
        <ComposerSuggestions
          suggestions={all}
          activeIndex={activeIndex}
          onApply={(s) =>
            setApplied(s.kind === "action" ? `/${s.id}` : `${s.key}:${s.value}`)
          }
          onHoverIndex={setActiveIndex}
        />
      </div>
    );
  },
};
