import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { isAuthorized } from "../src/auth.js";

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("isAuthorized", () => {
  it("accepts bearer token", () => {
    expect(isAuthorized(req({ authorization: "Bearer secret" }), "secret")).toBe(true);
  });

  it("accepts shared-secret header", () => {
    expect(isAuthorized(req({ "x-mcp-shared-secret": "secret" }), "secret")).toBe(true);
  });

  it("rejects missing or incorrect secret", () => {
    expect(isAuthorized(req({ authorization: "Bearer wrong" }), "secret")).toBe(false);
    expect(isAuthorized(req({}), "secret")).toBe(false);
  });
});
