import { describe, expect, it } from "vitest";
import {
  filterPhysicalLineItems,
  isPhysicalBookLineItem,
  physicalItemCount,
} from "../src/utils/productLineItems.js";

describe("productLineItems", () => {
  it("excludes processing fee, shipping, and handling from physical counts", () => {
    const items = [
      { title: "The Holy Bible", quantity: 1 },
      { title: "Processing Fee", quantity: 1 },
      { title: "Shipping", quantity: 1 },
      { title: "Handling", quantity: 1 },
    ];

    expect(isPhysicalBookLineItem("Processing Fee")).toBe(false);
    expect(isPhysicalBookLineItem("The Holy Bible")).toBe(true);
    expect(filterPhysicalLineItems(items)).toEqual([
      { title: "The Holy Bible", quantity: 1 },
    ]);
    expect(physicalItemCount(items)).toBe(1);
  });
});
