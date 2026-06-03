import { IncomingMessage } from "node:http";

export function isAuthorized(req: IncomingMessage, sharedSecret: string): boolean {
  const auth = req.headers.authorization;
  const headerSecret = req.headers["x-mcp-shared-secret"];

  if (auth === `Bearer ${sharedSecret}`) return true;
  if (Array.isArray(headerSecret)) return headerSecret.includes(sharedSecret);
  return headerSecret === sharedSecret;
}
