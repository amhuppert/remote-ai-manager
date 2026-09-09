/**
 * Architecture seam ESLint rules (consolidated plan §0.4 / §3.5.2). One plugin,
 * six rules:
 *
 *   no-backend-deep-import              backend adapter seam: deep
 *     agent-backends/{claude,codex} imports and the provider SDK packages are
 *     confined to src/lib/agent-backends/; existing offenders live in the
 *     burn-down allowlist (eslint-rules/seam-allowlists.mjs).
 *   no-raw-broadcaster-import           SSE publication seam: raw
 *     events/broadcaster value imports are confined to the sanctioned
 *     publication/transport modules (and test files, which exercise the
 *     transport directly). Registered as ERROR (plan Phase 4.1d).
 *   no-cross-feature-import             structure.md boundary: a file in
 *     src/features/<a>/ must not import from src/features/<b>/. _root
 *     styles/layout are the shared foundation and stay importable.
 *   no-external-state-store-construction  createStateStore construction is
 *     confined to src/lib/state-store/ and test files.
 *   no-data-tooltip-attribute          the retired delegated `data-tooltip`
 *     mechanism may no longer be authored as a rendered JSX attribute.
 *   no-server-logging-in-client        client-bundle seam: a client-reachable
 *     module must not STATICALLY import the SERVER logging barrel (@/lib/logging,
 *     which re-exports node:async_hooks-backed tracing) or any node: builtin —
 *     either drags Node internals into the eager client bundle. Use
 *     @/lib/logging/client-logger. Static imports/re-exports/require only; a
 *     dynamic import() is a code-splitting boundary and is left to the build.
 *     Scoped to client-reachable files by the config `files` glob (only `bun run
 *     build` caught the original break; construction over convention, plan P6).
 *
 * Allowlists are burn-down debt, not an approved boundary: entries are removed
 * as the owning phases migrate each offender, never added to admit new code.
 */

import path from "node:path";

/** Normalize a filename to forward slashes with a leading "/" so path-segment
 *  matching behaves the same for absolute paths and RuleTester-style relative
 *  filenames. */
function normalizeFile(filename) {
  const file = (filename ?? "").split("\\").join("/");
  return file.startsWith("/") ? file : `/${file}`;
}

/** True iff the normalized file matches an allowlist entry (repo-relative
 *  paths, e.g. "src/lib/sessions/service.ts"). */
function isListed(file, entries) {
  return entries.some((entry) => file.endsWith(`/${entry}`));
}

function isTestFile(file) {
  return /\.test\.(ts|tsx|mts|mjs)$/.test(file);
}

/** Visitors invoking `onSource(specifier, reportNode, importNode)` for every
 *  static import/re-export, dynamic import(), and require() call with a string
 *  literal specifier. */
function importSourceVisitors(onSource) {
  return {
    ImportDeclaration(node) {
      onSource(node.source.value, node.source, node);
    },
    ExportNamedDeclaration(node) {
      if (node.source) onSource(node.source.value, node.source, node);
    },
    ExportAllDeclaration(node) {
      onSource(node.source.value, node.source, node);
    },
    ImportExpression(node) {
      if (
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        onSource(node.source.value, node.source, node);
      }
    },
    CallExpression(node) {
      const arg = node.arguments[0];
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        arg &&
        arg.type === "Literal" &&
        typeof arg.value === "string"
      ) {
        onSource(arg.value, arg, node);
      }
    },
  };
}

