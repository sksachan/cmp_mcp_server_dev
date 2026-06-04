import { describe, expect, it } from "vitest";
import { redactSensitive, sanitizeBodhiRun } from "../src/sanitize.js";

describe("sanitization", () => {
  it("redacts sensitive nested keys", () => {
    expect(redactSensitive({
      access_token: "abc",
      nested: {
        password: "pw",
        safe: "ok"
      }
    })).toEqual({
      access_token: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        safe: "ok"
      }
    });
  });

  it("returns only safe Bodhi run summary fields", () => {
    expect(sanitizeBodhiRun({
      id: "run-1",
      status: "completed",
      access_token: "secret",
      allOutputs: { token: "secret" },
      exec_metadata: { secret: "secret" }
    })).toEqual({
      id: "run-1",
      status: "completed",
      startedAt: null,
      finishedAt: null,
      summary: null
    });
  });
});
