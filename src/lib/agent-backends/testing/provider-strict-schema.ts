/**
 * Return every violation of the strict JSON Schema dialect accepted by
 * provider-native structured output, as the provider stated the rules when
 * refusing live dispatches (see `codex/output-schema.ts` for the catalogue).
 *
 * A CC-owned schema that is already strict needs no projection on the Codex
 * path, so its first attempt is enforced natively as authored; a test pinning
 * that with this helper keeps a later edit from quietly degrading the schema
 * to the projected or prompt-carried form.
 */
export function findProviderStrictSchemaViolations(
  node: unknown,
  path = "$",
  violations: string[] = [],
): string[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return violations;
  }
  const schema: Record<string, unknown> = { ...node };

  if (path === "$" && schema.type !== "object") {
    violations.push(`${path} must be a single object schema`);
  }
  if ("oneOf" in schema) {
    violations.push(`${path}.oneOf is not permitted by the provider`);
  }
  if ("const" in schema && !("type" in schema)) {
    violations.push(`${path} declares const without a type`);
  }

  const properties = schema.properties;
  if (schema.type === "object" || properties !== undefined) {
    if (schema.additionalProperties !== false) {
      violations.push(`${path} must declare additionalProperties: false`);
    }
    if (typeof properties !== "object" || properties === null) {
      violations.push(`${path} declares an object with no properties`);
    }
  }
  if (typeof properties === "object" && properties !== null) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) {
        violations.push(`${path}.required is missing ${JSON.stringify(key)}`);
      }
      findProviderStrictSchemaViolations(
        (properties as Record<string, unknown>)[key],
        `${path}.properties.${key}`,
        violations,
      );
    }
  }

  if ("items" in schema) {
    findProviderStrictSchemaViolations(
      schema.items,
      `${path}.items`,
      violations,
    );
  }
  for (const [index, branch] of (Array.isArray(schema.anyOf)
    ? schema.anyOf
    : []
  ).entries()) {
    findProviderStrictSchemaViolations(
      branch,
      `${path}.anyOf[${index}]`,
      violations,
    );
  }

  return violations;
}
