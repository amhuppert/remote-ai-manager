"use client";

import {
  createConfigScreenRegistry,
  type ConfigScreenDefinition,
  type ConfigScreenRegistry,
} from "./screen-registry";
import type { ConfigScope } from "./types";

// Every root card opens a group screen. The screens themselves are built by the
// two downstream config contexts; until then each id resolves to a stub, so a
// card can never drill into an unregistered screen.

const CONTEXT_SCREENS: readonly { id: string; title: string }[] = [
  { id: "brief", title: "Brief" },
  { id: "placement", title: "Placement" },
  { id: "agents", title: "Agents" },
  { id: "gates", title: "Quality gates" },
  { id: "policy", title: "Execution policy" },
  { id: "tasks", title: "Tasks" },
];

const WORKFLOW_SCREENS: readonly { id: string; title: string }[] = [
  { id: "charter", title: "Charter" },
  { id: "params", title: "Launch parameters" },
  { id: "agents", title: "Agents" },
  { id: "gates", title: "Quality gates" },
  { id: "policy", title: "Execution policy" },
];

function placeholder(title: string): React.ReactNode {
  return (
    <p className="m-0 font-mono text-[0.72rem] leading-[1.6] text-text-tertiary">
      {title} has no rows yet.
    </p>
  );
}

export function createPlaceholderScreenRegistry(
  scope: ConfigScope,
): ConfigScreenRegistry {
  const screens = scope === "context" ? CONTEXT_SCREENS : WORKFLOW_SCREENS;
  const definitions: ConfigScreenDefinition[] = screens.map(
    ({ id, title }) => ({
      id,
      title,
      render: () => placeholder(title),
    }),
  );
  return createConfigScreenRegistry(definitions);
}
