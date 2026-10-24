// Regression for EVT-AUD-008: the optional IP-location bootstrap must cache
// both successes and failures so a rate-limited provider is not retried on
// every mount. The flow must remain non-blocking (null on any failure).
import {
  fetchIpLocation,
  resetIpLocationCache,
  IP_FAILURE_TTL_MS,
  IP_SUCCESS_TTL_MS,
} from "./geolocation";

const originalFetch = global.fetch;

const response = (body, ok = true) => ({
  ok,
  json: () => Promise.resolve(body),
});

describe("fetchIpLocation caching (EVT-AUD-008)", () => {
  beforeEach(() => {
    resetIpLocationCache();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test("successful lookup is cached and reused", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({ success: true, city: "Pune", region: "Maharashtra" })
    );
    const first = await fetchIpLocation();
    const second = await fetchIpLocation();
    expect(first).toMatchObject({ city: "Pune", state: "Maharashtra" });
    expect(second).toEqual(first);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(IP_SUCCESS_TTL_MS).toBeGreaterThan(IP_FAILURE_TTL_MS);
  });

  test("provider failures are cached for the short cooldown", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({}, false))
      .mockResolvedValueOnce(response({}, false));
    const first = await fetchIpLocation();
    expect(first).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const second = await fetchIpLocation();
    expect(second).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("a thrown provider error is swallowed and cached", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const first = await fetchIpLocation();
    expect(first).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await fetchIpLocation();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("reset clears the cache for a fresh attempt", async () => {
    global.fetch = jest.fn().mockResolvedValue(response({}, false));
    await fetchIpLocation();
    resetIpLocationCache();
    await fetchIpLocation();
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});
