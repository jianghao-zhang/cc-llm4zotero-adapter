import { describe, expect, it } from "vitest";

import {
  normalizeProviderModelName,
  resolveModelAlias,
  resolveModelWithCache,
} from "../src/providers/model-resolver.js";

describe("model resolver", () => {
  it("strips proxy display context suffixes from non-Claude short aliases", () => {
    expect(normalizeProviderModelName("glm-5.1[1m]")).toBe("glm-5.1");
    expect(normalizeProviderModelName("glm-5.1[128k]")).toBe("glm-5.1");
  });

  it("preserves Claude short alias context variants as SDK model ids", () => {
    expect(normalizeProviderModelName("opus[1m]")).toBe("opus[1m]");
    expect(normalizeProviderModelName("sonnet[1m]")).toBe("sonnet[1m]");
    expect(resolveModelAlias("sonnet[1m]", [{ value: "sonnet" }])).toBe(
      "sonnet[1m]",
    );
    expect(resolveModelWithCache("sonnet[1m]", ["user", "project"])).toEqual({
      model: "sonnet[1m]",
      cacheHit: true,
    });
  });

  it("does not pass supportedModels display suffixes as SDK model ids", () => {
    expect(resolveModelAlias("opus", [{ value: "glm-5.1[1m]" }])).toBe(
      "glm-5.1",
    );
  });
});
