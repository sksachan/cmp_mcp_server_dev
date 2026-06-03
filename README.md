# CMP MCP Server

Remote MCP server for ChatGPT that starts a Bodhi workflow, submits HITL deployment inputs, waits for completion, and returns Hello World EKS deployment details.

## Local Development

```bash
npm i
npm run build
npm run verify
npm run smoke
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

MCP endpoint:

```text
http://localhost:3000/mcp
```

For authenticated MCP calls, send either:

```text
Authorization: Bearer <MCP_SHARED_SECRET>
```

or:

```text
X-MCP-Shared-Secret: <MCP_SHARED_SECRET>
```

## Railway

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full Bodhi, GitHub, Railway, and ChatGPT connector handoff.

Settings:

```text
Root Directory: MCP_Server
Build Command: npm ci --include=dev && npm run build
Start Command: npm start
Healthcheck Path: /health
Public Networking: Enabled
ChatGPT Connector URL: https://<railway-domain>/mcp
Deploy Mode: wait for CI / deploy after GitHub checks pass
```

If you push the contents of `MCP_Server` as the GitHub repository root, leave Railway Root Directory empty. If you push the whole workspace with `MCP_Server` as a subfolder, set Railway Root Directory to `MCP_Server` and set the custom config file path to `/MCP_Server/railway.json`.

Required variables:

```text
NODE_ENV=production
PORT=<Railway-provided>
MCP_SHARED_SECRET=<strong-random-secret>
BODHI_API_BASE_URL=https://sapientaiproducts.com/save/api/v1
BODHI_PAT_TOKEN=<real-pat-token>
BODHI_WORKFLOW_ID=8598b371-272b-44ca-b7c9-3ff772e96477
BODHI_TASK_ID=9664fd27-c7e6-4595-963e-c04c6ecd59e8
AWS_ACCOUNT_ID=051370627449
AWS_ACCOUNT_ALIAS=demo
DEFAULT_AWS_REGION=us-east-1
```

Optional polling variables:

```text
BODHI_HITL_POLL_INTERVAL_MS=3000
BODHI_RUN_POLL_INTERVAL_MS=20000
BODHI_TIMEOUT_MS=1800000
DEFAULT_CLUSTER_NAME=hello-world-demo
DEFAULT_NAMESPACE=hello-world
DEFAULT_BUDGET_LIMIT_USD=100
```
