/**
 * The reference picker's view model — the one owner of what the `@`, `#`, and
 * `!` triggers offer and how those offers are grouped, capped, counted, and
 * filtered.
 *
 * The trigger character only preselects a scope; every scope stays reachable
 * from every trigger, so a new artifact kind is a new entry in
 * {@link PICKER_KIND_ORDER} and nothing else. Reference kinds delegate to their
 * `REFERENCE_REGISTRY` picker source; files are sourced here because they are
 * not XML references and so have no registry entry.
 *
 * Everything in this module is pure — no React, no I/O, no clock. Relative
 * times survive as instants in {@link ReferenceItemMeta} and are formatted at
 * render time.
 */

import { isMarkdownPath } from "@/lib/documents/path";
import { filterAndScoreFiles } from "@/lib/files/file-autocomplete-filter";
import type { FileItem } from "@/lib/files/schemas";
import {
  getReferenceByType,
  type ReferenceItemFact,
  type ReferenceItemMeta,
  type ReferencePickerContext,
  type ReferencePickerItem,
  type ReferenceStatusTone,
  type ReferenceType,
  type SpecPickerSpec,
} from "./reference-registry";

export type PickerTrigger = "@" | "#" | "!";

/** Scope kinds, in the order their sections appear in the All scope. */
export const PICKER_KIND_ORDER = [
  "file",
  "conversation",
  "spec",
  "ticket",
  "notepad",
] as const;
export type PickerKind = (typeof PICKER_KIND_ORDER)[number];

export type PickerScope = "all" | PickerKind;

/** Tab / Shift+Tab walks this cycle. */
export const PICKER_SCOPE_CYCLE: readonly PickerScope[] = [
  "all",
  ...PICKER_KIND_ORDER,
];

/** Spec elements, in the order their sections appear when drilled in. */
export const PICKER_ELEMENT_ORDER = [
  "requirement",
  "decision",
  "task",
  "question",
  "assumption",
] as const;
export type PickerElementKind = (typeof PICKER_ELEMENT_ORDER)[number];

/** Which section of a drilled-in spec is shown: every kind, or just one. */
export type PickerDrillScope = "all" | PickerElementKind;

export type PickerItemKind = "file" | ReferenceType;

/** Rows carry a glyph family rather than an icon so the model stays view-free. */
export type PickerGlyph = PickerKind;

/** How many rows a section shows in the All scope before a "+N more" row. */
export const PICKER_SECTION_CAP = 4;

const KIND_LABELS: Record<PickerKind, string> = {
  file: "Files",
  conversation: "Conversations",
  spec: "Specs",
  ticket: "Tickets",
  notepad: "Notepads",
};

/** What selecting a row inserts into the document. */
export type PickerSelection =
  | { kind: "file"; path: string; basename: string; ext: string }
  | { kind: "reference"; type: ReferenceType; attrs: Record<string, unknown> };

export interface PickerItemRow {
  kind: "item";
  /** Position in {@link PickerView.rows} — the active-index coordinate space. */
  index: number;
  id: string;
  itemKind: PickerItemKind;
  glyph: PickerGlyph;
  label: string;
  matchIndices: readonly number[];
  dimPrefixLength: number;
  idLabel: string | null;
  description: string;
  meta: ReferenceItemMeta | null;
  status: { label: string; tone: ReferenceStatusTone } | null;
  facts: readonly ReferenceItemFact[];
  muted: boolean;
  /** Set when the row offers the Markdown viewer (Alt+Enter and the button). */
  openablePath: string | null;
  completion: string;
  selection: PickerSelection;
}

/** The row that ends a capped section and jumps to that section's scope. */
export interface PickerMoreRow {
  kind: "more";
  index: number;
  scope: PickerKind;
  hiddenCount: number;
  label: string;
}

export type PickerRow = PickerItemRow | PickerMoreRow;

export interface PickerSection {
  key: string;
  label: string;
  /** Right-aligned note about what the section's filter is withholding. */
  hint: string;
  showHeader: boolean;
  rows: readonly PickerRow[];
}

export interface PickerTab {
  key: PickerScope | PickerDrillScope;
  label: string;
  count: number;
  active: boolean;
  /** Accent family for the tab's underline; null for the All tab. */
  glyph: PickerGlyph | null;
}

export interface PickerFilterChip {
  visible: boolean;
  active: boolean;
  label: string;
  hiddenCount: number;
}

