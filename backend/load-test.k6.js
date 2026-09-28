// 1000-user load test (k6) — proves what the stack actually handles.
//
// Run:  npx k6 run backend/load-test.k6.js
//        (or: k6 run backend/load-test.k6.js with k6 installed)
// Env:   BASE_URL=http://localhost:5000  (default; point at staging/prod to
//        test the real deployment — NEVER at production during peak hours)
//
// What it does: ramps 0 → 1000 virtual users over ~6 minutes, holding the
// browsing mix the frontend actually generates — cooks list + batched slot
// search (the heaviest read path), health, public coupons — then ramps down.
// Pass criteria: error rate < 1%, search p95 < 1.5s.
//
// While it runs, watch: event-loop lag / CPU per instance, MongoDB pool
// wait queues + slow-query log, and 429 rate (means limits, not capacity).

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

  // 1. Heaviest read: batched slot search (what CookBooking step 1 fires).
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

  // 2. Cook discovery (paged, like browsing with filters).
  const cooks = http.get(
    `${BASE}/api/cooks?date=${date}&durationHours=3&page=1&limit=20`,
    { tags: { endpoint: "cooks" } }
  );
  check(cooks, { "cooks 200": (r) => r.status === 200 });

  // 3. Light reads in the real browsing mix.
  const health = http.get(`${BASE}/api/health`, { tags: { endpoint: "health" } });
  check(health, { "health 200": (r) => r.status === 200 });

  const coupons = http.get(`${BASE}/api/coupons/active`, {
    tags: { endpoint: "coupons" },
  });
  check(coupons, { "coupons 2xx": (r) => r.status >= 200 && r.status < 300 });

  // Think time between actions: keeps the VU count at 1000 concurrent users
  // without turning every VU into a tight request loop (which would model
  // 1000 bots, not 1000 humans).
  sleep(2 + Math.random() * 4);
}
