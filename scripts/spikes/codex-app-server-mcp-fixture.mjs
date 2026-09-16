// A deterministic MCP peer used only by codex-app-server-poc.mjs.
let buffer = "";
let pendingCall;
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize")
      send({
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cc-research-peer", version: "1.0.0" },
        },
      });
    else if (message.method === "tools/list")
      send({
        id: message.id,
        result: {
          tools: [
            {
              name: "probe",
              description:
                "Test the configured environment and an MCP elicitation decline. Call once for the transport experiment.",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        },
      });
    else if (message.method === "tools/call") {
      pendingCall = message.id;
      send({
        id: "fixture-elicitation",
        method: "elicitation/create",
        params: {
          message: "Research only: choose a label.",
          requestedSchema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
      });
    } else if (message.id === "fixture-elicitation") {
      send({
        id: pendingCall,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                env: process.env.POC_MCP_LABEL,
                elicitationAction: message.result?.action ?? "error",
                elicitationError: message.error ?? null,
              }),
            },
          ],
        },
      });
    } else if (message.id !== undefined && message.method)
      send({
        id: message.id,
        error: { code: -32601, message: "Unknown fixture method" },
      });
  }
});
