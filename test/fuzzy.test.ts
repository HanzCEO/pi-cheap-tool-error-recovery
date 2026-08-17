import { describe, it, expect } from "vitest";
import { fuzzyScore } from "../src/picker";

describe("fuzzyScore", () => {
  it("returns 0 for an empty query (matches everything)", () => {
    expect(fuzzyScore("", "anthropic/claude-sonnet-4")).toBe(0);
  });

  it("scores an exact match best (0)", () => {
    expect(fuzzyScore("claude", "claude")).toBe(0);
  });

  it("scores a prefix match as 1", () => {
    expect(fuzzyScore("cla", "claude-sonnet-4")).toBe(1);
  });

  it("scores a contiguous substring as position + 2", () => {
    // "son" first appears at index 7 in "claude-sonnet-4"
    expect(fuzzyScore("son", "claude-sonnet-4")).toBe(7 + 2);
  });

  it("matches non-contiguously and returns a score above substring tier", () => {
    // "cld" appears as c, l, d spread across "claude" -> fuzzy, not a substring
    const score = fuzzyScore("cld", "claude-sonnet-4");
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(10);
  });

  it("returns null when not all query chars appear in order", () => {
    expect(fuzzyScore("xyz", "claude-sonnet-4")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("CLAUDE", "claude")).toBe(0); // exact, case-folded
    expect(fuzzyScore("CLAUDE", "claude-sonnet-4")).toBe(1); // prefix, case-folded
    expect(fuzzyScore("SON", "claude-sonnet-4")).toBe(7 + 2);
  });

  it("ranks a closer match lower (better) than a fuzzier one", () => {
    const prefix = fuzzyScore("son", "claude-sonnet-4")!;
    const fuzzy = fuzzyScore("cld", "claude-sonnet-4")!;
    expect(prefix).toBeLessThan(fuzzy);
  });
});
