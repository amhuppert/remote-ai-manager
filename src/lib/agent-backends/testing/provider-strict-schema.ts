/**
 * Return every violation of the strict JSON Schema subset accepted by
 * provider-native structured output.
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

  if ("oneOf" in schema) {
    violations.push(`${path}.oneOf is not permitted by the provider`);
  }
  if (("const" in schema || "enum" in schema) && !("type" in schema)) {
    violations.push(`${path} declares const/enum without a type`);
  }

  const properties = schema.properties;
  if (typeof properties === "object" && properties !== null) {
    if (schema.additionalProperties !== false) {
      violations.push(`${path} must declare additionalProperties: false`);
    }
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
