// Venue/pin pairing: coordinates ride on a booking ONLY when bound to the
// exact current address snapshot. Any venue edit (or a fresh, unaccepted
// GPS fix) breaks the binding and the pin is omitted — a typed address
// still books fine without a pin. This is what makes stale pins, silent
// GPS reuse, and IP-as-pin structurally impossible at submit time.

export const VENUE_FIELDS = ["flatNo", "society", "landmark", "city"];

const normField = (v) => String(v || "").trim().toLowerCase();

// Fingerprint binding address text to coordinates. Null when there is no
// usable pin (missing/non-finite coordinates) — never a partial pair.
export const pinFingerprint = (fields, coords) => {
  if (!coords || !Number.isFinite(coords?.lat) || !Number.isFinite(coords?.lng)) return null;
  const addr = VENUE_FIELDS.map((k) => normField(fields?.[k])).join("|");
  return `${addr}@${coords.lat},${coords.lng}`;
};

export const pinMatches = (fp, fields, coords) =>
  fp != null && fp === pinFingerprint(fields, coords);

const cleanDetails = (fields) => ({
  flatNo: String(fields?.flatNo || "").trim(),
  society: String(fields?.society || "").trim(),
  landmark: String(fields?.landmark || "").trim(),
  city: String(fields?.city || "").trim(),
});

// Builds the location slice of a booking payload from the CURRENT form
// state. Returns addressDetails always, and location only for a bound pin.
export const buildBookingLocation = ({ fields, coords, pinFP }) => {
  const addressDetails = cleanDetails(fields);
  if (pinMatches(pinFP, fields, coords)) {
    return { addressDetails, location: { lat: coords.lat, lng: coords.lng } };
  }
  return { addressDetails, location: undefined };
};

// Fingerprint for a just-restored draft (old drafts predate fingerprints):
// recompute from the restored pair so a consistent restore keeps its pin
// while a mismatched one safely drops it.
export const fingerprintForRestore = (fields, coords) => pinFingerprint(fields, coords);
