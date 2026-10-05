
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 100 }, // warm-up
    { duration: "2m", target: 500 }, // half load
    { duration: "2m", target: 1000 }, // full load
    { duration: "1m", target: 1000 }, // hold 1000 concurrent
    { duration: "1m", target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
    "http_req_duration{endpoint:search}": ["p(95)<1500"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:5000";

function tomorrowStr() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function () {
  const date = tomorrowStr();

  const search = http.get(
    `${BASE}/api/availability/search?date=${date}&durationHours=3&suggest=1`,
    { tags: { endpoint: "search" } }
  );
  check(search, {
    "search 200": (r) => r.status === 200,
    "search has cooks": (r) => {
      try {
        return Array.isArray(r.json().cooks);
      } catch {
        return false;
      }
    },
  });

  const cooks = http.get(
    `${BASE}/api/cooks?date=${date}&durationHours=3&page=1&limit=20`,
    { tags: { endpoint: "cooks" } }
  );
  check(cooks, { "cooks 200": (r) => r.status === 200 });

  const health = http.get(`${BASE}/api/health`, { tags: { endpoint: "health" } });
  check(health, { "health 200": (r) => r.status === 200 });

  const coupons = http.get(`${BASE}/api/coupons/active`, {
    tags: { endpoint: "coupons" },
  });
  check(coupons, { "coupons 2xx": (r) => r.status >= 200 && r.status < 300 });

  sleep(2 + Math.random() * 4);
}
