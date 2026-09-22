import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { SpecRefEditorChip } from "@/components/references/SpecRefChips";
import type {
  SpecElementMentionAttrs,
  SpecSectionMentionAttrs,
} from "./spec-reference-contract";
export {
  buildSpecReadCommand,
  buildSpecReferenceXml,
  buildSpecSectionReferenceXml,
  specElementRefAttrsSchema,
  specElementRefAttrsToMentionAttrs,
  specRefAttrsSchema,
  specRefAttrsToMentionAttrs,
  specSectionRefAttrsSchema,
  specSectionRefAttrsToMentionAttrs,
} from "./spec-reference-contract";
export type {
  SpecElementMentionAttrs,
  SpecElementRefAttrs,
  SpecMentionAttrs,
  SpecRefAttrs,
  SpecSectionRefAttrs,
} from "./spec-reference-contract";

type SpecReferenceNodeName =
  | "specMention"
  | "requirementMention"
  | "decisionMention"
  | "taskMention"
  | "questionMention"
  | "assumptionMention"
  | "sectionMention";

/**
 * How a node addresses what it points at: the spec itself, one handled element,
 * or — for a section, the one element kind with no handle — its element id.
 */
type SpecReferenceAddress = "spec" | "handle" | "element-id";

interface AttrSpec {
  key: keyof SpecElementMentionAttrs | keyof SpecSectionMentionAttrs;
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

const ADDRESS_ATTR_SPEC: Record<SpecReferenceAddress, AttrSpec | null> = {
  spec: null,
  handle: { key: "handle", dataAttr: "data-handle", defaultValue: "" },
  "element-id": {
    key: "elementId",
    dataAttr: "data-element-id",
    defaultValue: "",
  },
};

function createSpecReferenceNode(
  name: SpecReferenceNodeName,
  dataMarker: string,
  address: SpecReferenceAddress,
) {
  const addressSpec = ADDRESS_ATTR_SPEC[address];
  const attrSpecs =
    addressSpec === null
      ? COMMON_ATTR_SPECS
      : [
          ...COMMON_ATTR_SPECS.slice(0, 2),
          addressSpec,
          ...COMMON_ATTR_SPECS.slice(2),
        ];

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
      return [
        "span",
        mergeAttributes(HTMLAttributes, { [dataMarker]: "" }),
        renderAddress(
          String(HTMLAttributes["data-slug"] ?? ""),
          addressSpec === null
            ? ""
            : String(HTMLAttributes[addressSpec.dataAttr] ?? ""),
        ),
      ];
    },

    renderText({ node }) {
      return renderAddress(
        String(node.attrs["slug"] ?? ""),
        addressSpec === null ? "" : String(node.attrs[addressSpec.key] ?? ""),
      );
    },

    addNodeView() {
      return ReactNodeViewRenderer(SpecRefEditorChip);
    },
  });
}

/** The address a chip falls back to as plain text: `<slug>` or `<slug>/<addr>`. */
function renderAddress(slug: string, address: string): string {
  return address ? `${slug}/${address}` : slug;
}

export const SpecMentionNode = createSpecReferenceNode(
  "specMention",
  "data-spec-mention",
  "spec",
);

export const RequirementMentionNode = createSpecReferenceNode(
  "requirementMention",
  "data-requirement-mention",
  "handle",
);

export const DecisionMentionNode = createSpecReferenceNode(
  "decisionMention",
  "data-decision-mention",
  "handle",
);

export const TaskMentionNode = createSpecReferenceNode(
  "taskMention",
  "data-task-mention",
  "handle",
);

export const QuestionMentionNode = createSpecReferenceNode(
  "questionMention",
  "data-question-mention",
  "handle",
);

export const AssumptionMentionNode = createSpecReferenceNode(
  "assumptionMention",
  "data-assumption-mention",
  "handle",
);

export const SectionMentionNode = createSpecReferenceNode(
  "sectionMention",
  "data-section-mention",
  "element-id",
);
