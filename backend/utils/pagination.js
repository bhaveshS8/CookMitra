
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

const applyPagination = (query, pg) =>
  pg.has ? query.skip(pg.skip).limit(pg.limit) : query;

const sendList = async (res, rows, pg, countFnOrTotal) => {
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
  }
  const totalPages = Math.max(1, Math.ceil(total / pg.limit));
  try {
    res.set("X-Total-Count", String(total));
    res.set("X-Total-Pages", String(totalPages));
    res.set("X-Page", String(pg.page));
    res.set("X-Per-Page", String(pg.limit));
  } catch {
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