export interface PickerView {
  mode: "scopes" | "drill";
  /** The scope actually rendered — a `type:` query prefix can override state. */
  scope: PickerScope;
  headerLabel: string;
  countLabel: string;
  tabs: readonly PickerTab[];
  sections: readonly PickerSection[];
  /** Every row in visual order; the active index indexes into this. */
  rows: readonly PickerRow[];
  doneChip: PickerFilterChip;
  archivedChip: PickerFilterChip;
}

export interface PickerViewInput {
  /** The text after the trigger character. */
  query: string;
  trigger: PickerTrigger;
  scope: PickerScope;
  drillScope: PickerDrillScope;
  context: ReferencePickerContext;
  files: readonly FileItem[];
  /** Only a session worktree can open a document, so project scope suppresses it. */
  canOpenDocuments: boolean;
}

export function scopeForTrigger(trigger: PickerTrigger): PickerScope {
  if (trigger === "@") return "file";
  if (trigger === "!") return "ticket";
  return "all";
}

const GLYPH_BY_ITEM_KIND: Record<PickerItemKind, PickerGlyph> = {
  file: "file",
  conversation: "conversation",
  message: "conversation",
  ticket: "ticket",
  spec: "spec",
  requirement: "spec",
  decision: "spec",
  task: "spec",
  question: "spec",
  assumption: "spec",
  notepad: "notepad",
};

/** A row before it knows its position in the flat list. */
type ProtoRow = Omit<PickerItemRow, "kind" | "index">;

export function buildPickerView(input: PickerViewInput): PickerView {
  const drillIn = resolveDrillIn(input.query, input.context);
  return drillIn === null
    ? buildScopeView(input)
    : buildDrillView(input, drillIn);
}

export function pickerHasAnyMatch(input: PickerViewInput): boolean {
  const view = buildPickerView({ ...input, scope: "all", drillScope: "all" });
  return view.rows.some((row) => row.kind === "item");
}

// ── Scope mode ──

function buildScopeView(input: PickerViewInput): PickerView {
  const { scope: scopeFilter, searchQuery } = parseScopeQuery(input.query);
  const scope = scopeFilter ?? input.scope;
  const { context } = input;

  // Both sides of each filter are built regardless of the current setting: the
  // difference between them is what the Alt+D / Alt+A chips count.
  const tickets = filterPair(
    (include) =>
      referenceRows("ticket", searchQuery, {
        ...context,
        includeFinishedTickets: include,
      }),
    context.includeFinishedTickets,
  );
  const conversations = filterPair(
    (include) =>
      referenceRows("conversation", searchQuery, {
        ...context,
        includeArchivedConversations: include,
      }),
    context.includeArchivedConversations,
  );
  const byKind: Record<PickerKind, readonly ProtoRow[]> = {
    file: fileRows(searchQuery, input.files, input.canOpenDocuments),
    conversation: conversations.shown,
    spec: referenceRows("spec", searchQuery, context),
    ticket: tickets.shown,
    notepad: referenceRows("notepad", searchQuery, context),
  };

  const kinds =
    scope === "all" ? PICKER_KIND_ORDER : ([scope] as readonly PickerKind[]);
  const hints: Partial<Record<PickerKind, string>> = {
    ticket: filterHint(
      context.includeFinishedTickets,
      tickets.hiddenCount,
      "done",
      "Alt+D",
    ),
    conversation: filterHint(
      context.includeArchivedConversations,
      conversations.hiddenCount,
      "archived",
      "Alt+A",
    ),
  };
  const withheld: Partial<Record<PickerKind, number>> = {
    ticket: tickets.hiddenCount,
    conversation: conversations.hiddenCount,
  };

  const rows: PickerRow[] = [];
  const sections: PickerSection[] = [];
  for (const kind of kinds) {
    const items = byKind[kind];
    const hint = hints[kind] ?? "";
    if (items.length === 0 && (withheld[kind] ?? 0) === 0) continue;
    const shown = scope === "all" ? items.slice(0, PICKER_SECTION_CAP) : items;
    const sectionRows: PickerRow[] = shown.map((row) =>
      appendRow(rows, { ...row, kind: "item", index: rows.length }),
    );
    if (items.length > shown.length) {
      const hiddenCount = items.length - shown.length;
      sectionRows.push(
        appendRow(rows, {
          kind: "more",
          index: rows.length,
          scope: kind,
          hiddenCount,
          label: `+${hiddenCount} more in ${KIND_LABELS[kind]}`,
        }),
      );
    }
    sections.push({
      key: kind,
      label: KIND_LABELS[kind],
      hint,
      showHeader: scope === "all",
      rows: sectionRows,
    });
  }

  const tabs: PickerTab[] = PICKER_SCOPE_CYCLE.map((candidate) => ({
    key: candidate,
    label: candidate === "all" ? "All" : KIND_LABELS[candidate],
    count:
      candidate === "all"
        ? PICKER_KIND_ORDER.reduce(
            (total, kind) => total + byKind[kind].length,
            0,
          )
        : byKind[candidate].length,
    active: candidate === scope,
    glyph: candidate === "all" ? null : candidate,
  }));

  const ticketsInScope = kinds.includes("ticket");
  const conversationsInScope = kinds.includes("conversation");
  return {
    mode: "scopes",
    scope,
    headerLabel: `${input.trigger} reference — ${
      scope === "all" ? "all types" : KIND_LABELS[scope].toLowerCase()
    }`,
    countLabel: countLabel(rows, "result"),
    tabs,
    sections,
    rows,
    doneChip: filterChip(
      ticketsInScope,
      context.includeFinishedTickets,
      tickets.hiddenCount,
      "done",
    ),
    archivedChip: filterChip(
      conversationsInScope,
      context.includeArchivedConversations,
      conversations.hiddenCount,
      "archived",
    ),
  };
}

