import { describe, it, expect } from "vitest";
import { TAG_PREFIX, TAG_FLAGS, tag } from "../../src/tags";

describe("tags", () => {
  it("has standard tag prefixes", () => {
    expect(TAG_PREFIX.CAPABILITY).toBe("capability");
    expect(TAG_PREFIX.PRIORITY).toBe("priority");
    expect(TAG_PREFIX.ROLE).toBe("role");
    expect(TAG_PREFIX.SEVERITY).toBe("severity");
    expect(TAG_PREFIX.URGENCY).toBe("urgency");
    expect(TAG_PREFIX.TENANT).toBe("tenant");
  });

  it("has boolean flags", () => {
    expect(TAG_FLAGS.REQUIRES_HUMAN).toBe("requires_human");
    expect(TAG_FLAGS.REQUIRES_AUDIT).toBe("requires_audit");
  });

  it("creates prefixed tags", () => {
    expect(tag("capability", "contract-drafting")).toBe(
      "capability:contract-drafting",
    );
    expect(tag("priority", "high")).toBe("priority:high");
  });
});
