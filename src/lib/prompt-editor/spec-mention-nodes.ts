import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { SpecRefEditorChip } from "@/components/references/SpecRefChips";
import type { SpecElementMentionAttrs } from "./spec-reference-contract";
export {
  buildSpecReadCommand,
  buildSpecReferenceXml,
  specElementRefAttrsSchema,
  specElementRefAttrsToMentionAttrs,
  specRefAttrsSchema,
  specRefAttrsToMentionAttrs,
} from "./spec-reference-contract";
export type {
  SpecElementMentionAttrs,
  SpecElementRefAttrs,
  SpecMentionAttrs,
  SpecReferenceType,
  SpecRefAttrs,
} from "./spec-reference-contract";

type SpecReferenceNodeName =
  | "specMention"
  | "requirementMention"
  | "decisionMention"
  | "taskMention"
  | "questionMention"
  | "assumptionMention";

interface AttrSpec {
  key: keyof SpecElementMentionAttrs;
  dataAttr: string;
  defaultValue: string;
}

const COMMON_ATTR_SPECS: AttrSpec[] = [
  { key: "projectName", dataAttr: "data-project-name", defaultValue: "" },
  { key: "slug", dataAttr: "data-slug", defaultValue: "" },
  { key: "name", dataAttr: "data-name", defaultValue: "" },
  { key: "revision", dataAttr: "data-revision", defaultValue: "1" },
  { key: "readCommand", dataAttr: "data-read-command", defaultValue: "" },
];

function createSpecReferenceNode(
  name: SpecReferenceNodeName,
  dataMarker: string,
  includeHandle: boolean,
) {
  const attrSpecs = includeHandle
    ? [
        ...COMMON_ATTR_SPECS.slice(0, 2),
        { key: "handle", dataAttr: "data-handle", defaultValue: "" } as const,
        ...COMMON_ATTR_SPECS.slice(2),
      ]
    : COMMON_ATTR_SPECS;

  return Node.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return Object.fromEntries(
        attrSpecs.map((spec) => [
          spec.key,
          {
            default: spec.defaultValue,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute(spec.dataAttr) ?? spec.defaultValue,
            renderHTML: (attributes: Record<string, unknown>) => ({
              [spec.dataAttr]: String(
                attributes[spec.key] ?? spec.defaultValue,
              ),
            }),
          },
        ]),
      );
    },

    parseHTML() {
      return [{ tag: `span[${dataMarker}]` }];
    },

    renderHTML({ HTMLAttributes }) {
      const slug = String(HTMLAttributes["data-slug"] ?? "");
      const handle = String(HTMLAttributes["data-handle"] ?? "");
      return [
        "span",
        mergeAttributes(HTMLAttributes, { [dataMarker]: "" }),
        handle ? `${slug}/${handle}` : slug,
      ];
    },

    renderText({ node }) {
      const slug = String(node.attrs["slug"] ?? "");
      const handle = String(node.attrs["handle"] ?? "");
      return handle ? `${slug}/${handle}` : slug;
    },

    addNodeView() {
      return ReactNodeViewRenderer(SpecRefEditorChip);
    },
  });
}

export const SpecMentionNode = createSpecReferenceNode(
  "specMention",
  "data-spec-mention",
  false,
);

export const RequirementMentionNode = createSpecReferenceNode(
  "requirementMention",
  "data-requirement-mention",
  true,
);

export const DecisionMentionNode = createSpecReferenceNode(
  "decisionMention",
  "data-decision-mention",
  true,
);

export const TaskMentionNode = createSpecReferenceNode(
  "taskMention",
  "data-task-mention",
  true,
);

export const QuestionMentionNode = createSpecReferenceNode(
  "questionMention",
  "data-question-mention",
  true,
);

export const AssumptionMentionNode = createSpecReferenceNode(
  "assumptionMention",
  "data-assumption-mention",
  true,
);