// ── Drill-in mode ──

interface DrillIn {
  spec: SpecPickerSpec;
  elementQuery: string;
}

function buildDrillView(input: PickerViewInput, drillIn: DrillIn): PickerView {
  const { spec, elementQuery } = drillIn;
  const context = { ...input.context, selectedSpec: spec };
  // Tabs come from the spec's element inventory, not from the current matches,
  // so narrowing the query never reshuffles the tabs under the user's Tab key.
  const presentKinds = PICKER_ELEMENT_ORDER.filter((kind) =>
    spec.elements.some((element) => element.type === kind),
  );
  const kinds =
    input.drillScope === "all" ? presentKinds : ([input.drillScope] as const);

  const rows: PickerRow[] = [];
  const sections: PickerSection[] = [];
  for (const kind of kinds) {
    const items = referenceRows(kind, elementQuery, context);
    if (items.length === 0) continue;
    sections.push({
      key: kind,
      label: getReferenceByType(kind).pickerSource.groupLabel,
      hint: "",
      showHeader: input.drillScope === "all",
      rows: items.map((row) =>
        appendRow(rows, { ...row, kind: "item", index: rows.length }),
      ),
    });
  }

  const tabs: PickerTab[] = [
    {
      key: "all",
      label: "All",
      count: spec.elements.length,
      active: input.drillScope === "all",
      glyph: "spec",
    },
    ...presentKinds.map((kind) => ({
      key: kind,
      label: getReferenceByType(kind).pickerSource.groupLabel,
      count: spec.elements.filter((element) => element.type === kind).length,
      active: input.drillScope === kind,
      glyph: "spec" as const,
    })),
  ];

  return {
    mode: "drill",
    scope: "spec",
    headerLabel: `${input.trigger} spec — ${spec.slug} · rev ${spec.revision}`,
    countLabel: countLabel(rows, "element"),
    tabs,
    sections,
    rows,
    doneChip: hiddenChip("done"),
    archivedChip: hiddenChip("archived"),
  };
}

/**
 * Resolve `<slug>/<query>` against the loaded specs. The current project wins a
 * slug collision, matching how the spec source ranks its own rows.
 */
function resolveDrillIn(
  query: string,
  context: ReferencePickerContext,
): DrillIn | null {
  const parsed = parseSpecDrillInQuery(query);
  if (parsed === null) return null;
  const slug = parsed.slug.toLowerCase();
  const spec = [...context.specs]
    .sort(
      (left, right) =>
        currentProjectRank(left, context) - currentProjectRank(right, context),
    )
    .find((candidate) => candidate.slug.toLowerCase() === slug);
  return spec === undefined
    ? null
    : { spec, elementQuery: parsed.elementQuery };
}

function currentProjectRank(
  spec: SpecPickerSpec,
  context: ReferencePickerContext,
): number {
  return spec.projectName === context.currentProjectName ? 0 : 1;
}

// ── Sources ──

function referenceRows(
  type: ReferenceType,
  query: string,
  context: ReferencePickerContext,
): readonly ProtoRow[] {
  return getReferenceByType(type)
    .pickerSource.getItems(query, context)
    .map(toProtoRow);
}

function toProtoRow(item: ReferencePickerItem): ProtoRow {
  const { presentation } = item;
  return {
    id: item.id,
    itemKind: item.type,
    glyph: GLYPH_BY_ITEM_KIND[item.type],
    label: item.label,
    matchIndices: item.matchIndices,
    dimPrefixLength: presentation.dimPrefixLength,
    idLabel: presentation.idLabel,
    description: item.description,
    meta: presentation.meta,
    status: presentation.status,
    facts: presentation.facts,
    muted: presentation.muted,
    openablePath: null,
    completion: presentation.completion,
    selection: { kind: "reference", type: item.type, attrs: item.attrs },
  };
}

