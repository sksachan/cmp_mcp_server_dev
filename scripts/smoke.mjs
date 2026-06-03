import { spawn } from "node:child_process";

const port = process.env.SMOKE_PORT ?? "3131";
const secret = "smoke-secret";
const baseUrl = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: port,
    MCP_SHARED_SECRET: secret,
    BODHI_PAT_TOKEN: "smoke-pat",
    BODHI_API_BASE_URL: "https://bodhi.example.invalid/api"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
server.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  await waitForServer();
  await assertHealth();
  await assertUnauthorizedMcp();
  await assertToolsList();
  await assertCancelledToolCall();
  console.log("Smoke test passed");
} finally {
  server.kill("SIGTERM");
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (output.includes(`listening on port ${port}`)) return;
    await sleep(100);
  }
  throw new Error(`Server did not start. Output:\n${output}`);
}

async function assertHealth() {
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();
  assert(response.ok, `/health returned ${response.status}`);
  assert(body.status === "ok", `/health did not return ok: ${JSON.stringify(body)}`);
}

async function assertUnauthorizedMcp() {
  const response = await fetch(`${baseUrl}/mcp`);
  assert(response.status === 401, `/mcp without auth returned ${response.status}, expected 401`);
}

async function assertToolsList() {
  const event = await mcpRequest(1, "tools/list", {});
  const tools = event.result?.tools ?? [];
  assert(
    tools.some((tool) => tool.name === "deploy_hello_world_to_eks"),
    `tools/list did not expose deploy_hello_world_to_eks: ${JSON.stringify(event)}`
  );
}

async function assertCancelledToolCall() {
  const event = await mcpRequest(2, "tools/call", {
    name: "deploy_hello_world_to_eks",
    arguments: {
      confirm_deploy: false
    }
  });
  assert(event.result?.structuredContent?.status === "cancelled", `cancelled tool call failed: ${JSON.stringify(event)}`);
  assert(event.result?.structuredContent?.run_id === "not-created", `cancelled tool call created a run: ${JSON.stringify(event)}`);
}

async function mcpRequest(id, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })
  });

  const text = await response.text();
  assert(response.ok, `MCP ${method} returned ${response.status}: ${text}`);
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  assert(dataLine, `MCP ${method} did not return an SSE data line: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
