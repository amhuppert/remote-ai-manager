import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Deterministic architecture contract for the canonical Markdown module. It
 * scans production TypeScript/TSX and stylesheet sources — never a runtime — and
 * fails when Markdown rendering leaks back out of `src/components/markdown/**`:
 * a forbidden renderer-stack import (including a direct `mermaid` dependency), a
 * deleted renderer/loader by any import path, a renderer-internal export pulled
 * off a public seam, a public adapter escape-hatch prop, a hand-rolled
 * Markdown-lite parser, or a legacy generated-Markdown style hook (in a `.css`
 * file or embedded in a component's Tailwind selectors). It is red against the
 * pre-cleanup tree and green once the legacy paths are deleted.
 *
 * Because the legacy code is already deleted, each guard is also exercised
 * against in-memory mutation fixtures (see the "regression fixtures" suite):
 * crafted regressions the guard must flag. That proves the guard actually
 * enforces the boundary rather than passing vacuously on a clean tree.
 */

const SRC_ROOT = path.resolve(__dirname, "../.."); // .../src
const CANONICAL_DIR = __dirname; // .../src/components/markdown
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;

/**
 * Public seams of the canonical module. Every other file under the module is a
 * private implementation detail (the react-markdown renderer, syntax-highlighter
 * configuration, Mermaid dispatch, the safe-link renderer, the rehype
 * source-position plugin, test fixtures) that production code must reach only
 * through these entrypoints:
 *   - Markdown.tsx            the four product-intent adapters + deferred loading
 *   - MarkdownViewport.tsx    the document host shell (never parses Markdown)
 *   - markdown-source-map.ts  the source-position DOM contract the annotation
 *                             host reads to anchor comments to rendered blocks.
 *                             Public ONLY for its DOM-contract exports (see
 *                             SOURCE_MAP_PUBLIC_EXPORTS) — its renderer-internal
 *                             exports (the rehype stamping plugin, heading
 *                             slugifier) stay inside the module.
 */
const PUBLIC_ENTRIES = new Set(
  ["Markdown.tsx", "MarkdownViewport.tsx", "markdown-source-map.ts"].map(
    (file) => path.join(CANONICAL_DIR, file),
  ),
);

const SOURCE_MAP_PUBLIC_ENTRY = path.join(
  CANONICAL_DIR,
  "markdown-source-map.ts",
);

/**
 * The only symbols external code may import from the source-map contract: the
 * runtime DOM-anchoring surface the annotation host consumes. Render-time
 * internals (`rehypeStampSourcePosition`, `slugifyHeading`) are deliberately
 * absent so allowlisting the file cannot smuggle renderer internals out of the
 * module. Deny-by-default: any other named import — or a namespace/side-effect/
 * dynamic import that sidesteps name checking — is a violation.
 */
const SOURCE_MAP_PUBLIC_EXPORTS = new Set([
  "CC_LINE_ATTR",
  "CC_SECTION_ATTR",
  "CC_HEADING_ATTR",
  "BlockMeta",
  "resolveBlockMeta",
  "resolveSelectionBlock",
  "resolveSelectionMeta",
]);

/**
 * The renderer stack. Importing any of these outside the canonical module opens
 * a second Markdown pipeline, which is exactly what canonicalization removes.
 * `mermaid` is bundled here: diagram dispatch is a private detail of the module,
 * so a direct `mermaid` import anywhere else is a parallel render path.
 */
const FORBIDDEN_LIBRARIES = [
  "react-markdown",
  "remark-gfm",
  "react-syntax-highlighter",
  "mermaid",
];

/**
 * Deleted renderers/loaders and the two helpers folded into the canonical module.
 * Matched by the import specifier's basename so a relative (`../MarkdownContent`),
 * aliased (`@/components/legacy/MarkdownViewer`), or old-location import trips the
 * guard regardless of the exact path, even before the module resolves.
 */
const FORBIDDEN_MODULE_BASENAMES = new Set([
  "MarkdownContent",
  "MarkdownViewer",
  "ArtifactMarkdown",
  "MarkdownLink",
  "MermaidDiagram",
]);

/**
 * Deleted renderer/loader identifiers, the thinking-specific Markdown constant,
 * and the retired ask-question Markdown-lite parser's functions/types. `parseInline`,
 * `parseContext`, and `InlineSpan` are absent from the current tree and are
 * parser-distinctive, so restoring that hand-rolled parser trips the guard.
 * `ContextBlock` is intentionally excluded — it collides with an unrelated
 * workflow-builder type — but the parser cannot return without its parse functions.
 */
const FORBIDDEN_IDENTIFIERS = new Set([
  "MarkdownContent",
  "LazyMarkdownContent",
  "MarkdownViewer",
  "ArtifactMarkdown",
  "THINKING_MARKDOWN",
  "parseInline",
  "parseContext",
  "InlineSpan",
]);

/** A hand-rolled Markdown-lite parser (the retired ask-question path) must not return. */
const MARKDOWN_LITE_PATTERN = /markdownlite/i;

/**
 * The sole structural, non-Markdown consumer of `.message-content`: the generic
 * transcript message container. Notice messages, the typing indicator's animated
 * dots, and the canonical MessageMarkdown output all mount inside it, so it keeps
 * container typography only — never a generated-element (heading/paragraph/list/
 * table/quote/pre/code) descendant rule, which would re-couple presentation to a
 * raw HTML hook. This exact-file allowlist is permitted only for that consumer.
 */
const MESSAGE_CONTENT_STRUCTURAL_STYLESHEET = path.resolve(
  SRC_ROOT,
  "features/_root/styles/conversation.css",
);

/**
 * The proven non-Markdown structural consumers of `.message-content` in TSX: the
 * two debug cards. Their nested Tailwind variants
 * (`[[data-debug-mode]_.message.assistant_.message-content…&…]`) reference
 * `.message-content` only as an ANCESTOR/sibling to position the card element
 * (`&`) flush — dropping margin/border/radius so an action card and its adjacent
 * structured card visually fuse in debug mode (legacy session.css adjacency).
 * The styled element is always the card (`&`), never a generated Markdown element,
 * so no generated-element descendant rule appears — which the descendant check
 * below still enforces even for these allowlisted files. This exact-file allowlist
 * is permitted only for that structural, non-Markdown use.
 */
const MESSAGE_CONTENT_STRUCTURAL_TSX = new Set([
  path.resolve(SRC_ROOT, "features/session/debug/DebugActionCard.tsx"),
  path.resolve(SRC_ROOT, "components/DebugStructuredCard.tsx"),
]);

/** Legacy hooks whose every rule was generated Markdown output — no rule may remain. */
const LEGACY_MARKDOWN_HOOKS = [
  ".markdown-content",
  ".wb-markdown-inline",
  ".command-indicator__body",
  ".collab-markdown-text",
];

/**
 * Bare class-token forms of the legacy hooks, for Tailwind class strings in TSX
 * where they appear without a leading dot (`className="markdown-content"`).
 */
const LEGACY_MARKDOWN_HOOK_TOKENS = [
  "markdown-content",
  "wb-markdown-inline",
  "command-indicator__body",
  "collab-markdown-text",
];

/** Annotation presentation must not style generated Markdown output. */
const ANNOTATION_PRESENTATION_PATTERN =
  /\.r6o-[\w-]+|\[data-cc-annotation|\.cc-annotation\b|\.annotation-(?:highlight|mark|pin|marker)/;

const GENERATED_ELEMENT =
  "(?:h[1-6]|p|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|pre|code|a|em|strong|del|img|hr|input|dl|dt|dd)";

/**
 * A generated Markdown element at ANY descendant depth under `.message-content`
 * (not just an immediate child), so `.message-content .prose h1` is caught as
 * surely as `.message-content > h1`. The leading negative lookahead keeps
 * `.message-content-body` (a different class) from matching.
 */
const MESSAGE_CONTENT_DESCENDANT = new RegExp(
  String.raw`\.message-content(?![\w-])[^,{}]*[\s>+~]${GENERATED_ELEMENT}(?![\w-])`,
);

function resolveProjectImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (
    !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    !specifier.startsWith("@/")
  ) {
    return null;
  }

  const baseDirectory = specifier.startsWith("@/")
    ? SRC_ROOT
    : path.dirname(fromFile);
  const relativeSpecifier = specifier.startsWith("@/")
    ? specifier.slice(2)
    : specifier;
  const candidate = path.resolve(baseDirectory, relativeSpecifier);

  for (const extension of SOURCE_EXTENSIONS) {
    const file = `${candidate}${extension}`;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const file = path.join(candidate, `index${extension}`);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

function parseSource(
  file: string,
  text = readFileSync(file, "utf8"),
): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walkFiles(dir: string, accept: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(full, accept));
    } else if (accept(full)) {
      found.push(full);
    }
  }
  return found;
}