const ALLOWLIST_SCHEMA = [
  {
    type: "object",
    properties: {
      allowlist: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
];

// ---------------------------------------------------------------------------
// (1) Backend adapter seam
// ---------------------------------------------------------------------------

const SDK_PACKAGES = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];

/** Deep adapter-internal path: any agent-backends/claude|codex segment, alias
 *  ("@/lib/agent-backends/claude/…") or relative ("../agent-backends/codex/…"). */
const DEEP_ADAPTER_PATH = /(^|\/)agent-backends\/(claude|codex)(\/|$)/;

function isBackendSeamViolation(spec) {
  if (SDK_PACKAGES.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`))) {
    return true;
  }
  return DEEP_ADAPTER_PATH.test(spec);
}

const noBackendDeepImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Confine deep agent-backends/{claude,codex} imports and the provider SDK packages to the backend adapter seam (src/lib/agent-backends/).",
    },
    messages: {
      backendSeam:
        "'{{spec}}' crosses the backend adapter seam: provider SDKs and adapter internals may only be imported inside src/lib/agent-backends/. Consume the seam surface (registry, descriptors, neutral events/types) instead. Existing offenders are burn-down debt in BACKEND_SEAM_ALLOWLIST (eslint-rules/seam-allowlists.mjs) — do not add entries for new code.",
    },
    schema: ALLOWLIST_SCHEMA,
  },
  create(context) {
    const file = normalizeFile(context.filename);
    if (file.includes("/src/lib/agent-backends/")) return {};
    const allowlist = context.options[0]?.allowlist ?? [];
    if (isListed(file, allowlist)) return {};
    return importSourceVisitors((spec, reportNode) => {
      if (isBackendSeamViolation(spec)) {
        context.report({
          node: reportNode,
          messageId: "backendSeam",
          data: { spec },
        });
      }
    });
  },
};

// ---------------------------------------------------------------------------
// (2) SSE publication seam
// ---------------------------------------------------------------------------

const BROADCASTER_PATH = /(^|\/)events\/broadcaster$/;

/** A static import binds only types when the whole declaration is `import
 *  type …` or every named specifier is inline `type`-qualified. Type-only
 *  imports are the DI boundary (`BroadcastFn`), not a raw publication path. */
function bindsOnlyTypes(node) {
  if (node.type !== "ImportDeclaration") return false;
  if (node.importKind === "type") return true;
  return (
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (s) => s.type === "ImportSpecifier" && s.importKind === "type",
    )
  );
}

const noRawBroadcasterImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Confine raw events/broadcaster value imports to the sanctioned SSE publication/transport modules; other modules take a BroadcastFn via dependency injection or use the typed publication layer.",
    },
    messages: {
      rawBroadcaster:
        "Raw events/broadcaster import outside the sanctioned publication/transport modules. Accept a BroadcastFn (type-only import) via dependency injection, or publish through the sanctioned publication layer. Sanctioned modules are listed in SSE_PUBLICATION_SANCTIONED (eslint-rules/seam-allowlists.mjs).",
    },
    schema: [
      {
        type: "object",
        properties: {
          sanctioned: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const file = normalizeFile(context.filename);
    // Test files exercise the transport directly (broadcaster tests,
    // _resetForTesting) and are sanctioned by nature (Blocker 5 §5.2.5).
    if (isTestFile(file)) return {};
    const sanctioned = context.options[0]?.sanctioned ?? [];
    if (isListed(file, sanctioned)) return {};
    return importSourceVisitors((spec, reportNode, importNode) => {
      if (!BROADCASTER_PATH.test(spec)) return;
      if (bindsOnlyTypes(importNode)) return;
      context.report({ node: reportNode, messageId: "rawBroadcaster" });
    });
  },
};

// ---------------------------------------------------------------------------
// (3) Cross-feature import boundary
// ---------------------------------------------------------------------------

/** Resolve an import specifier to `{ feature, rest }` when it lands inside
 *  src/features/, else null. Handles the "@/features/…" alias and relative
 *  paths resolved against the importing file's directory. */
function resolveFeatureTarget(spec, file) {
  let featurePath = null;
  if (spec.startsWith("@/features/")) {
    featurePath = spec.slice("@/features/".length);
  } else if (spec.startsWith(".")) {
    const dir = file.slice(0, file.lastIndexOf("/"));
    const segments = dir.split("/");
    for (const part of spec.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") segments.pop();
      else segments.push(part);
    }
    const resolved = segments.join("/");
    const idx = resolved.indexOf("/src/features/");
    if (idx === -1) return null;
    featurePath = resolved.slice(idx + "/src/features/".length);
  }
  if (featurePath === null) return null;
  const [feature, ...restParts] = featurePath.split("/");
  if (!feature) return null;
  return { feature, rest: restParts.join("/") };
}

/** _root's styles + root layout are the shared foundation every feature may
 *  import (structure.md); the rest of _root is feature-private like any other
 *  feature directory. */
function isSharedRootImport(target) {
  if (target.feature !== "_root") return false;
  return (
    target.rest.startsWith("styles/") ||
    target.rest === "RootLayout" ||
    target.rest === "RootLayout.tsx"
  );
}

/** Allowlist of exact (importer file, target feature) edges. An entry exempts
 *  only that edge: the visitor keeps running for allowlisted files, so a NEW
 *  cross-feature import from the same file into a different feature still
 *  fails. */
const EDGE_ALLOWLIST_SCHEMA = [
  {
    type: "object",
    properties: {
      allowlist: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            to: { type: "string" },
          },
          required: ["file", "to"],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
];

const noCrossFeatureImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Files in src/features/<a>/ must not import from src/features/<b>/ (structure.md); promote shared code to src/components/ or src/hooks/ instead. _root styles/layout are the shared foundation and stay importable.",
    },
    messages: {
      crossFeature:
        "Cross-feature import: '{{spec}}' reaches from feature '{{from}}' into feature '{{to}}'. Promote the shared code to src/components/ or src/hooks/ (structure.md). Existing (file → feature) edges are burn-down debt in CROSS_FEATURE_ALLOWLIST (eslint-rules/seam-allowlists.mjs) — do not add entries for new code.",
    },
    schema: EDGE_ALLOWLIST_SCHEMA,
  },
  create(context) {
    const file = normalizeFile(context.filename);
    const featureMatch = /\/src\/features\/([^/]+)\//.exec(file);
    if (!featureMatch) return {};
    const ownFeature = featureMatch[1];
    const allowlist = context.options[0]?.allowlist ?? [];
    const allowedTargetFeatures = new Set(
      allowlist
        .filter((edge) => file.endsWith(`/${edge.file}`))
        .map((edge) => edge.to),
    );
    return importSourceVisitors((spec, reportNode) => {
      const target = resolveFeatureTarget(spec, file);
      if (!target) return;
      if (target.feature === ownFeature) return;
      if (isSharedRootImport(target)) return;
      if (allowedTargetFeatures.has(target.feature)) return;
      context.report({
        node: reportNode,
        messageId: "crossFeature",
        data: { spec, from: ownFeature, to: target.feature },
      });
    });
  },
};

// ---------------------------------------------------------------------------
// (4) State-store construction restriction
// ---------------------------------------------------------------------------

const STORE_CONSTRUCTORS = new Set(["createStateStore", "createStateManager"]);

/** Module specifier landing in src/lib/state-store — alias
 *  ("@/lib/state-store", "@/lib/state-store/store") or relative
 *  ("../state-store"). */
const STATE_STORE_MODULE = /(^|\/)state-store(\/|$)/;

function isStateStoreRequire(node) {
  const arg = node.arguments[0];
  return (
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    arg !== undefined &&
    arg.type === "Literal" &&
    typeof arg.value === "string" &&
    STATE_STORE_MODULE.test(arg.value)
  );
}

const noExternalStateStoreConstruction = {
  meta: {
    type: "problem",
    docs: {
      description:
        "createStateStore construction is confined to src/lib/state-store/ and test files; production code uses the shared singleton (getStateStore).",
    },
    messages: {
      storeConstruction:
        "'{{name}}(…)' constructs a private state store outside src/lib/state-store/. Private instances read stale state and race the singleton's write queue — use the shared singleton accessor (getStateStore) instead. Test fixtures over a fresh :memory: DB belong in test files (or STATE_STORE_CONSTRUCTION_ALLOWLIST in eslint-rules/seam-allowlists.mjs).",
    },
    schema: ALLOWLIST_SCHEMA,
  },
  create(context) {
    const file = normalizeFile(context.filename);
    if (file.includes("/src/lib/state-store/")) return {};
    if (isTestFile(file)) return {};
    const allowlist = context.options[0]?.allowlist ?? [];
    if (isListed(file, allowlist)) return {};

    // Bind-aware tracking: renaming the imported constructor or reaching it
    // through a namespace/require binding must not evade the rule.
    /** Local names bound (possibly aliased) to a store-constructor export. */
    const constructorBindings = new Set();
    /** Local names bound to the whole state-store module. */
    const namespaceBindings = new Set();

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (!STATE_STORE_MODULE.test(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportNamespaceSpecifier") {
            namespaceBindings.add(spec.local.name);
          } else if (
            spec.type === "ImportSpecifier" &&
            spec.importKind !== "type" &&
            spec.imported.type === "Identifier" &&
            STORE_CONSTRUCTORS.has(spec.imported.name)
          ) {
            constructorBindings.add(spec.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        if (
          !node.init ||
          node.init.type !== "CallExpression" ||
          !isStateStoreRequire(node.init)
        ) {
          return;
        }
        if (node.id.type === "Identifier") {
          namespaceBindings.add(node.id.name);
          return;
        }
        if (node.id.type !== "ObjectPattern") return;
        for (const prop of node.id.properties) {
          if (
            prop.type === "Property" &&
            prop.key.type === "Identifier" &&
            STORE_CONSTRUCTORS.has(prop.key.name) &&
            prop.value.type === "Identifier"
          ) {
            constructorBindings.add(prop.value.name);
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier") {
          if (
            STORE_CONSTRUCTORS.has(callee.name) ||
            constructorBindings.has(callee.name)
          ) {
            context.report({
              node: callee,
              messageId: "storeConstruction",
              data: { name: callee.name },
            });
          }
          return;
        }
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          STORE_CONSTRUCTORS.has(callee.property.name) &&
          callee.object.type === "Identifier" &&
          namespaceBindings.has(callee.object.name)
        ) {
          context.report({
            node: callee,
            messageId: "storeConstruction",
            data: { name: `${callee.object.name}.${callee.property.name}` },
          });
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// (5) Retired `data-tooltip` authoring
// ---------------------------------------------------------------------------

const noDataTooltipAttribute = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The delegated `data-tooltip` tooltip mechanism is retired: a rendered `data-tooltip` JSX attribute may no longer be authored. Compose WithTooltip / ui/Tooltip (Radix-backed) instead.",
    },
    messages: {
      dataTooltip:
        '`data-tooltip` is the retired delegated tooltip mechanism (its global provider is deleted). Wrap the trigger in <WithTooltip label={…}> from @/components/ui/WithTooltip (Radix-backed: keyboard-focus reveal, Escape/blur dismissal, `role="tooltip"` + `aria-describedby`) — and give an icon-only trigger its own `aria-label` for the accessible name. Reads/selectors of the attribute are fine; only authoring a rendered attribute is banned.',
    },
    schema: [],
  },
  create(context) {
    // Only the literal JSX attribute name `data-tooltip` is authoring. The
    // `data-tooltip-pos` companion (a different attribute name) and any
    // getAttribute/selector READ of the attribute are not rendered tooltip
    // markup and never match.
    return {
      JSXAttribute(node) {
        if (
          node.name &&
          node.name.type === "JSXIdentifier" &&
          node.name.name === "data-tooltip"
        ) {
          context.report({ node, messageId: "dataTooltip" });
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// (6) Server logging / node: builtins in the client bundle
// ---------------------------------------------------------------------------

/** The SERVER logging barrel and its server-only submodules. `@/lib/logging`
 *  re-exports `context.ts`, whose `AsyncLocalStorage` pulls in
 *  `node:async_hooks` — importing it from a client-reachable module drags Node
 *  internals into the browser bundle. `client-logger` is the sanctioned
 *  client-safe entry and is deliberately NOT matched. Matches the "@/lib/logging"
 *  alias and relative forms ("../logging", "./logging/logger"). */
const SERVER_LOGGING_SUBMODULES = new Set([
  "logger",
  "context",
  "tracing",
  "timed",
  "trace-coverage",
  "speedscope-export",
  "index",
]);

/** True iff `spec` resolves to the server logging barrel or a server-only
 *  logging submodule (never `client-logger`). */
function isServerLoggingImport(spec) {
  const match =
    /(^|\/)(?:lib\/)?logging(?:\/([\w-]+))?(?:\.(?:ts|tsx|js|mjs))?$/.exec(
      spec,
    );
  if (!match) return false;
  const submodule = match[2];
  if (submodule === undefined) return true; // bare barrel: "@/lib/logging"
  if (submodule === "client-logger") return false;
  return SERVER_LOGGING_SUBMODULES.has(submodule);
}

/** True iff `spec` is a Node.js core builtin — the `node:` scheme, or a bare
 *  builtin name (`fs`, `path`, `fs/promises`, …). A `node:`-prefixed specifier
 *  is unambiguously a core module; the bare list stays conservative so app
 *  packages that merely resemble a builtin name never false-positive. */
const NODE_BUILTIN_NAMES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

function isNodeBuiltinImport(spec) {
  if (spec.startsWith("node:")) return true;
  const root = spec.split("/")[0];
  return NODE_BUILTIN_NAMES.has(root);
}

/** Static/eager import sources only: `import`, `export … from`, and `require`.
 *  Deliberately EXCLUDES dynamic `import()` — a dynamic import is a
 *  code-splitting boundary that places the target in a lazily-loaded chunk the
 *  browser only fetches on demand, not in the importing module's eager graph.
 *  The bundle break this rule guards (commit c625755f) was a STATIC top-level
 *  `import { createLogger } from "@/lib/logging"` in an SSE-reaction module,
 *  which drags node:async_hooks into the eager client chunk and fails the build;
 *  the two pre-existing guarded `void import("@/lib/logging")` sites code-split
 *  cleanly and never failed it. Guard the eager edge; leave the split edge to
 *  the build. */
function staticImportSourceVisitors(onSource) {
  return {
    ImportDeclaration(node) {
      onSource(node.source.value, node.source);
    },
    ExportNamedDeclaration(node) {
      if (node.source) onSource(node.source.value, node.source);
    },
    ExportAllDeclaration(node) {
      onSource(node.source.value, node.source);
    },
    CallExpression(node) {
      const arg = node.arguments[0];
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        arg &&
        arg.type === "Literal" &&
        typeof arg.value === "string"
      ) {
        onSource(arg.value, arg);
      }
    },
  };
}

const noServerLoggingInClient = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Client-reachable modules must not statically import the server logging barrel (@/lib/logging) or a node: builtin — either drags Node internals (node:async_hooks) into the eager client bundle. Use @/lib/logging/client-logger.",
    },
    messages: {
      serverLogging:
        "'{{spec}}' statically imports the SERVER logging barrel from a client-reachable module. It re-exports node:async_hooks-backed tracing, so it drags Node internals into the eager client bundle and fails the production build (only `bun run build` catches this). Import { createClientLogger } from '@/lib/logging/client-logger' instead.",
      nodeBuiltin:
        "'{{spec}}' statically imports a node: builtin from a client-reachable module — Node core has no browser bundle and breaks the client build. Move the server-only logic behind an API route / server module, or use a browser-safe equivalent.",
    },
    schema: [],
  },
  create(context) {
    return staticImportSourceVisitors((spec, reportNode) => {
      if (isServerLoggingImport(spec)) {
        context.report({
          node: reportNode,
          messageId: "serverLogging",
          data: { spec },
        });
        return;
      }
      if (isNodeBuiltinImport(spec)) {
        context.report({
          node: reportNode,
          messageId: "nodeBuiltin",
          data: { spec },
        });
      }
    });
  },
};

const noGraphOwnershipViolation = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          allowlist: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                target: { type: "string" },
              },
              required: ["file", "target"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      graphLiveEditOwnership:
        "Graph command adapters must delegate structural edits to the runtime-edit service. Definition mutation belongs to the live-edit core.",
      graphOwnership:
        "'{{spec}}' crosses a graph workflow ownership boundary. Use the domain operation or repository contract; shipping code cannot depend on HTTP adapters or engine test harnesses.",
    },
  },
  create(context) {
    const file = normalizeFile(context.filename);
    if (isTestFile(file)) return {};
    const fixture = /\/(testing|compat)\/|\/[^/]*test-fixture\./.test(file);
    const adapter =
      /\/(?:[^/]*route-handlers|[^/]*route-composition|route)\.[cm]?[jt]sx?$/.test(
        file,
      );
    const commandAdapter =
      adapter ||
      /\/src\/cli\/commands\/workflow[^/]*\.[cm]?[jt]sx?$/.test(file);
    const allowlist = context.options[0]?.allowlist ?? [];
    const imports = importSourceVisitors((spec, reportNode, node) => {
      if (bindsOnlyTypes(node) || node.exportKind === "type") return;
      const target = (
        spec.startsWith("@/")
          ? `/src/${spec.slice(2)}`
          : path.posix.resolve(path.posix.dirname(file), spec)
      ).replace(/\.[cm]?[jt]sx?$/, "");
      const dedicatedLiveEditServiceEdge =
        file.endsWith(
          "/src/lib/workflow-graph/runtime-edit-route-handlers.ts",
        ) && target.endsWith("/src/lib/workflow-graph/live-edit-apply");
      if (
        commandAdapter &&
        !dedicatedLiveEditServiceEdge &&
        /\/src\/lib\/workflow-graph\/(?:document-edit-mechanics|live-edit-apply)$/.test(
          target,
        )
      ) {
        context.report({
          node: reportNode,
          messageId: "graphLiveEditOwnership",
        });
        return;
      }
      const repositoryToManager =
        file.endsWith("/src/lib/workflow-graph/execution-repository.ts") &&
        target.endsWith("/src/lib/workflow-graph/workflow-manager");
      const domainToRoute =
        !adapter &&
        !fixture &&
        file.includes("/src/lib/") &&
        /\/src\/lib\/workflow-graph\/[^/]*route-handlers$/.test(target);
      const shippingToHarness =
        !fixture &&
        /\/src\/lib\/workflow-graph\/(?:compat|testing)\/[^/]*engine-harness$/.test(
          target,
        );
      if (!repositoryToManager && !domainToRoute && !shippingToHarness) return;
      if (
        allowlist.some(
          (edge) =>
            file.endsWith(`/${edge.file}`) &&
            target.endsWith(`/${edge.target}`),
        )
      )
        return;
      context.report({
        node: reportNode,
        messageId: "graphOwnership",
        data: { spec },
      });
    });
    if (!commandAdapter) return imports;
    function propertyName(node) {
      if (node.type !== "MemberExpression") return null;
      if (!node.computed && node.property.type === "Identifier")
        return node.property.name;
      if (node.computed && node.property.type === "Literal")
        return node.property.value;
      return null;
    }
    function touchesDefinition(node) {
      if (node.type !== "MemberExpression") return false;
      return (
        propertyName(node) === "workingDefinition" ||
        touchesDefinition(node.object)
      );
    }
    function reportWrite(node, target) {
      if (touchesDefinition(target))
        context.report({ node, messageId: "graphLiveEditOwnership" });
    }
    const mutators = new Set([
      "push",
      "pop",
      "shift",
      "unshift",
      "splice",
      "sort",
      "reverse",
      "fill",
      "copyWithin",
    ]);
    return {
      ...imports,
      AssignmentExpression(node) {
        reportWrite(node, node.left);
      },
      UpdateExpression(node) {
        reportWrite(node, node.argument);
      },
      UnaryExpression(node) {
        if (node.operator === "delete") reportWrite(node, node.argument);
      },
      CallExpression(node) {
        imports.CallExpression?.(node);
        const name = propertyName(node.callee);
        if (mutators.has(name)) reportWrite(node, node.callee.object);
        if (
          name === "assign" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Object" &&
          node.arguments[0]
        ) {
          reportWrite(node, node.arguments[0]);
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "architecture-seams", version: "1.0.0" },
  rules: {
    "no-backend-deep-import": noBackendDeepImport,
    "no-raw-broadcaster-import": noRawBroadcasterImport,
    "no-cross-feature-import": noCrossFeatureImport,
    "no-external-state-store-construction": noExternalStateStoreConstruction,
    "no-data-tooltip-attribute": noDataTooltipAttribute,
    "no-server-logging-in-client": noServerLoggingInClient,
    "no-graph-ownership-violation": noGraphOwnershipViolation,
  },
};

export default plugin;
