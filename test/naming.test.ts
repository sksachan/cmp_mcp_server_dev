import { describe, expect, it } from "vitest";
import { deriveStackName, sanitizeName } from "../src/naming.js";

describe("naming", () => {
  it("derives deterministic stack names", () => {
    expect(deriveStackName("hello-world-v2", "dev")).toBe("hello-world-v2-dev-eks");
    expect(sanitizeName(" Hello_World V2!! ")).toBe("hello-world-v2");
  });
});