function isProductionSource(file: string): boolean {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return false;
  if (/\.(test|stories)\.tsx?$/.test(file)) return false;
  if (file.startsWith(`${path.join(SRC_ROOT, "test")}${path.sep}`))
    return false;
  if (file.startsWith(`${CANONICAL_DIR}${path.sep}`)) return false;
  return true;
}

interface FileImport {
  specifier: string;
  /** Named/default import identifiers (property name for aliased imports). */
  names: string[];
  /** A namespace, `export *`, side-effect, or dynamic import — no name list to check. */
  wholeModule: boolean;
}

function fileImports(source: ts.SourceFile): FileImport[] {
  const imports: FileImport[] = [];

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const names: string[] = [];
      let wholeModule = false;
      const clause = statement.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          wholeModule = true;
        } else {
          for (const element of clause.namedBindings.elements) {
            names.push((element.propertyName ?? element.name).text);
          }
        }
      }
      if (!clause) wholeModule = true; // side-effect import
      imports.push({
        specifier: statement.moduleSpecifier.text,
        names,
        wholeModule,
      });
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const names: string[] = [];
      let wholeModule = false;
      if (!statement.exportClause) {
        wholeModule = true; // export * from "..."
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        wholeModule = true;
      } else {
        for (const element of statement.exportClause.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
      }
      imports.push({
        specifier: statement.moduleSpecifier.text,
        names,
        wholeModule,
      });
    }
  }

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) {
        imports.push({
          specifier: argument.text,
          names: [],
          wholeModule: true,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  return imports;
}

function specifierBasename(specifier: string): string {
  const segment = specifier.split("/").pop() ?? specifier;
  return segment.replace(/\.(tsx?|jsx?)$/, "");
}

function importViolations(fromFile: string, imported: FileImport): string[] {
  const { specifier } = imported;
  const violations: string[] = [];

  if (
    FORBIDDEN_LIBRARIES.some(
      (library) => specifier === library || specifier.startsWith(`${library}/`),
    )
  ) {
    violations.push(`imports renderer library "${specifier}"`);
  }
  if (FORBIDDEN_MODULE_BASENAMES.has(specifierBasename(specifier))) {
    violations.push(`imports deleted/relocated module "${specifier}"`);
  }

  const resolved = resolveProjectImport(fromFile, specifier);
  if (resolved === SOURCE_MAP_PUBLIC_ENTRY) {
    if (imported.wholeModule) {
      violations.push(
        `imports the source-map contract "${specifier}" as a whole module (bypasses the public-export allowlist)`,
      );
    }
    for (const name of imported.names) {
      if (!SOURCE_MAP_PUBLIC_EXPORTS.has(name)) {
        violations.push(
          `imports renderer-internal "${name}" from the source-map contract "${specifier}"`,
        );
      }
    }
  } else if (
    resolved &&
    resolved.startsWith(`${CANONICAL_DIR}${path.sep}`) &&
    !PUBLIC_ENTRIES.has(resolved)
  ) {
    violations.push(`imports canonical internal "${specifier}"`);
  }

  return violations;
}

function forbiddenIdentifiers(source: ts.SourceFile): string[] {
  const hits = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const text = node.text;
      if (FORBIDDEN_IDENTIFIERS.has(text) || MARKDOWN_LITE_PATTERN.test(text)) {
        hits.add(text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...hits];
}

function adapterPropMembers(source: ts.SourceFile): string[] {
  for (const statement of source.statements) {
    if (
      !ts.isTypeAliasDeclaration(statement) ||
      statement.name.text !== "MarkdownProps"
    ) {
      continue;
    }
    let typeNode: ts.TypeNode = statement.type;
    if (
      ts.isTypeReferenceNode(typeNode) &&
      typeNode.typeArguments?.length === 1
    ) {
      typeNode = typeNode.typeArguments[0]!;
    }
    if (!ts.isTypeLiteralNode(typeNode)) {
      throw new Error("MarkdownProps is not a plain object type literal");
    }
    return typeNode.members
      .filter(ts.isPropertySignature)
      .map((member) =>
        ts.isIdentifier(member.name)
          ? member.name.text
          : member.name.getText(source),
      );
  }
  throw new Error("MarkdownProps type alias not found in source");
}

function stylesheetSelectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  const ruleHead = /([^{}]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = ruleHead.exec(withoutComments)) !== null) {
    const head = match[1]!.trim();
    if (!head || head.startsWith("@")) continue;
    for (const selector of head.split(",")) {
      const trimmed = selector.trim();
      if (trimmed) selectors.push(trimmed);
    }
  }
  return selectors;
}

/**
 * Bracketed fragments from a component's class strings — Tailwind arbitrary
 * variants (`[&_h1]:mt-4`, `[.message-content_&]:...`, `[&_.markdown-content]:...`)
 * as well as arbitrary values (`[16px]`, `[var(--x)]`). Every fragment is checked;
 * arbitrary values are harmless because the selector checks match only specific
 * class tokens (`.markdown-content`, `.message-content`, `.r6o-*`, …) that never
 * appear in a value. The Tailwind `_` word separator is normalized back to a CSS
 * descendant space so `[.message-content_h1]` reads as `.message-content h1`.
 *
 * A depth-tracking scanner (not a flat regex) extracts each OUTERMOST bracket
 * intact, so a nested variant like
 * `[[data-debug-mode]_.message.assistant_.message-content_&:last-child]` yields
 * the whole selector — the `.message-content` and any nested `[data-cc-annotation]`
 * reach the checks — rather than only the inner `[data-debug-mode]`.
 */
function embeddedTailwindSelectors(text: string): string[] {
  const selectors: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "[") depth++;
      else if (text[j] === "]" && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) continue; // unbalanced — ignore
    selectors.push(text.slice(i + 1, end).replace(/_/g, " "));
    i = end; // skip the nested inner brackets already covered by this fragment
  }
  return selectors;
}

