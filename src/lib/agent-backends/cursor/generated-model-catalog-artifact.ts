import {
  backendModelCatalogSchema,
  type BackendModelCatalog,
} from "../schemas";

import generatedModelCatalog from "./generated-model-catalog.json";
import { CURSOR_SDK_PINNED_VERSION } from "./sdk-pin";

export function parseGeneratedCursorModelCatalog(
  value: unknown,
  expectedSdkVersion: string,
): BackendModelCatalog {
  const catalog = backendModelCatalogSchema.parse(value);
  if (catalog.backend !== "cursor") {
    throw new Error(
      `Generated Cursor model catalog declares backend "${catalog.backend}".`,
    );
  }
  if (catalog.provenance.sdkVersion !== expectedSdkVersion) {
    throw new Error(
      `Generated Cursor model catalog SDK version "${catalog.provenance.sdkVersion ?? "missing"}" does not match installed version "${expectedSdkVersion}".`,
    );
  }
  return catalog;
}

/** Pure, client-safe reader for the generated build artifact. */
export function readGeneratedCursorModelCatalog(): BackendModelCatalog {
  return parseGeneratedCursorModelCatalog(
    generatedModelCatalog,
    CURSOR_SDK_PINNED_VERSION,
  );
}
