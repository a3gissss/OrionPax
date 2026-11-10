import { describe, expect, it, vi } from "vitest";
import { takeTokenFromLocation } from "../src/lib/api";

const loc = (hash: string) => ({ hash, pathname: "/", search: "?x=1" });

describe("takeTokenFromLocation", () => {
  it("returns the token and rewrites the URL without it", () => {
    const replaceState = vi.fn();
    const t = "9ba3f34f56c74ad9626f1dc4d07127254966e43d33371552570802a12849c652";
    expect(takeTokenFromLocation(loc(`#token=${t}`), { replaceState })).toBe(t);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?x=1");
  });

  it("keeps other hash params", () => {
    const replaceState = vi.fn();
    expect(takeTokenFromLocation(loc("#job=abc&token=abcdefghijklmnop1234"), { replaceState })).toBe("abcdefghijklmnop1234");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?x=1#job=abc");
  });

  it("ignores links without a token, and rejects malformed tokens (still stripping them)", () => {
    const replaceState = vi.fn();
    expect(takeTokenFromLocation(loc(""), { replaceState })).toBeNull();
    expect(takeTokenFromLocation(loc("#job=abc"), { replaceState })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    expect(takeTokenFromLocation(loc("#token=<script>"), { replaceState })).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?x=1");
  });
});