/**
 * Text of every string / template literal in a source file. Component style
 * checks run over these — not the raw file text — so class strings are inspected
 * while comments and prose (e.g. a doc comment naming `.r6o-annotatable` or a
 * `.message-content` CSS rule) never trip the guard.
 */
function stringLiteralTexts(source: ts.SourceFile): string[] {
  const texts: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      texts.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      texts.push(
        node.head.text,
        ...node.templateSpans.map((s) => s.literal.text),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return texts;
}

function selectorViolations(selector: string, isStructural: boolean): string[] {
  const violations: string[] = [];
  for (const hook of LEGACY_MARKDOWN_HOOKS) {
    if (selector.includes(hook)) {
      violations.push(`legacy Markdown hook "${hook}" in "${selector}"`);
    }
  }
  if (ANNOTATION_PRESENTATION_PATTERN.test(selector)) {
    violations.push(`annotation presentation selector "${selector}"`);
  }
  if (selector.includes(".message-content")) {
    if (!isStructural) {
      violations.push(
        `".message-content" outside the structural container stylesheet in "${selector}"`,
      );
    } else if (MESSAGE_CONTENT_DESCENDANT.test(selector)) {
      violations.push(
        `generated-element rule under ".message-content" in "${selector}"`,
      );
    }
  }
  return violations;
}

function cssFileViolations(file: string, css: string): string[] {
  const isStructural = file === MESSAGE_CONTENT_STRUCTURAL_STYLESHEET;
  return stylesheetSelectors(css).flatMap((selector) =>
    selectorViolations(selector, isStructural),
  );
}

function componentStyleViolations(
  file: string,
  source: ts.SourceFile,
): string[] {
  const isStructural = MESSAGE_CONTENT_STRUCTURAL_TSX.has(file);
  const violations: string[] = [];
  for (const literal of stringLiteralTexts(source)) {
    for (const selector of embeddedTailwindSelectors(literal)) {
      violations.push(...selectorViolations(selector, isStructural));
    }
    // Legacy Markdown hooks are always forbidden — the structural allowlist only
    // ever excuses `.message-content`, never a generated-Markdown style hook.
    for (const token of LEGACY_MARKDOWN_HOOK_TOKENS) {
      if (new RegExp(String.raw`(?<![\w-])${token}(?![\w-])`).test(literal)) {
        violations.push(`legacy Markdown hook token "${token}"`);
      }
    }
  }
  return violations;
}

const PRODUCTION_SOURCES = walkFiles(SRC_ROOT, isProductionSource);
const STYLESHEETS = walkFiles(SRC_ROOT, (file) => file.endsWith(".css"));

describe("canonical Markdown module boundary", () => {
  it("confines the renderer stack and deleted renderers to src/components/markdown", () => {
    const violations: string[] = [];
    for (const file of PRODUCTION_SOURCES) {
      const source = parseSource(file);
      for (const imported of fileImports(source)) {
        for (const reason of importViolations(file, imported)) {
          violations.push(`${path.relative(SRC_ROOT, file)}: ${reason}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the public adapters free of configuration escape-hatch props", () => {
    const source = parseSource(path.join(CANONICAL_DIR, "Markdown.tsx"));
    expect(adapterPropMembers(source)).toEqual(["content"]);
  });

  it("has no deleted Markdown identifiers or Markdown-lite parsers in production code", () => {
    const violations: string[] = [];
    for (const file of PRODUCTION_SOURCES) {
      const hits = forbiddenIdentifiers(parseSource(file));
      if (hits.length > 0) {
        violations.push(`${path.relative(SRC_ROOT, file)}: ${hits.join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("declares no generated Markdown rules under legacy style hooks", () => {
    const violations: string[] = [];
    for (const file of STYLESHEETS) {
      for (const reason of cssFileViolations(
        file,
        readFileSync(file, "utf8"),
      )) {
        violations.push(`${path.relative(SRC_ROOT, file)}: ${reason}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("styles no generated Markdown output through component Tailwind selectors", () => {
    const violations: string[] = [];
    for (const file of PRODUCTION_SOURCES) {
      for (const reason of componentStyleViolations(file, parseSource(file))) {
        violations.push(`${path.relative(SRC_ROOT, file)}: ${reason}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * Mutation fixtures: because the legacy code is already deleted, each guard is
 * fed a crafted regression it must catch. A green guard here proves it enforces
 * the boundary rather than passing vacuously against a clean tree.
 */
describe("canonical Markdown boundary — regression fixtures", () => {
  const OUTSIDE = path.join(SRC_ROOT, "features/__fixture__/Sample.tsx");
  const source = (text: string) => parseSource(OUTSIDE, text);
  const importsOf = (text: string) =>
    fileImports(source(text)).flatMap((imported) =>
      importViolations(OUTSIDE, imported),
    );
  const styleOf = (file: string, classString: string) =>
    componentStyleViolations(file, source(`const c = "${classString}";`));

  it("flags direct renderer-stack imports, including mermaid", () => {
    expect(
      importsOf(`import ReactMarkdown from "react-markdown";`),
    ).not.toEqual([]);
    expect(importsOf(`import remarkGfm from "remark-gfm";`)).not.toEqual([]);
    expect(importsOf(`import mermaid from "mermaid";`)).not.toEqual([]);
    expect(
      importsOf(
        `import { Prism } from "react-syntax-highlighter/dist/esm/prism";`,
      ),
    ).not.toEqual([]);
  });

  it("flags deleted/relocated modules via relative or aliased import paths", () => {
    expect(
      importsOf(`import MarkdownContent from "../MarkdownContent";`),
    ).not.toEqual([]);
    expect(
      importsOf(
        `import { MarkdownViewer } from "@/components/legacy/MarkdownViewer";`,
      ),
    ).not.toEqual([]);
    expect(
      importsOf(
        `import MarkdownLink from "@/components/markdown/MarkdownLink";`,
      ),
    ).not.toEqual([]);
    expect(
      importsOf(`import Mermaid from "../../MermaidDiagram";`),
    ).not.toEqual([]);
  });

  it("flags canonical internals imported through the public directory", () => {
    expect(
      importsOf(
        `import { renderMarkdown } from "@/components/markdown/MarkdownRenderer";`,
      ),
    ).not.toEqual([]);
  });

  it("flags renderer-internal exports pulled off the source-map contract", () => {
    const contract = "@/components/markdown/markdown-source-map";
    expect(
      importsOf(`import { rehypeStampSourcePosition } from "${contract}";`),
    ).not.toEqual([]);
    expect(
      importsOf(`import { slugifyHeading } from "${contract}";`),
    ).not.toEqual([]);
    expect(importsOf(`import * as sourceMap from "${contract}";`)).not.toEqual(
      [],
    );
    // The DOM-contract surface stays importable.
    expect(
      importsOf(
        `import { resolveBlockMeta, CC_LINE_ATTR } from "${contract}";`,
      ),
    ).toEqual([]);
  });

  it("flags the retired Markdown-lite parser without colliding with unrelated identifiers", () => {
    expect(
      forbiddenIdentifiers(
        source(`function parseInline(src: string) { return src; }`),
      ),
    ).toContain("parseInline");
    expect(
      forbiddenIdentifiers(source(`const x: InlineSpan[] = parseContext(md);`)),
    ).not.toEqual([]);
    expect(
      forbiddenIdentifiers(source(`import { MarkdownContent } from "x";`)),
    ).toContain("MarkdownContent");
    // Unrelated identifiers that merely share a substring must NOT trip it.
    expect(
      forbiddenIdentifiers(
        source(
          `type ContextBlock = string; const c = renderArtifactMarkdown();`,
        ),
      ),
    ).toEqual([]);
  });

  it("flags a public adapter that grows a configuration escape-hatch prop", () => {
    expect(
      adapterPropMembers(
        source(
          `export type MarkdownProps = Readonly<{ content: string; allowHtml: boolean }>;`,
        ),
      ),
    ).not.toEqual(["content"]);
  });

  it("flags legacy hooks and any-depth message-content rules in stylesheets", () => {
    const other = "/tmp/other.css";
    const structural = MESSAGE_CONTENT_STRUCTURAL_STYLESHEET;
    expect(
      cssFileViolations(other, `.markdown-content h1 { margin: 0; }`),
    ).not.toEqual([]);
    expect(cssFileViolations(other, `.r6o-widget { color: red; }`)).not.toEqual(
      [],
    );
    expect(
      cssFileViolations(other, `.message-content p { margin: 0; }`),
    ).not.toEqual([]);
    // Deep descendant inside the allowlisted structural file — still forbidden.
    expect(
      cssFileViolations(
        structural,
        `.message-content .prose h1 { margin: 0; }`,
      ),
    ).not.toEqual([]);
    // The proven structural container rules stay clean.
    expect(
      cssFileViolations(
        structural,
        `.message.notice .message-content { padding: 0; } .message-content { color: inherit; }`,
      ),
    ).toEqual([]);
  });

  it("flags generated-Markdown styling embedded in component Tailwind selectors", () => {
    const other = path.join(SRC_ROOT, "features/x/Other.tsx");
    expect(styleOf(other, `[&_.markdown-content]:hidden`)).not.toEqual([]);
    expect(styleOf(other, `[.message-content_h1]:text-lg`)).not.toEqual([]);
    expect(styleOf(other, `markdown-content`)).not.toEqual([]);
    // Generic arbitrary variants unrelated to Markdown output stay clean.
    expect(styleOf(other, `[&_svg]:size-4 [&>a]:underline`)).toEqual([]);
  });

  it("parses nested Tailwind variants and honors the structural debug-card allowlist", () => {
    const other = path.join(SRC_ROOT, "features/x/Other.tsx");
    const structural = path.resolve(
      SRC_ROOT,
      "components/DebugStructuredCard.tsx",
    );
    // The actual nested variant from DebugStructuredCard.tsx. The flat-bracket
    // scan surfaced only `[data-debug-mode]`; the full `.message-content` selector
    // must now reach the guard.
    const nested =
      "[[data-debug-mode]_.message.assistant:has(.debug-action-card)_.message-content_&:last-child]:mb-0";
    expect(
      embeddedTailwindSelectors(nested).some((s) =>
        s.includes(".message-content"),
      ),
    ).toBe(true);

    // Styling `.message-content` from an ordinary component is a violation...
    expect(styleOf(other, nested)).not.toEqual([]);
    // ...but the proven structural debug card is exact-file allowlisted (its `&`
    // is the card, positioned relative to `.message-content` — no generated output).
    expect(styleOf(structural, nested)).toEqual([]);
    // The allowlist never excuses a generated element under `.message-content`,
    // even reached through a nested variant.
    expect(
      styleOf(structural, `[[data-debug-mode]_.message-content_h1]:text-lg`),
    ).not.toEqual([]);
    // Nested annotation-presentation selectors are caught too.
    expect(styleOf(other, `[[data-cc-annotation]_&]:ring`)).not.toEqual([]);
  });
});
