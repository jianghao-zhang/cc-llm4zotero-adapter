import { describe, expect, it } from "vitest";

import {
  normalizeProviderModelName,
  resolveModelAlias,
  resolveModelWithCache,
} from "../src/providers/model-resolver.js";

describe("model resolver", () => {
  it("preserves opaque model values and strips only real ANSI escapes", () => {
    expect(normalizeProviderModelName("glm-5.1[1m]")).toBe("glm-5.1[1m]");
    expect(normalizeProviderModelName("FutureModel[128k]")).toBe(
      "FutureModel[128k]",
    );
    expect(normalizeProviderModelName("\u001b[31mOpus[1m]\u001b[0m")).toBe(
      "Opus[1m]",
    );
  });

  it("returns the exact SDK value only for an exact catalog match", () => {
    expect(resolveModelAlias("Opus[1m]", [{ value: "Opus[1m]" }])).toBe(
      "Opus[1m]",
    );
    expect(resolveModelAlias("opus[1m]", [{ value: "Opus[1m]" }])).toBe(
      "opus[1m]",
    );
  });

  it("never replaces a missing issue #335 alias with the first model", () => {
    const issueCatalog = [
      { value: "default" },
      { value: "sonnet" },
      { value: "haiku" },
      { value: "claude-fable-5[1m]" },
    ];
    expect(resolveModelAlias("opus", issueCatalog)).toBe("opus");
  });

  it("passes unknown future model families through unchanged", () => {
    expect(
      resolveModelAlias("claude-mythos-6[2m]", [{ value: "default" }]),
    ).toBe("claude-mythos-6[2m]");
    expect(
      resolveModelWithCache(
        "FutureProvider/Model-X[1m]",
        ["local"],
        "uncached-future-provider",
      ),
    ).toEqual({
      model: "FutureProvider/Model-X[1m]",
      cacheHit: false,
    });
  });
});