function fileRows(
  query: string,
  files: readonly FileItem[],
  canOpenDocuments: boolean,
): readonly ProtoRow[] {
  return filterAndScoreFiles(query, files).items.map(({ item, indices }) => {
    const slash = item.path.lastIndexOf("/");
    const basename = slash >= 0 ? item.path.slice(slash + 1) : item.path;
    const dot = basename.lastIndexOf(".");
    const ext = dot > 0 ? basename.slice(dot + 1) : "";
    return {
      id: `file:${item.path}`,
      itemKind: "file",
      glyph: "file",
      label: item.path,
      matchIndices: indices,
      dimPrefixLength: slash >= 0 ? slash + 1 : 0,
      idLabel: null,
      description: "",
      meta: ext.length > 0 ? { kind: "text" as const, value: `.${ext}` } : null,
      status: null,
      facts: [],
      muted: false,
      openablePath:
        canOpenDocuments && isMarkdownPath(item.path) ? item.path : null,
      completion: item.path,
      selection: { kind: "file", path: item.path, basename, ext },
    };
  });
}

// ── Query grammar ──

/**
 * `tickets: ranking` narrows to a scope. Only the colon form is accepted: with
 * spaces allowed in a query, a space-separated `task list` would otherwise be
 * read as a scope filter rather than the text the user is searching for.
 */
function parseScopeQuery(query: string): {
  scope: PickerKind | null;
  searchQuery: string;
} {
  const trimmed = query.trimStart();
  const prefixed = /^([^:\s]+):\s*(.*)$/.exec(trimmed);
  if (prefixed) {
    const scope = resolveScopeAlias(prefixed[1] ?? "", false);
    if (scope !== null) return { scope, searchQuery: prefixed[2] ?? "" };
  }
  const exact = resolveScopeAlias(trimmed, true);
  if (exact !== null) return { scope: exact, searchQuery: "" };
  return { scope: null, searchQuery: trimmed };
}

function resolveScopeAlias(
  token: string,
  requireExact: boolean,
): PickerKind | null {
  const normalized = token.toLowerCase();
  if (normalized.length === 0) return null;
  const matches = PICKER_KIND_ORDER.filter((kind) =>
    scopeAliases(kind).some((alias) =>
      requireExact ? alias === normalized : alias.startsWith(normalized),
    ),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function scopeAliases(kind: PickerKind): readonly string[] {
  return kind === "file"
    ? ["file", "files"]
    : getReferenceByType(kind).pickerSource.queryAliases;
}

export function parseSpecDrillInQuery(
  query: string,
): { slug: string; elementQuery: string } | null {
  const trimmed = query.trimStart();
  const separator = trimmed.indexOf("/");
  if (separator <= 0) return null;
  return {
    slug: trimmed.slice(0, separator),
    elementQuery: trimmed.slice(separator + 1),
  };
}

// ── Shared shaping ──

function filterPair(
  build: (include: boolean) => readonly ProtoRow[],
  include: boolean,
): { shown: readonly ProtoRow[]; hiddenCount: number } {
  const withFiltered = build(true);
  const withoutFiltered = build(false);
  return {
    shown: include ? withFiltered : withoutFiltered,
    hiddenCount: Math.max(withFiltered.length - withoutFiltered.length, 0),
  };
}

function appendRow<T extends PickerRow>(rows: PickerRow[], row: T): T {
  rows.push(row);
  return row;
}

function filterHint(
  active: boolean,
  hiddenCount: number,
  noun: string,
  shortcut: string,
): string {
  if (active) return `incl. ${noun} · ${shortcut}`;
  return hiddenCount > 0 ? `${hiddenCount} ${noun} hidden · ${shortcut}` : "";
}

function filterChip(
  inScope: boolean,
  active: boolean,
  hiddenCount: number,
  noun: string,
): PickerFilterChip {
  return {
    visible: inScope && (hiddenCount > 0 || active),
    active,
    label: active ? `incl. ${noun}` : `+${hiddenCount} ${noun}`,
    hiddenCount,
  };
}

function hiddenChip(noun: string): PickerFilterChip {
  return { visible: false, active: false, label: `+0 ${noun}`, hiddenCount: 0 };
}

function countLabel(rows: readonly PickerRow[], noun: string): string {
  const total = rows.filter((row) => row.kind === "item").length;
  return `${total} ${total === 1 ? noun : `${noun}s`}`;
}
