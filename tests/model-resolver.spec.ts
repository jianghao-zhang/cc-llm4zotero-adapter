import { describe, expect, it } from "vitest";

import {
  normalizeProviderModelName,
  resolveModelAlias,
} from "../src/providers/model-resolver.js";

describe("model resolver", () => {
  it("strips Claude Code context suffixes from provider model ids", () => {
    expect(normalizeProviderModelName("glm-5.1[1m]")).toBe("glm-5.1");
    expect(normalizeProviderModelName("glm-5.1[128k]")).toBe("glm-5.1");
  });

  it("does not pass supportedModels display suffixes as SDK model ids", () => {
    expect(resolveModelAlias("opus", [{ value: "glm-5.1[1m]" }])).toBe(
      "glm-5.1",
    );
  });
});
