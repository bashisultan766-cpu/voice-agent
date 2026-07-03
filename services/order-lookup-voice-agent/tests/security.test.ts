import { describe, expect, it } from "vitest";
import { sanitizeForSpeech } from "../src/utils/security.js";

describe("sanitizeForSpeech", () => {
  it("redacts credit-card-length digit runs but preserves ISBN-13", () => {
    expect(sanitizeForSpeech("card 4111111111111111")).toBe("card [card redacted]");
    expect(sanitizeForSpeech("ISBN 9783161484100")).toBe("ISBN 9783161484100");
    expect(sanitizeForSpeech("The ISBN number is 9783161484100.")).toBe(
      "The ISBN number is 9783161484100.",
    );
  });

  it("preserves spaced ISBN-13", () => {
    expect(sanitizeForSpeech("978 316 1484100")).toBe("978 316 1484100");
  });
});
