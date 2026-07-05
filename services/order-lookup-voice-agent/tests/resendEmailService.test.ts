import { describe, expect, it } from "vitest";
import { isValidCustomerEmail } from "../src/utils/resendEmailService.js";

describe("isValidCustomerEmail", () => {
  it("accepts Gmail addresses", () => {
    expect(isValidCustomerEmail("user@gmail.com")).toBe(true);
  });

  it("accepts non-Gmail corporate domains", () => {
    expect(isValidCustomerEmail("bashi.sultan@outlook.com")).toBe(true);
    expect(isValidCustomerEmail("orders@sureshotbooks.com")).toBe(true);
    expect(isValidCustomerEmail("inmate.mail@doc.state.tx.us")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidCustomerEmail("not-an-email")).toBe(false);
    expect(isValidCustomerEmail("@missing-local.com")).toBe(false);
    expect(isValidCustomerEmail("")).toBe(false);
  });
});
