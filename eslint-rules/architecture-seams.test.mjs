/**
 * Architecture seam rules (consolidated plan §0.4 / §3.5.2): each rule FAILS on
 * a sample seam violation and PASSES on the sanctioned patterns plus allowlisted
 * burn-down offenders. `npx eslint .` exiting 0 proves the allowlists cover the
 * real tree; these RuleTester cases pin per-rule behavior in CI.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { describe } from "vitest";
import plugin from "./architecture-seams.mjs";

const tsx = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe("architecture-seams", () => {
  // (1) Backend seam: deep agent-backends/{claude,codex} + SDK-package imports
  // are confined to the adapter seam.
  tsx.run("no-backend-deep-import", plugin.rules["no-backend-deep-import"], {
    valid: [
      // Seam-level modules (registry, types, descriptor) are the public surface.
      {
        code: `import { getBackend } from "@/lib/agent-backends/registry";`,
        filename: "src/lib/prompt/service.ts",
      },
      // Inside the seam, adapters import their own SDK freely.
      {
        code: `import { query } from "@anthropic-ai/claude-agent-sdk";`,
        filename: "src/lib/agent-backends/claude/query-session.ts",
      },
      {
        code: `import { Codex } from "@openai/codex-sdk";`,
        filename: "src/lib/agent-backends/codex/thread-runner.ts",
      },
      // Allowlisted burn-down offender.
      {
        code: `import { query } from "@anthropic-ai/claude-agent-sdk";`,
        filename: "src/lib/sessions/service.ts",
        options: [{ allowlist: ["src/lib/sessions/service.ts"] }],
      },
      // Unrelated imports never match.
      {
        code: `import { z } from "zod";`,
        filename: "src/lib/prompt/service.ts",
      },
    ],
    invalid: [
      {
        code: `import { query } from "@anthropic-ai/claude-agent-sdk";`,
        filename: "src/lib/prompt/service.ts",
        errors: [{ messageId: "backendSeam" }],
      },
      // Type-only imports leak SDK vocabulary across the seam just the same.
      {
        code: `import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";`,
        filename: "src/lib/workflows/conversation/other-handler.ts",
        errors: [{ messageId: "backendSeam" }],
      },
      {
        code: `import { mapAssistantContentBlocks } from "@/lib/agent-backends/claude/map-content-blocks";`,
        filename: "src/lib/prompt/service.ts",
        errors: [{ messageId: "backendSeam" }],
      },
      // Relative deep import.
      {
        code: `import { parseOutput } from "../agent-backends/codex/codex-output";`,
        filename: "src/lib/codex-runs/other.ts",
        errors: [{ messageId: "backendSeam" }],
      },
      // Dynamic import.
      {
        code: `const mod = await import("@/lib/agent-backends/codex/codex-output");`,
        filename: "src/lib/jobs/queue.ts",
        errors: [{ messageId: "backendSeam" }],
      },
      // SDK subpath.
      {
        code: `import { helper } from "@openai/codex-sdk/dist/helper";`,
        filename: "src/lib/jobs/queue.ts",
        errors: [{ messageId: "backendSeam" }],
      },
      // Re-export crosses the seam too.
      {
        code: `export { query } from "@anthropic-ai/claude-agent-sdk";`,
        filename: "src/lib/prompt/service.ts",
        errors: [{ messageId: "backendSeam" }],
      },
    ],
  });

  // (2) SSE publication: raw events/broadcaster imports are confined to the
  // sanctioned publication/transport modules and test files (ERROR severity
  // is set in config, plan Phase 4.1d).
  tsx.run(
    "no-raw-broadcaster-import",
    plugin.rules["no-raw-broadcaster-import"],
    {
      valid: [
        // Type-only import: the DI boundary type, not a raw publication path.
        {
          code: `import type { BroadcastFn } from "@/lib/events/broadcaster";`,
          filename: "src/lib/dev-server/liveness.ts",
        },
        // Inline type specifiers only.
        {
          code: `import { type BroadcastFn } from "@/lib/events/broadcaster";`,
          filename: "src/lib/jobs/queue.ts",
        },
        // Sanctioned transport module.
        {
          code: `import { broadcast, subscribe } from "@/lib/events/broadcaster";`,
          filename: "src/lib/events/sse-route-handlers.ts",
          options: [{ sanctioned: ["src/lib/events/sse-route-handlers.ts"] }],
        },
        // Sanctioned typed publication layer (broadcaster adapter).
        {
          code: `const { broadcast } = require("@/lib/events/broadcaster");`,
          filename: "src/lib/events/publication.ts",
          options: [{ sanctioned: ["src/lib/events/publication.ts"] }],
        },
        // Test files exercise the transport directly (sanctioned by nature).
        {
          code: `import { broadcast, _resetForTesting } from "@/lib/events/broadcaster";`,
          filename: "src/lib/events/broadcaster.test.ts",
        },
        // Unrelated module of similar name.
        {
          code: `import { broadcast } from "@/lib/other/broadcaster-utils";`,
          filename: "src/lib/jobs/queue.ts",
        },
      ],
      invalid: [
        {
          code: `import { broadcast } from "@/lib/events/broadcaster";`,
          filename: "src/lib/mcp/sse-broadcast.ts",
          errors: [{ messageId: "rawBroadcaster" }],
        },
        // Relative form.
        {
          code: `import { broadcast as defaultBroadcast } from "../events/broadcaster";`,
          filename: "src/lib/jobs/queue.ts",
          errors: [{ messageId: "rawBroadcaster" }],
        },
        // Mixed value + type specifiers still bind the value.
        {
          code: `import { broadcast, type BroadcastFn } from "@/lib/events/broadcaster";`,
          filename: "src/lib/jobs/queue.ts",
          errors: [{ messageId: "rawBroadcaster" }],
        },
        // Lazy require.
        {
          code: `const { broadcast } = require("@/lib/events/broadcaster");`,
          filename: "src/lib/jobs/queue.ts",
          errors: [{ messageId: "rawBroadcaster" }],
        },
      ],
    },
  );

  // (3) Cross-feature imports: a feature may import itself, _root styles/layout,
  // and anything outside src/features — never a sibling feature.
  tsx.run("no-cross-feature-import", plugin.rules["no-cross-feature-import"], {
    valid: [
      // Same feature, alias + relative.
      {
        code: `import ConversationList from "@/features/session/conversation/ConversationList";`,
        filename: "src/features/session/SessionListPage.tsx",
      },
      {
        code: `import { helper } from "../hooks/use-voice-wiring";`,
        filename: "src/features/session/prompt/PromptComposer.tsx",
      },
      // _root foundation styles + root layout are shared by convention.
      {
        code: `import "@/features/_root/styles/keyboard-shortcuts-modal.css";`,
        filename: "src/features/session/dialogs/HotkeyDialog.tsx",
      },
      {
        code: `import RootLayout from "@/features/_root/RootLayout";`,
        filename: "src/features/session/SessionListPage.tsx",
      },
      // Promoted shared code and lib domains are the sanctioned escape.
      {
        code: `import Button from "@/components/ui/Button"; import { q } from "@/lib/sessions/queries";`,
        filename: "src/features/project-detail/ProjectDetailView.tsx",
      },
      // Allowlisted burn-down offender: the exact (importer, target feature)
      // edge is exempt, nothing broader.
      {
        code: `import DiffPanel from "@/features/session/git/DiffPanel";`,
        filename: "src/features/project-detail/cockpit/MainDiffSurface.tsx",
        options: [
          {
            allowlist: [
              {
                file: "src/features/project-detail/cockpit/MainDiffSurface.tsx",
                to: "session",
              },
            ],
          },
        ],
      },
    ],
    invalid: [
      {
        code: `import DiffPanel from "@/features/session/git/DiffPanel";`,
        filename: "src/features/project-detail/cockpit/OtherSurface.tsx",
        errors: [{ messageId: "crossFeature" }],
      },
      // Relative traversal into a sibling feature.
      {
        code: `import PromptComposer from "../../session/prompt/PromptComposer";`,
        filename: "src/features/project-detail/composer/Other.tsx",
        errors: [{ messageId: "crossFeature" }],
      },
      // _root outside styles/layout is NOT the shared foundation.
      {
        code: `import { deriveSpawnCards } from "@/features/_root/spawn-card/derive-spawn-cards";`,
        filename: "src/features/project-detail/cockpit/Other.tsx",
        errors: [{ messageId: "crossFeature" }],
      },
      // _root itself is a feature dir for this purpose: it must not reach into
      // sibling features either.
      {
        code: `import { slot } from "@/features/project-detail/cockpit/spawn-card-slot";`,
        filename: "src/features/_root/spawn-card/other-card.ts",
        errors: [{ messageId: "crossFeature" }],
      },
      // Dynamic import.
      {
        code: `const mod = await import("@/features/session/git/DiffPanel");`,
        filename: "src/features/project-detail/cockpit/Other.tsx",
        errors: [{ messageId: "crossFeature" }],
      },
      // An allowlisted edge exempts ONLY that (importer, target feature)
      // pair: a new edge into a different feature from the same file fails.
      {
        code: `import DiffPanel from "@/features/session/git/DiffPanel";\nimport { spec } from "@/features/workflows-catalog/machine-specs";`,
        filename: "src/features/project-detail/cockpit/MainDiffSurface.tsx",
        options: [
          {
            allowlist: [
              {
                file: "src/features/project-detail/cockpit/MainDiffSurface.tsx",
                to: "session",
              },
            ],
          },
        ],
        errors: [
          {
            messageId: "crossFeature",
            data: {
              spec: "@/features/workflows-catalog/machine-specs",
              from: "project-detail",
              to: "workflows-catalog",
            },
          },
        ],
      },
    ],
  });

  // (4) createStateStore construction confined to state-store/ + tests.
  tsx.run(
    "no-external-state-store-construction",
    plugin.rules["no-external-state-store-construction"],
    {
      valid: [
        // The owning domain constructs freely.
        {
          code: `const store = createStateStore({ db, writeQueue, repos });`,
          filename: "src/lib/state-store/store.ts",
        },
        // Test files construct fresh stores over :memory: DBs.
        {
          code: `const store = createStateStore({ db, writeQueue, repos });`,
          filename: "src/lib/conversations/service.test.ts",
        },
        // Allowlisted shared test fixture.
        {
          code: `const store = createStateStore({ db, writeQueue, repos });`,
          filename: "src/lib/shared/testing/persistence-fixture.ts",
          options: [
            { allowlist: ["src/lib/shared/testing/persistence-fixture.ts"] },
          ],
        },
        // Importing the binding for typeof-typing only is not construction.
        {
          code: `import { createStateStore } from "@/lib/state-store"; type S = ReturnType<typeof createStateStore>;`,
          filename: "src/lib/mcp/runtime-apply.ts",
        },
        // Namespace import used for typeof-typing only is not construction.
        {
          code: `import * as stateStore from "@/lib/state-store"; type S = ReturnType<typeof stateStore.createStateStore>;`,
          filename: "src/lib/mcp/config-mutation-service.ts",
        },
        // Namespace member calls on unrelated modules never match.
        {
          code: `import * as factory from "@/lib/other/factory"; const s = factory.createStateStore({});`,
          filename: "src/lib/mcp/service.ts",
        },
      ],
      invalid: [
        {
          code: `const store = createStateStore({ db, writeQueue, repos });`,
          filename: "src/lib/mcp/service.ts",
          errors: [{ messageId: "storeConstruction" }],
        },
        // The deleted alias name is equally construction.
        {
          code: `const state = createStateManager({ db, writeQueue, repos });`,
          filename: "src/lib/conversations/service.ts",
          errors: [{ messageId: "storeConstruction" }],
        },
        // Aliasing at import does not evade the call check.
        {
          code: `import { createStateStore as createStateManager } from "@/lib/state-store"; const s = createStateManager({});`,
          filename: "src/lib/mcp/service.ts",
          errors: [{ messageId: "storeConstruction" }],
        },
        // Renaming the imported binding to an arbitrary name does not evade it.
        {
          code: `import { createStateStore as makeStore } from "@/lib/state-store"; const s = makeStore({});`,
          filename: "src/lib/mcp/service.ts",
          errors: [{ messageId: "storeConstruction" }],
        },
        // Namespace member access does not evade it.
        {
          code: `import * as stateStore from "@/lib/state-store"; const s = stateStore.createStateStore({});`,
          filename: "src/lib/mcp/service.ts",
          errors: [{ messageId: "storeConstruction" }],
        },
        // require() destructuring with an alias does not evade it.
        {
          code: `const { createStateStore: makeStore } = require("@/lib/state-store"); const s = makeStore({});`,
          filename: "src/lib/mcp/service.ts",
          errors: [{ messageId: "storeConstruction" }],
        },
        // Bare require() binding used as a namespace does not evade it.
        {
          code: `const stateStore = require("@/lib/state-store"); const s = stateStore.createStateStore({});`,
          filename: "src/lib/mcp/service.ts",
          errors: [{ messageId: "storeConstruction" }],
        },
      ],
    },
  );

  // (5) data-tooltip authoring: the legacy delegated `data-tooltip` mechanism is
  // retired — a rendered `data-tooltip` JSX attribute may no longer be authored;
  // WithTooltip/ui/Tooltip is the only tooltip surface. Reads/selectors of the
  // attribute never author UI and must not match.
  tsx.run(
    "no-data-tooltip-attribute",
    plugin.rules["no-data-tooltip-attribute"],
    {
      valid: [
        // The migrated primitive — a text label reveals the tooltip.
        {
          code: `const el = <WithTooltip label="New conversation"><button aria-label="New conversation" /></WithTooltip>;`,
          filename: "src/components/session/sidebar/ConversationSidebar.tsx",
        },
        // A dynamic label still goes through the primitive.
        {
          code: `const el = <WithTooltip label={forkLabel}><span /></WithTooltip>;`,
          filename: "src/components/session/sidebar/ConversationSidebarRow.tsx",
        },
        // Reading the attribute (accessibility assertion / selector) is not
        // authoring and never matches — it is not a rendered JSX attribute.
        {
          code: `const t = target.getAttribute("data-tooltip");`,
          filename: "src/components/TooltipProbe.ts",
        },
        {
          code: `const nodes = document.querySelectorAll("[data-tooltip]");`,
          filename: "src/lib/dom/probe.ts",
        },
        // A `data-tooltip-pos` companion attribute is a different attribute name
        // and is not the authored tooltip label.
        {
          code: `const el = <span data-tooltip-pos="top" />;`,
          filename: "src/features/session/conversation/Foo.tsx",
        },
      ],
      invalid: [
        // A rendered `data-tooltip=` JSX attribute is the retired mechanism.
        {
          code: `const el = <button data-tooltip="Collapse sidebar" />;`,
          filename: "src/components/session/sidebar/ConversationSidebar.tsx",
          errors: [{ messageId: "dataTooltip" }],
        },
        // A dynamic (expression) value is equally the retired mechanism.
        {
          code: `const el = <span data-tooltip={forkLabel} />;`,
          filename: "src/features/session/conversation/ConversationList.tsx",
          errors: [{ messageId: "dataTooltip" }],
        },
        // Passed through a component prop (e.g. IconButton spreads it onto its
        // button) it is still authored tooltip markup.
        {
          code: `const el = <IconButton data-tooltip="Rename" />;`,
          filename: "src/features/session/conversation/ConversationList.tsx",
          errors: [{ messageId: "dataTooltip" }],
        },
      ],
    },
  );

  // (6) Client-bundle seam: a client-reachable module must not STATICALLY import
  // the SERVER logging barrel (@/lib/logging, which re-exports node:async_hooks-
  // backed tracing) or a node: builtin — either drags Node internals into the
  // eager browser bundle (only `bun run build` caught the original break, a
  // static `import { createLogger } from "@/lib/logging"` in an SSE-reaction
  // module — commit c625755f). The client-safe @/lib/logging/client-logger entry
  // is the sanctioned path. A dynamic `import()` is a code-splitting boundary and
  // is deliberately NOT flagged (the split chunk loads on demand, not eagerly).
  // Config scopes this rule to the client-reachable file set; RuleTester
  // exercises the detector.
  tsx.run(
    "no-server-logging-in-client",
    plugin.rules["no-server-logging-in-client"],
    {
      valid: [
        // The sanctioned client-safe logging entry.
        {
          code: `import { createClientLogger } from "@/lib/logging/client-logger";`,
          filename: "src/lib/jobs/sse-reactions.ts",
        },
        // Relative form of the client-safe entry.
        {
          code: `import { createClientLogger } from "../logging/client-logger";`,
          filename: "src/lib/notifications/sse-reactions.ts",
        },
        // Ordinary app imports never match.
        {
          code: `import { useQuery } from "@tanstack/react-query";`,
          filename: "src/lib/api/optimistic.ts",
        },
        // A module whose name merely contains "logging" but is not the barrel.
        {
          code: `import { fmt } from "@/lib/logging-helpers/format";`,
          filename: "src/components/Foo.tsx",
        },
        // An app package that resembles a bare Node builtin name but is scoped
        // or clearly non-core is not a builtin (only the exact bare list +
        // the node: scheme match).
        {
          code: `import { z } from "zod";`,
          filename: "src/components/Foo.tsx",
        },
        {
          code: `import mitt from "path-to-regexp";`,
          filename: "src/hooks/use-foo.ts",
        },
        // Dynamic import() is a code-splitting boundary — the target lands in a
        // lazily-loaded chunk, not the importing module's eager graph — so it is
        // NOT the bundle break this rule guards. The two pre-existing guarded
        // `void import("@/lib/logging")` sites (PeekPopover, useOverlayScope)
        // code-split cleanly and never failed the build.
        {
          code: `void import("@/lib/logging").then(({ createLogger }) => createLogger("m"));`,
          filename: "src/components/session/sidebar/PeekPopover.tsx",
        },
        {
          code: `const os = await import("node:os");`,
          filename: "src/hooks/use-foo.ts",
        },
      ],
      invalid: [
        // The server logging barrel drags node:async_hooks into the client
        // bundle — the exact break commit c625755f fixed.
        {
          code: `import { createLogger } from "@/lib/logging";`,
          filename: "src/lib/conversations/sse-reactions.ts",
          errors: [{ messageId: "serverLogging" }],
        },
        // Relative import of the barrel.
        {
          code: `import { createLogger } from "../../logging";`,
          filename: "src/lib/api/fetcher.ts",
          errors: [{ messageId: "serverLogging" }],
        },
        // A server-only logging submodule is equally forbidden.
        {
          code: `import { createLogger } from "@/lib/logging/logger";`,
          filename: "src/components/Widget.tsx",
          errors: [{ messageId: "serverLogging" }],
        },
        {
          code: `import { runWithTrace } from "@/lib/logging/context";`,
          filename: "src/features/session/Foo.tsx",
          errors: [{ messageId: "serverLogging" }],
        },
        // Type-only import still leaks the module edge into the bundle graph.
        {
          code: `import type { Logger } from "@/lib/logging";`,
          filename: "src/stores/session-detail.store.ts",
          errors: [{ messageId: "serverLogging" }],
        },
        // Re-export from the barrel is an eager edge too.
        {
          code: `export { createLogger } from "@/lib/logging";`,
          filename: "src/lib/api/sse.ts",
          errors: [{ messageId: "serverLogging" }],
        },
        // Direct node: builtin — Node core has no browser bundle.
        {
          code: `import { AsyncLocalStorage } from "node:async_hooks";`,
          filename: "src/components/Widget.tsx",
          errors: [{ messageId: "nodeBuiltin" }],
        },
        // A bare builtin name (no node: scheme) is still a Node core module.
        {
          code: `import { readFile } from "fs/promises";`,
          filename: "src/features/session/Foo.tsx",
          errors: [{ messageId: "nodeBuiltin" }],
        },
        // eager require() of a node: builtin.
        {
          code: `const path = require("node:path");`,
          filename: "src/lib/api/fetcher.ts",
          errors: [{ messageId: "nodeBuiltin" }],
        },
      ],
    },
  );
});
