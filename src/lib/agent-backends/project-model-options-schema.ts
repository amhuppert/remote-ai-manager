import { z } from "zod";

import { agentBackendSchema } from "@/lib/shared/schemas";

import { backendCatalogModelSchema } from "./catalog";
import {
  backendModelCatalogSchema,
  backendModelSelectionSchema,
} from "./schemas";

export const projectModelCatalogDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    modelId: z.string().min(1).optional(),
  })
  .strict();
export type ProjectModelCatalogDiagnostic = z.infer<
  typeof projectModelCatalogDiagnosticSchema
>;

export const projectBackendModelOptionsSchema = z.object({
  backend: agentBackendSchema,
  models: z.array(backendCatalogModelSchema),
  defaultModelId: z.string().nullable(),
  /** Where the list came from, so a surface can explain an empty one. */
  source: z.enum(["catalog", "project"]),
  /** Complete project-effective variants for catalog-driven controls. */
  modelCatalog: backendModelCatalogSchema.nullable(),
  /** The validated global selection applied when a request supplies none. */
  defaultSelection: backendModelSelectionSchema.nullable(),
  diagnostics: z.array(projectModelCatalogDiagnosticSchema),
});
export type ProjectBackendModelOptions = z.infer<
  typeof projectBackendModelOptionsSchema
>;

export const projectModelOptionsResponseSchema = z.object({
  backends: z.array(projectBackendModelOptionsSchema),
});
export type ProjectModelOptionsResponse = z.infer<
  typeof projectModelOptionsResponseSchema
>;
