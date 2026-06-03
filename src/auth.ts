import { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import type { OAuthService } from "./oauth.js";

export function isAuthorized(req: IncomingMessage, config: Config, oauthService: OAuthService, resource: string): boolean {
  const auth = req.headers.authorization;
  const headerSecret = req.headers["x-mcp-shared-secret"];

  if (auth === `Bearer ${config.mcpSharedSecret}`) return true;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return oauthService.verifyAccessToken(auth.slice("Bearer ".length), resource);
  }
  if (Array.isArray(headerSecret)) return headerSecret.includes(config.mcpSharedSecret);
  return headerSecret === config.mcpSharedSecret;
}
