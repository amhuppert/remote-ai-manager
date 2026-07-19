import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import {
  capabilityApplyTimingSchema,
  capabilityKindSchema,
  continuationStrengthSchema,
  forkSupportSchema,
  queueDeliveryTimingSchema,
  skillTriggerPrefixSchema,
  structuredOutputSupportSchema,
  type AgentBackendDescriptor,
} from "./descriptor";
import { effortLevelSchema } from "./schemas";
import type { ConversationBackendFactory } from "./conversation";
import type { AgentTaskRunner } from "./task";

const logger = createLogger("agent-backends:registry");

/**
 * Keyed by string so id policy lives in `registerBackend` (production ids must
 * be members of the canonical enum) while `_registerBackendForTesting` can
 * admit a parameterized test descriptor without widening the production type.
 */
const descriptors = new Map<string, AgentBackendDescriptor>();

/**
 * Runtime belt for the data-bearing metadata surface. The descriptor type
 * already constrains these fields, but a miswired or dynamically-assembled
 * descriptor (which the type system cannot vouch for) must fail at the
 * registry boundary, not at a consumer.
 */
export const backendMetadataIntegritySchema = z.object({
  label: z.string().trim().min(1),
  toneToken: z.string().trim().min(1),
  skillTriggerPrefix: skillTriggerPrefixSchema,
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().trim().min(1),
        description: z.string(),
        effortLevels: z.array(effortLevelSchema),
      }),
    )
    .min(1),
  defaultModelId: z.string().min(1),
  defaultTimeoutMs: z.number().positive().nullable(),
  defaultStallTimeoutMs: z.number().positive().nullable().optional(),
});

/** Runtime belt for the declared conversation capability vocabularies. */
export const backendConversationCapabilitiesIntegritySchema = z.object({
  queue: z.object({
    acceptsWhileRunning: z.boolean(),
    deliveryTiming: queueDeliveryTimingSchema,
  }),
  continuationStrength: continuationStrengthSchema,
  fork: forkSupportSchema,
  structuredOutput: structuredOutputSupportSchema,
  contextWindowMetrics: z.boolean(),
  nativeMidTurnAskUser: z.boolean(),
  externalTurns: z.boolean(),
  capabilityKinds: z.array(
    z.object({
      kind: capabilityKindSchema,
      applyTiming: capabilityApplyTimingSchema,
    }),
  ),
});

function rejectDescriptor(backend: string, reason: string): never {
  logger.error("registry.descriptor_rejected", { backend, reason });
  throw new Error(`Backend descriptor "${backend}" ${reason}`);
}

