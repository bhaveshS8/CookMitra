// Shared list pagination for read-heavy endpoints.
//
// Opt-in via ?page= / ?limit= so existing callers — and unit-test query fakes
// that only implement select/populate/sort — keep working untouched. Without
// params the full array is returned (with a 500-doc backstop against absurd
// responses). With params the query is bounded in Mongo and the response
// carries { data, pagination } plus X-Total-* headers.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const HARD_CAP = 500;

const paginationParams = (req) => {
  const q = (req && req.query) || {};
  const has = q.page != null || q.limit != null;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(q.limit, 10) || DEFAULT_LIMIT)
  );
  return { has, page, limit, skip: (page - 1) * limit };
};

// Chain skip/limit ONLY when the client asked for paging (keeps stubbed query
// fakes working in tests).
const applyPagination = (query, pg) =>
  pg.has ? query.skip(pg.skip).limit(pg.limit) : query;

const sendList = async (res, rows, pg, countFnOrTotal) => {
  // Paged callers pass the (thenable) Mongoose query from applyPagination —
  // resolve it here. Without this await every ?page=/ ?limit= request answered
  // { data: [] } while the unpaged path worked, a silent data-loss bug.
  let list = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(rows) && rows && typeof rows.then === "function") {
    try {
      const resolved = await rows;
      list = Array.isArray(resolved) ? resolved : [];
    } catch {
      list = [];
    }
  }
  if (!pg.has) {
    return res.json(list.length > HARD_CAP ? list.slice(0, HARD_CAP) : list);
  }
  let total = list.length;
  try {
    if (typeof countFnOrTotal === "function") total = await countFnOrTotal();
    else if (typeof countFnOrTotal === "number") total = countFnOrTotal;
  } catch {
    // non-fatal: fall back to page size
  }
  const totalPages = Math.max(1, Math.ceil(total / pg.limit));
  try {
    res.set("X-Total-Count", String(total));
    res.set("X-Total-Pages", String(totalPages));
    res.set("X-Page", String(pg.page));
    res.set("X-Per-Page", String(pg.limit));
  } catch {
    // non-fatal: test doubles may not implement res.set
  }
  return res.json({
    data: list,
    pagination: { page: pg.page, limit: pg.limit, total, totalPages },
  });
};

module.exports = {
  paginationParams,
  applyPagination,
  sendList,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  HARD_CAP,
};
