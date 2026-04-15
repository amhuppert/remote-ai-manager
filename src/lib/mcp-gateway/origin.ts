function assertHttpOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CC server origin must be an absolute http(s) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CC server origin must be an absolute http(s) URL");
  }

  return parsed.origin;
}

export function getCommandCenterOrigin(): string {
  const configured = process.env.CC_SERVER_URL?.trim();
  if (configured) {
    return assertHttpOrigin(configured);
  }

  const host = process.env.CC_HOST ?? "127.0.0.1";
  const port = process.env.PORT ?? "3000";
  return assertHttpOrigin(`http://${host}:${port}`);
}
