export function resolveMcpHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  bearerTokenEnvVar: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
):
  | { headers: Record<string, string>; missingBearer?: never }
  | { missingBearer: string; headers?: never } {
  const resolved = { ...headers };
  const hasAuthorization = Object.keys(resolved).some(
    (name) => name.toLowerCase() === "authorization",
  );
  if (!bearerTokenEnvVar || hasAuthorization) return { headers: resolved };
  const token = environment[bearerTokenEnvVar];
  if (!token) return { missingBearer: bearerTokenEnvVar };
  return { headers: { ...resolved, authorization: "Bearer " + token } };
}
