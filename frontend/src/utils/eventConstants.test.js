import {
  eventTravelSlabHint,
  formatCurrency,
  previewEventPrice,
  sanitizeDecimalInput,
} from "./eventConstants";

describe("event booking distance input", () => {
  test("keeps valid decimal distances instead of turning 7.5 into 75", () => {
    expect(sanitizeDecimalInput("7.5")).toBe("7.5");
    expect(sanitizeDecimalInput("7.25")).toBe("7.25");
    expect(sanitizeDecimalInput("7.259")).toBe("7.25");
    expect(sanitizeDecimalInput("7.")).toBe("7.");
    expect(sanitizeDecimalInput(".5")).toBe("0.5");
  });

  test("strips junk, extra dots, leading zeros and empty input", () => {
    expect(sanitizeDecimalInput("7..5")).toBe("7.5");
    expect(sanitizeDecimalInput(" 007.50 ")).toBe("7.50");
    expect(sanitizeDecimalInput("abc")).toBe("");
    expect(sanitizeDecimalInput("")).toBe("");
  });

  test("preview prices 7.5 km using the correct travel slab", () => {
    const quote = previewEventPrice(null, {
      serviceType: "preparation_cooking",
      duration: 4,
      distanceKm: Number("7.5"),
    });
    expect(quote.travelCharge).toBe(100);
  });
});

describe("event travel slab copy", () => {
  test("is derived from the configured slabs", () => {
    const hint = eventTravelSlabHint([
      { maxKm: 3, charge: 0 },
      { maxKm: 999999999, charge: 450 },
    ]);
    expect(hint).toContain("0-3 km FREE");
    expect(hint).toContain(`3+ km ${formatCurrency(450)}`);
  });

  test("falls back to launch slabs when pricing is unavailable", () => {
    expect(eventTravelSlabHint(null)).toContain("20+ km");
  });
});
