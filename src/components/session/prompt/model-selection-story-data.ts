import type { BackendModelCatalog } from "@/lib/agent-backends/schemas";

export const effortOnlyModelCatalog = {
  backend: "cursor",
  defaultModelId: "effort-only",
  models: [
    {
      id: "effort-only",
      label: "Effort only",
      description: "A model with one primary parameter.",
      aliases: [],
      parameters: [
        {
          id: "reasoning",
          label: "Reasoning",
          values: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          prominence: "primary",
        },
      ],
      variants: [
        {
          selection: {
            modelId: "effort-only",
            parameters: { reasoning: "low" },
          },
          label: "Low",
          isDefault: false,
        },
        {
          selection: {
            modelId: "effort-only",
            parameters: { reasoning: "high" },
          },
          label: "High",
          isDefault: true,
        },
      ],
    },
    {
      id: "plain",
      label: "Plain model",
      description: "A model with no selectable parameters.",
      aliases: [],
      parameters: [],
      variants: [
        {
          selection: { modelId: "plain", parameters: {} },
          label: "Default",
          isDefault: true,
        },
      ],
    },
  ],
  provenance: { source: "storybook" },
} satisfies BackendModelCatalog;

export const fullModelParameterCatalog = {
  backend: "cursor",
  defaultModelId: "full-controls",
  models: [
    {
      id: "full-controls",
      label: "Full controls",
      description: "Reasoning, thinking, context, and fast mode.",
      aliases: [],
      parameters: [
        {
          id: "reasoning",
          label: "Reasoning",
          values: [
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
          ],
          prominence: "primary",
        },
        {
          id: "thinking",
          label: "Thinking",
          values: [
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ],
          prominence: "advanced",
        },
        {
          id: "context",
          label: "Context size",
          values: [
            { value: "272k", label: "272k" },
            { value: "1m", label: "1m" },
          ],
          prominence: "advanced",
        },
        {
          id: "fast",
          label: "Fast mode",
          values: [
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ],
          prominence: "advanced",
        },
        {
          id: "cyber",
          label: "Cyber",
          values: [{ value: "false", label: "Off" }],
          prominence: "hidden",
        },
      ],
      variants: [
        {
          selection: {
            modelId: "full-controls",
            parameters: {
              reasoning: "high",
              thinking: "false",
              context: "272k",
              fast: "true",
              cyber: "false",
            },
          },
          label: "Fast default",
          isDefault: true,
        },
        {
          selection: {
            modelId: "full-controls",
            parameters: {
              reasoning: "high",
              thinking: "false",
              context: "272k",
              fast: "false",
              cyber: "false",
            },
          },
          label: "Standard",
          isDefault: false,
        },
        {
          selection: {
            modelId: "full-controls",
            parameters: {
              reasoning: "high",
              thinking: "false",
              context: "1m",
              fast: "false",
              cyber: "false",
            },
          },
          label: "Long context",
          isDefault: false,
        },
        {
          selection: {
            modelId: "full-controls",
            parameters: {
              reasoning: "xhigh",
              thinking: "true",
              context: "272k",
              fast: "false",
              cyber: "false",
            },
          },
          label: "Extra high reasoning",
          isDefault: false,
        },
      ],
    },
  ],
  provenance: { source: "storybook" },
} satisfies BackendModelCatalog;
