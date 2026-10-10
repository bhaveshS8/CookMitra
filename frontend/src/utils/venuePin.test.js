import {
  VENUE_FIELDS,
  pinFingerprint,
  pinMatches,
  buildBookingLocation,
  fingerprintForRestore,
} from "./venuePin";

describe("venuePin pairing", () => {
  const fields = { flatNo: "A-402", society: "Sunshine", landmark: "Near Mall", city: "Hadapsar" };
  const pin = { lat: 18.5, lng: 73.8 };

  test("fingerprint binds exact fields to coordinates", () => {
    const fp = pinFingerprint(fields, pin);
    expect(typeof fp).toBe("string");
    expect(pinMatches(fp, fields, pin)).toBe(true);
  });

  test("any venue edit breaks the binding", () => {
    const fp = pinFingerprint(fields, pin);
    for (const k of VENUE_FIELDS) {
      expect(pinMatches(fp, { ...fields, [k]: `${fields[k]} X` }, pin)).toBe(false);
    }
    // Unrelated changes do not affect pairing.
    expect(pinMatches(fp, { ...fields, guests: "99" }, pin)).toBe(true);
  });

  test("case/whitespace-insensitive, coordinate-exact", () => {
    const fp = pinFingerprint(fields, pin);
    expect(pinMatches(fp, { flatNo: "  a-402 ", society: "SUNSHINE", landmark: "near mall", city: "hadapsar" }, pin)).toBe(true);
    expect(pinMatches(fp, fields, { lat: 18.5001, lng: 73.8 })).toBe(false);
  });

  test("missing/non-finite coordinates never pair", () => {
    expect(pinFingerprint(fields, null)).toBeNull();
    expect(pinFingerprint(fields, { lat: NaN, lng: 73.8 })).toBeNull();
    expect(pinFingerprint(fields, { lat: 18.5 })).toBeNull();
    expect(pinMatches("anything", fields, null)).toBe(false);
    expect(pinMatches(null, fields, pin)).toBe(false);
  });

  test("buildBookingLocation attaches only bound pins", () => {
    const fp = pinFingerprint(fields, pin);
    const withPin = buildBookingLocation({ fields, coords: pin, pinFP: fp });
    expect(withPin.location).toEqual({ lat: 18.5, lng: 73.8 });
    expect(withPin.addressDetails).toEqual({ flatNo: "A-402", society: "Sunshine", landmark: "Near Mall", city: "Hadapsar" });
    const edited = buildBookingLocation({ fields: { ...fields, city: "Manjri" }, coords: pin, pinFP: fp });
    expect(edited.location).toBeUndefined();
    expect(edited.addressDetails.city).toBe("Manjri");
    const noPin = buildBookingLocation({ fields, coords: null, pinFP: null });
    expect(noPin.location).toBeUndefined();
  });

  test("restore fingerprint keeps consistent drafts, drops mismatches", () => {
    expect(fingerprintForRestore(fields, pin)).toBe(pinFingerprint(fields, pin));
    // Old drafts without coords restore to no pin.
    expect(fingerprintForRestore(fields, null)).toBeNull();
  });
});
