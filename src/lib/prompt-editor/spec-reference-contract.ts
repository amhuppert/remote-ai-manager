import { z } from "zod";
import { escapeXmlAttr } from "@/lib/shared/xml";
import { quoteAgentCommandArgument } from "@/lib/tickets/command-arguments";

const revisionSchema = z.string().regex(/^[1-9]\d*$/);

export const specRefAttrsSchema = z
  .object({
    "project-name": z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    revision: revisionSchema,
    "read-command": z.string().min(1),
  })
  .strict();

export const specElementRefAttrsSchema = z
  .object({
    "project-name": z.string().min(1),
    slug: z.string().min(1),
    handle: z.string().min(1),
    name: z.string(),
    revision: revisionSchema,
    "read-command": z.string().min(1),
  })
  .strict();

/**
 * Sections are the one spec element kind with no handle, so their reference is
 * addressed by the stable element id `spec show` publishes rather than by the
 * `<slug>/<handle>` address every other element kind uses.
 */
export const specSectionRefAttrsSchema = z
  .object({
    "project-name": z.string().min(1),
    slug: z.string().min(1),
    "element-id": z.string().min(1),
    name: z.string(),
    revision: revisionSchema,
    "read-command": z.string().min(1),
  })
  .strict();

export type SpecRefAttrs = z.infer<typeof specRefAttrsSchema>;
export type SpecElementRefAttrs = z.infer<typeof specElementRefAttrsSchema>;
export type SpecSectionRefAttrs = z.infer<typeof specSectionRefAttrsSchema>;

export interface SpecMentionAttrs {
  projectName: string;
  slug: string;
  name: string;
  revision: string;
  readCommand: string;
}

export interface SpecElementMentionAttrs extends SpecMentionAttrs {
  handle: string;
}

export interface SpecSectionMentionAttrs extends SpecMentionAttrs {
  elementId: string;
}

export type SpecReferenceType =
  | "spec"
  | "requirement"
  | "decision"
  | "task"
  | "question"
  | "assumption";

function stringAttr(attrs: Record<string, unknown>, key: string): string {
  const raw = attrs[key];
  return typeof raw === "string" ? raw : "";
}

export function buildSpecReadCommand(
  projectName: string,
  slug: string,
  handle?: string,
): string {
  const address = handle ? `${slug}/${handle}` : slug;
  const verb = handle ? "get" : "show";
  return `cctl spec ${verb} ${quoteAgentCommandArgument(address)} --project ${quoteAgentCommandArgument(projectName)}`;
}

export function buildSpecReferenceXml(
  referenceType: SpecReferenceType,
  attrs: Record<string, unknown>,
): string {
  const projectName = stringAttr(attrs, "projectName");
  const slug = stringAttr(attrs, "slug");
  const handle = stringAttr(attrs, "handle");
  const values: Array<[string, string]> = [
    ["project-name", projectName],
    ["slug", slug],
  ];
  if (referenceType !== "spec") values.push(["handle", handle]);
  values.push(
    ["name", stringAttr(attrs, "name")],
    ["revision", stringAttr(attrs, "revision")],
    [
      "read-command",
      buildSpecReadCommand(projectName, slug, handle || undefined),
    ],
  );
  return renderRefTag(`${referenceType}-ref`, values);
}

function renderRefTag(
  xmlTag: string,
  values: ReadonlyArray<readonly [string, string]>,
): string {
  const rendered = values
    .map(([name, value]) => `${name}="${escapeXmlAttr(value)}"`)
    .join(" ");
  return `<${xmlTag} ${rendered} />`;
}

/**
 * Sections have no handle, so `spec get`'s `<slug>/<handle>` address cannot
 * name one; the id-taking read is its own verb.
 */
export function buildSpecSectionReadCommand(
  projectName: string,
  slug: string,
  elementId: string,
): string {
  return `cctl spec section get ${quoteAgentCommandArgument(slug)} --id ${quoteAgentCommandArgument(elementId)} --project ${quoteAgentCommandArgument(projectName)}`;
}

export function buildSpecSectionReferenceXml(
  attrs: Record<string, unknown>,
): string {
  const projectName = stringAttr(attrs, "projectName");
  const slug = stringAttr(attrs, "slug");
  const elementId = stringAttr(attrs, "elementId");
  return renderRefTag("section-ref", [
    ["project-name", projectName],
    ["slug", slug],
    ["element-id", elementId],
    ["name", stringAttr(attrs, "name")],
    ["revision", stringAttr(attrs, "revision")],
    ["read-command", buildSpecSectionReadCommand(projectName, slug, elementId)],
  ]);
}

export function specSectionRefAttrsToMentionAttrs(
  attrs: SpecSectionRefAttrs,
): SpecSectionMentionAttrs {
  return {
    projectName: attrs["project-name"],
    slug: attrs.slug,
    elementId: attrs["element-id"],
    name: attrs.name,
    revision: attrs.revision,
    readCommand: attrs["read-command"],
  };
}

export function specRefAttrsToMentionAttrs(
  attrs: SpecRefAttrs,
): SpecMentionAttrs {
  return {
    projectName: attrs["project-name"],
    slug: attrs.slug,
    name: attrs.name,
    revision: attrs.revision,
    readCommand: attrs["read-command"],
  };
}

export function specElementRefAttrsToMentionAttrs(
  attrs: SpecElementRefAttrs,
): SpecElementMentionAttrs {
  return {
    projectName: attrs["project-name"],
    slug: attrs.slug,
    handle: attrs.handle,
    name: attrs.name,
    revision: attrs.revision,
    readCommand: attrs["read-command"],
  };
}
