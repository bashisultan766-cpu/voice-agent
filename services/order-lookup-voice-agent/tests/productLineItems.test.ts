import { describe, expect, it } from "vitest";
import {
  filterPhysicalLineItems,
  filterFeeLineItems,
  isFeeLineItem,
  isPhysicalBookLineItem,
  physicalItemCount,
  splitLineItems,
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
    expect(isFeeLineItem("Processing Fee")).toBe(true);
    expect(isPhysicalBookLineItem("The Holy Bible")).toBe(true);
    expect(filterPhysicalLineItems(items)).toEqual([
      { title: "The Holy Bible", quantity: 1 },
    ]);
    expect(filterFeeLineItems(items)).toEqual([
      { title: "Processing Fee", quantity: 1 },
      { title: "Shipping", quantity: 1 },
      { title: "Handling", quantity: 1 },
    ]);
    expect(physicalItemCount(items)).toBe(1);
  });

  it("splits physical and fee line items for LLM payloads", () => {
    const items = [
      { title: "Dad to Son", quantity: 2 },
      { title: "Standard Processing Fee", quantity: 1 },
    ];
    const split = splitLineItems(items);
    expect(split.physicalItems).toEqual([{ title: "Dad to Son", quantity: 2 }]);
    expect(split.feeItems).toEqual([{ title: "Standard Processing Fee", quantity: 1 }]);
    expect(physicalItemCount(items)).toBe(2);
  });
});
