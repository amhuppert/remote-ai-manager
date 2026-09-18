export async function readProbeResponse(
  response: Response,
): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}
