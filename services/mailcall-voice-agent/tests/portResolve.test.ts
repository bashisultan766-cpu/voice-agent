import { describe, expect, it, beforeEach } from "vitest";
import { resolveListenPort, resetConfigCache, DEFAULT_MAILCALL_PORT } from "../src/config.js";

describe("resolveListenPort", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("defaults to 8010 when unset", () => {
    expect(resolveListenPort({})).toBe(DEFAULT_MAILCALL_PORT);
  });

  it("reads MAILCALL_PORT", () => {
    expect(resolveListenPort({ MAILCALL_PORT: "8010" })).toBe(8010);
  });

  it("falls back to PORT", () => {
    expect(resolveListenPort({ PORT: "8010" })).toBe(8010);
  });

  it("rejects invalid values and uses 8010", () => {
    expect(resolveListenPort({ MAILCALL_PORT: "" })).toBe(8010);
    expect(resolveListenPort({ MAILCALL_PORT: "abc" })).toBe(8010);
    expect(resolveListenPort({ MAILCALL_PORT: "0" })).toBe(8010);
  });
});
