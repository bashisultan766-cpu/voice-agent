import { describe, expect, it } from "vitest";
import {
  buildCheckoutEmailHtml,
  isValidCustomerEmail,
} from "../src/utils/resendEmailService.js";

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

describe("buildCheckoutEmailHtml", () => {
  const cart = [
    {
      variantId: "custom:bulk book",
      productId: "",
      title: "Bulk Book",
      quantity: 50,
      unitPrice: "10.00",
    },
    {
      variantId: "gid://shopify/ProductVariant/123",
      productId: "gid://shopify/Product/1",
      title: "Single Title",
      quantity: 1,
      unitPrice: "9.99",
    },
  ];

  it("renders invoice table, subtotal, shipping note, and CTA button", () => {
    const html = buildCheckoutEmailHtml(
      "Jane Doe",
      "https://checkout.shopify.com/invoice/abc",
      cart,
    );

    expect(html).toContain("Your Sureshot Books Order");
    expect(html).toContain("Bulk Book");
    expect(html).toContain("$10.00");
    expect(html).toContain("$500.00");
    expect(html).toContain("$509.99");
    expect(html).toContain("Shipping fees and taxes will be calculated at checkout.");
    expect(html).toContain('href="https://checkout.shopify.com/invoice/abc"');
    expect(html).toContain("Complete Secure Checkout");
    expect(html).toContain("background-color:#2563eb");
    expect(html).toContain("facility and inmate information");
  });

  it("escapes HTML in product titles and customer names", () => {
    const html = buildCheckoutEmailHtml(
      '<script>alert("xss")</script>',
      "https://checkout.shopify.com/invoice/abc",
      [
        {
          variantId: "custom:test",
          productId: "",
          title: 'Book & "Quotes"',
          quantity: 1,
          unitPrice: "5.00",
        },
      ],
    );

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("Book &amp; &quot;Quotes&quot;");
  });
});