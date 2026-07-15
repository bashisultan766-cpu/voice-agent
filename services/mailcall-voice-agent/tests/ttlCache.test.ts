import { describe, expect, it, beforeEach } from "vitest";
import { TtlCache } from "../src/agents/mailcall/ttlCache.js";

describe("TtlCache", () => {
  let cache: TtlCache<string>;

  beforeEach(() => {
    cache = new TtlCache(50);
  });

  it("returns undefined on miss", () => {
    expect(cache.get("a")).toBeUndefined();
  });

  it("stores and retrieves within TTL", () => {
    cache.set("a", "hello");
    expect(cache.get("a")).toBe("hello");
  });

  it("expires after TTL", async () => {
    cache.set("a", "hello", 20);
    await new Promise((r) => setTimeout(r, 35));
    expect(cache.get("a")).toBeUndefined();
  });

  it("coalesces concurrent getOrLoad calls", async () => {
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 20));
      return "value";
    };

    const [a, b] = await Promise.all([
      cache.getOrLoad("k", loader),
      cache.getOrLoad("k", loader),
    ]);

    expect(a).toBe("value");
    expect(b).toBe("value");
    expect(loads).toBe(1);
  });
});
