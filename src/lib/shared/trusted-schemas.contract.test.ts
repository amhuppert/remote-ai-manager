import { describe, expect, it } from "vitest";

// Importing the consuming repos forces module-load registration of every schema
// routed through parseTrusted: the local table-row + blob schemas defined in the
// repos, and the shared domain schemas registered at their definition sites
// (loaded transitively when each repo imports them).
import "@/lib/state-store/reference-documents-repo";
import "@/lib/jobs/repo";
import "@/lib/notifications/repo";
import "@/lib/state-store/projects-repo";

import { getTrustedSchemaRegistry } from "./parse-trusted";
import { isEffectFree } from "./testing/effect-free";

import { referenceDocumentSchema } from "@/lib/reference-documents/schemas";
import { backgroundJobSchema } from "@/lib/jobs/schemas";
import { notificationSchema } from "@/lib/notifications/schemas";
import { projectRowSchema } from "@/lib/projects/schemas";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";

describe("trusted schema registry effect-free guardrail", () => {
  it("registers a non-empty set of trusted schemas", () => {
    expect(getTrustedSchemaRegistry().size).toBeGreaterThan(0);
  });

  it("every schema routed through parseTrusted is effect-free", () => {
    const offenders: string[] = [];
    for (const [schema, name] of getTrustedSchemaRegistry()) {
      if (!isEffectFree(schema)) offenders.push(name);
    }
    // An offender means parseTrusted would skip a parse that applies a
    // default/transform/coercion — diverging from dev in production. Either
    // remove the effect or stop routing that schema through parseTrusted.
    expect(offenders).toEqual([]);
  });

  it("registers the expected shared domain schemas", () => {
    const registry = getTrustedSchemaRegistry();
    for (const schema of [
      referenceDocumentSchema,
      backgroundJobSchema,
      notificationSchema,
      projectRowSchema,
      mcpOverridesSchema,
      agentCapabilityOverridesSchema,
    ]) {
      expect(registry.has(schema)).toBe(true);
    }
  });
});