function assertFacetIdAgreement(
  descriptor: AgentBackendDescriptor,
  facetPath: string,
  facetBackend: AgentBackendId,
): void {
  if (facetBackend !== descriptor.id) {
    rejectDescriptor(
      descriptor.id,
      `facet ${facetPath} claims backend "${facetBackend}" (must equal the descriptor id)`,
    );
  }
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function validateDescriptorCompleteness(
  descriptor: AgentBackendDescriptor,
): void {
  if (descriptor.conversation === undefined && descriptor.tasks === undefined) {
    rejectDescriptor(
      descriptor.id,
      "declares no execution facet (conversation or tasks required)",
    );
  }
  if (descriptors.has(descriptor.id)) {
    throw new Error(`Backend "${descriptor.id}" is already registered`);
  }

  const metadata = backendMetadataIntegritySchema.safeParse(
    descriptor.metadata,
  );
  if (!metadata.success) {
    rejectDescriptor(
      descriptor.id,
      `has invalid metadata: ${summarizeIssues(metadata.error)}`,
    );
  }
  const modelIds = descriptor.metadata.models.map((m) => m.id);
  if (new Set(modelIds).size !== modelIds.length) {
    rejectDescriptor(descriptor.id, "has duplicate model ids");
  }
  if (!modelIds.includes(descriptor.metadata.defaultModelId)) {
    rejectDescriptor(
      descriptor.id,
      `defaultModelId "${descriptor.metadata.defaultModelId}" is not in its model catalog`,
    );
  }

  const conversation = descriptor.conversation;
  if (conversation) {
    assertFacetIdAgreement(
      descriptor,
      "conversation.factory",
      conversation.factory.backend,
    );
    assertFacetIdAgreement(
      descriptor,
      "conversation.continuity",
      conversation.continuity.backend,
    );
    assertFacetIdAgreement(
      descriptor,
      "conversation.runtimeConfig",
      conversation.runtimeConfig.backend,
    );

    const capabilities =
      backendConversationCapabilitiesIntegritySchema.safeParse(
        conversation.capabilities,
      );
    if (!capabilities.success) {
      rejectDescriptor(
        descriptor.id,
        `has invalid conversation capabilities: ${summarizeIssues(capabilities.error)}`,
      );
    }
    const kinds = conversation.capabilities.capabilityKinds.map((k) => k.kind);
    if (new Set(kinds).size !== kinds.length) {
      rejectDescriptor(
        descriptor.id,
        "has duplicate capability kind declarations",
      );
    }
  }

  const tasks = descriptor.tasks;
  if (tasks) {
    assertFacetIdAgreement(descriptor, "tasks.runner", tasks.runner.backend);
    const taskOutput = structuredOutputSupportSchema.safeParse(
      tasks.structuredOutput,
    );
    if (!taskOutput.success) {
      rejectDescriptor(
        descriptor.id,
        `has an invalid tasks.structuredOutput value "${String(tasks.structuredOutput)}"`,
      );
    }
  }

  assertFacetIdAgreement(descriptor, "mcp", descriptor.mcp.backend);
}

function registerValidatedDescriptor(descriptor: AgentBackendDescriptor): void {
  validateDescriptorCompleteness(descriptor);
  descriptors.set(descriptor.id, descriptor);
  logger.info("registry.backend_registered", {
    backend: descriptor.id,
    facets: [
      ...(descriptor.conversation ? ["conversation"] : []),
      ...(descriptor.tasks ? ["tasks"] : []),
    ],
    modelCount: descriptor.metadata.models.length,
  });
}

/**
 * The only production registration call. Rejects ids outside the canonical
 * backend enum, duplicate registrations, and incomplete descriptors.
 */
export function registerBackend(descriptor: AgentBackendDescriptor): void {
  const parsed = agentBackendSchema.safeParse(descriptor.id);
  if (!parsed.success) {
    throw new Error(
      `Backend id "${descriptor.id}" is not a member of the canonical backend enum`,
    );
  }
  registerValidatedDescriptor(descriptor);
}

/** Identical to registerBackend except it skips the id-enum runtime check. */
export function _registerBackendForTesting(
  descriptor: AgentBackendDescriptor,
): void {
  registerValidatedDescriptor(descriptor);
}

export function _resetBackendRegistryForTesting(): void {
  descriptors.clear();
}

export function hasBackendDescriptor(id: string): boolean {
  return descriptors.has(id);
}

export function getBackendDescriptor(
  id: AgentBackendId,
): AgentBackendDescriptor {
  const descriptor = descriptors.get(id);
  if (!descriptor) {
    throw new Error(`No backend descriptor registered for backend: ${id}`);
  }
  return descriptor;
}

/** Registration order. */
export function listBackends(): readonly AgentBackendDescriptor[] {
  return [...descriptors.values()];
}

export function getConversationBackendFactory(
  backend: AgentBackendId,
): ConversationBackendFactory {
  const descriptor = getBackendDescriptor(backend);
  if (!descriptor.conversation) {
    throw new Error(`Backend "${backend}" declares no conversation facet`);
  }
  logger.debug("Retrieved conversation backend factory", { backend });
  return descriptor.conversation.factory;
}

export function getTaskRunner(backend: AgentBackendId): AgentTaskRunner {
  const descriptor = getBackendDescriptor(backend);
  if (!descriptor.tasks) {
    throw new Error(`Backend "${backend}" declares no tasks facet`);
  }
  logger.debug("Retrieved task runner", { backend });
  return descriptor.tasks.runner;
}
