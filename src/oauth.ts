import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";

type RegisteredClient = {
  clientId: string;
  redirectUris: string[];
  createdAt: number;
};

type AuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
};

type AccessToken = {
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
};

type RefreshToken = {
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
};

export const DEPLOY_SCOPE = "deploy:eks";

export class OAuthService {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly authCodes = new Map<string, AuthCode>();
  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly refreshTokens = new Map<string, RefreshToken>();
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  getProtectedResourceMetadata(baseUrl: string) {
    return {
      resource: baseUrl,
      authorization_servers: [baseUrl],
      scopes_supported: [DEPLOY_SCOPE],
      resource_documentation: `${baseUrl}/health`
    };
  }

  getAuthorizationServerMetadata(baseUrl: string) {
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [DEPLOY_SCOPE]
    };
  }

  async registerClient(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string")
      : [];

    if (redirectUris.length === 0) {
      return json(res, 400, { error: "invalid_request", error_description: "redirect_uris is required" });
    }

    const clientId = `cmp-${randomToken(18)}`;
    this.clients.set(clientId, {
      clientId,
      redirectUris,
      createdAt: Date.now()
    });

    return json(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: DEPLOY_SCOPE
    });
  }

  async authorize(req: IncomingMessage, res: ServerResponse, baseUrl: string): Promise<void> {
    if (req.method === "GET") {
      const url = new URL(req.url ?? "/", baseUrl);
      return this.renderAuthorizeForm(res, Object.fromEntries(url.searchParams.entries()));
    }

    const body = await readForm(req);
    const password = stringValue(body.password);
    if (!password || !safeEqual(password, this.config.oauthLoginPassword)) {
      return this.renderAuthorizeForm(res, body, "Invalid password.");
    }

    const clientId = requireParam(body, "client_id");
    const redirectUri = requireParam(body, "redirect_uri");
    const codeChallenge = requireParam(body, "code_challenge");
    const responseType = requireParam(body, "response_type");
    const resource = stringValue(body.resource) ?? baseUrl;
    const scope = stringValue(body.scope) || DEPLOY_SCOPE;
    const state = stringValue(body.state);

    if (responseType !== "code") {
      return json(res, 400, { error: "unsupported_response_type" });
    }

    if (!this.isRedirectAllowed(clientId, redirectUri)) {
      return json(res, 400, { error: "invalid_request", error_description: "redirect_uri is not allowed" });
    }

    const code = randomToken(32);
    this.authCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      scope,
      resource,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
  }

  async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readForm(req);
    const grantType = requireParam(body, "grant_type");

    if (grantType === "refresh_token") {
      return this.refreshAccessToken(res, requireParam(body, "refresh_token"));
    }

    if (grantType !== "authorization_code") {
      return json(res, 400, { error: "unsupported_grant_type" });
    }

    const code = requireParam(body, "code");
    const codeVerifier = requireParam(body, "code_verifier");
    const redirectUri = requireParam(body, "redirect_uri");
    const clientId = requireParam(body, "client_id");
    const authCode = this.authCodes.get(code);

    if (!authCode || authCode.expiresAt <= Date.now()) {
      return json(res, 400, { error: "invalid_grant" });
    }

    if (authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
      return json(res, 400, { error: "invalid_grant" });
    }

    if (pkceChallenge(codeVerifier) !== authCode.codeChallenge) {
      return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    }

    this.authCodes.delete(code);
    return this.issueTokenPair(res, authCode.clientId, authCode.scope, authCode.resource);
  }

  verifyAccessToken(token: string, resource: string): boolean {
    const stored = this.accessTokens.get(token);
    if (!stored || stored.expiresAt <= Date.now()) return false;
    return stored.resource === resource || stored.resource === `${resource}/mcp`;
  }

  challenge(baseUrl: string): string {
    return `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="${DEPLOY_SCOPE}"`;
  }

  private refreshAccessToken(res: ServerResponse, token: string): void {
    const stored = this.refreshTokens.get(token);
    if (!stored || stored.expiresAt <= Date.now()) {
      return json(res, 400, { error: "invalid_grant" });
    }
    return this.issueTokenPair(res, stored.clientId, stored.scope, stored.resource);
  }

  private issueTokenPair(res: ServerResponse, clientId: string, scope: string, resource: string): void {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const now = Date.now();

    this.accessTokens.set(accessToken, {
      clientId,
      scope,
      resource,
      expiresAt: now + this.config.oauthAccessTokenTtlSeconds * 1000
    });

    this.refreshTokens.set(refreshToken, {
      clientId,
      scope,
      resource,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000
    });

    return json(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.oauthAccessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope
    });
  }

  private renderAuthorizeForm(res: ServerResponse, params: Record<string, string | undefined>, error?: string): void {
    const fields = [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "resource"
    ];

    const hiddenInputs = fields
      .map((field) => `<input type="hidden" name="${field}" value="${escapeHtml(params[field] ?? "")}">`)
      .join("\n");

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize CMP MCP Server</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 20px; color: #111827; }
    label { display: block; margin: 18px 0 8px; font-weight: 600; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #9ca3af; border-radius: 6px; }
    button { margin-top: 20px; padding: 10px 14px; border: 0; border-radius: 6px; background: #111827; color: white; cursor: pointer; }
    .error { color: #b91c1c; font-weight: 600; }
    .scope { color: #374151; font-size: 14px; }
  </style>
</head>
<body>
  <h1>Authorize CMP MCP Server</h1>
  <p class="scope">This grants ChatGPT permission to call the EKS deployment tool.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/oauth/authorize">
    ${hiddenInputs}
    <label for="password">OAuth login password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private isRedirectAllowed(clientId: string, redirectUri: string): boolean {
    const client = this.clients.get(clientId);
    if (client) return client.redirectUris.includes(redirectUri);

    try {
      const parsed = new URL(redirectUri);
      return parsed.origin === "https://chatgpt.com" && (
        parsed.pathname.startsWith("/connector/oauth/") ||
        parsed.pathname === "/connector_platform_oauth_redirect"
      );
    } catch {
      return false;
    }
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  if (req.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  return JSON.parse(raw);
}

async function readForm(req: IncomingMessage): Promise<Record<string, string | undefined>> {
  const body = await readBody(req);
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, stringValue(value)]));
}

function requireParam(body: Record<string, unknown>, key: string): string {
  const value = stringValue(body[key]);
  if (!value) throw new Error(`Missing OAuth parameter: ${key}`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
