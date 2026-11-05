// A minimal MCP client: one JSON-RPC 2.0 tools/call per request to <BROADCAST_URL>/api/mcp. The
// server runs MCP in stateless JSON mode, so no session or initialize is needed.

export class ToolError extends Error {}

let nextId = 0;

export function mcpConfig(env = process.env) {
  const url = (env.BROADCAST_URL ?? "").replace(/\/+$/, "");
  const token = env.BROADCAST_TOKEN ?? "";
  if (!url) throw new ToolError("Set BROADCAST_URL to your Broadcast server, for example https://mail.example.com.");
  if (!token) throw new ToolError("Set BROADCAST_TOKEN to an admin API token with the plugin developer permission (Admin > API Tokens in Broadcast).");
  return { url, token };
}

// An event-stream answer carries the JSON-RPC message in its `data:` lines.
function parseBody(text, contentType) {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  return JSON.parse(data[data.length - 1]);
}

// Returns the tool's answer (parsed JSON when it is JSON). Throws ToolError on any failure.
export async function callTool(config, name, args) {
  let res;
  try {
    res = await fetch(`${config.url}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (err) {
    throw new ToolError(`Cannot reach ${config.url}: ${err.cause?.message ?? err.message}`);
  }
  const text = await res.text();
  let msg;
  try {
    msg = parseBody(text, res.headers.get("content-type") ?? "");
  } catch {
    throw new ToolError(`${name}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (msg.error) throw new ToolError(`${name}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  const output = (msg.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (msg.result?.isError) throw new ToolError(`${name}: ${output}`);
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}
