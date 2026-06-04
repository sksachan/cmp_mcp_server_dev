import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const port = process.env.SMOKE_PORT ?? "3131";
const secret = "smoke-secret";
const baseUrl = `http://127.0.0.1:${port}`;
const redirectUri = "https://chatgpt.com/connector/oauth/smoke-callback";

const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: port,
    MCP_SHARED_SECRET: secret,
    OAUTH_LOGIN_PASSWORD: secret,
    PUBLIC_BASE_URL: baseUrl,
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
  await assertOAuthMetadata();
  await assertUnauthorizedMcp();
  await assertToolsList();
  await assertCancelledToolCall();
  const accessToken = await runOAuthFlow();
  await assertOAuthToolsList(accessToken);
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
  assert(
    response.headers.get("www-authenticate")?.includes("/.well-known/oauth-protected-resource"),
    "/mcp 401 did not advertise OAuth protected resource metadata"
  );
}

async function assertOAuthMetadata() {
  const protectedResource = await fetchJson(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert(protectedResource.resource === baseUrl, `unexpected protected resource metadata: ${JSON.stringify(protectedResource)}`);
  assert(
    protectedResource.authorization_servers?.includes(baseUrl),
    `protected resource did not advertise authorization server: ${JSON.stringify(protectedResource)}`
  );

  const authServer = await fetchJson(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert(authServer.authorization_endpoint === `${baseUrl}/oauth/authorize`, `bad authorization endpoint: ${JSON.stringify(authServer)}`);
  assert(authServer.token_endpoint === `${baseUrl}/oauth/token`, `bad token endpoint: ${JSON.stringify(authServer)}`);
  assert(authServer.registration_endpoint === `${baseUrl}/oauth/register`, `bad registration endpoint: ${JSON.stringify(authServer)}`);
}

async function assertToolsList() {
  const event = await mcpRequest(1, "tools/list", {});
  const tools = event.result?.tools ?? [];
  assert(
    tools.some((tool) => tool.name === "deploy_hello_world_to_eks"),
    `tools/list did not expose deploy_hello_world_to_eks: ${JSON.stringify(event)}`
  );
  assert(
    tools.some((tool) => tool.name === "get_hello_world_eks_deployment_status"),
    `tools/list did not expose get_hello_world_eks_deployment_status: ${JSON.stringify(event)}`
  );
  assert(
    tools.some((tool) => tool.name === "get_hello_world_eks_artifact_status"),
    `tools/list did not expose get_hello_world_eks_artifact_status: ${JSON.stringify(event)}`
  );
  assert(
    tools.some((tool) => tool.name === "execute_hello_world_eks_deployment"),
    `tools/list did not expose execute_hello_world_eks_deployment: ${JSON.stringify(event)}`
  );
  const deployTool = tools.find((tool) => tool.name === "deploy_hello_world_to_eks");
  const schemes = deployTool.securitySchemes ?? deployTool._meta?.securitySchemes ?? [];
  assert(
    schemes.some((scheme) => scheme.type === "oauth2" && scheme.scopes?.includes("deploy:eks")),
    `deploy tool did not advertise OAuth security schemes: ${JSON.stringify(deployTool)}`
  );
}

async function assertCancelledToolCall() {
  const event = await mcpRequest(2, "tools/call", {
    name: "deploy_hello_world_to_eks",
    arguments: {
      deployment_context: "Purpose: smoke test only. Environment: dev. Audience: internal validation. Maturity: POC. Components: no AWS execution because confirm_deploy is false.",
      confirm_deploy: false
    }
  });
  assert(event.result?.structuredContent?.status === "cancelled", `cancelled tool call failed: ${JSON.stringify(event)}`);
  assert(event.result?.structuredContent?.run_id === "not-created", `cancelled tool call created a run: ${JSON.stringify(event)}`);
}

async function assertOAuthToolsList(accessToken) {
  const event = await mcpRequest(3, "tools/list", {}, accessToken);
  const tools = event.result?.tools ?? [];
  assert(
    tools.some((tool) => tool.name === "deploy_hello_world_to_eks"),
    `OAuth tools/list did not expose deploy_hello_world_to_eks: ${JSON.stringify(event)}`
  );
  assert(
    tools.some((tool) => tool.name === "get_hello_world_eks_deployment_status"),
    `OAuth tools/list did not expose get_hello_world_eks_deployment_status: ${JSON.stringify(event)}`
  );
  assert(
    tools.some((tool) => tool.name === "get_hello_world_eks_artifact_status"),
    `OAuth tools/list did not expose get_hello_world_eks_artifact_status: ${JSON.stringify(event)}`
  );
  assert(
    tools.some((tool) => tool.name === "execute_hello_world_eks_deployment"),
    `OAuth tools/list did not expose execute_hello_world_eks_deployment: ${JSON.stringify(event)}`
  );
}

async function runOAuthFlow() {
  const registered = await postJson(`${baseUrl}/oauth/register`, {
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  });
  assert(registered.client_id, `registration did not return client_id: ${JSON.stringify(registered)}`);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${baseUrl}/oauth/authorize`);
  authorize.searchParams.set("client_id", registered.client_id);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "deploy:eks");
  authorize.searchParams.set("state", "smoke-state");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("resource", baseUrl);

  const form = new URLSearchParams(authorize.searchParams);
  form.set("password", secret);
  const authResponse = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  assert(authResponse.status === 302, `authorize did not redirect: ${authResponse.status} ${await authResponse.text()}`);
  const location = authResponse.headers.get("location");
  assert(location, "authorize response missing redirect location");
  const code = new URL(location).searchParams.get("code");
  assert(code, `authorize redirect missing code: ${location}`);

  const token = await postForm(`${baseUrl}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: baseUrl
  });
  assert(token.access_token, `token response missing access_token: ${JSON.stringify(token)}`);
  assert(token.token_type === "Bearer", `token response has bad token_type: ${JSON.stringify(token)}`);
  return token.access_token;
}

async function mcpRequest(id, method, params, bearer = secret) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
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

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert(response.ok, `${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  assert(response.ok, `${url} returned ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function postForm(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });
  const data = await response.json();
  assert(response.ok, `${url} returned ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
