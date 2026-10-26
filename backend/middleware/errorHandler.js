const errorHandler = (err, req, res, next) => {
  if (err.name === "CastError") {
    return res.status(404).json({ message: "Resource not found" });
  }

  // Optimistic-concurrency conflicts (Mongoose VersionError) from any
  // concurrent event/pricing update -> 409 so clients reload and retry.
  if (err.name === "VersionError") {
    return res.status(409).json({ message: "This record was just updated by someone else \u2014 please reload and retry." });
  }

  if (err.name === "ValidationError") {
    return res.status(400).json({ message: err.message || "Validation failed" });
  }

  try {
    console.error(`[${req?.id || "-"}]`, err.stack);
  } catch {
    console.error(err.stack);
  }

  const statusCode = err.statusCode || 500;
  const message =
    statusCode >= 500 && process.env.NODE_ENV === "production"
      ? "Something went wrong. Please try again later."
      : err.message || "Internal Server Error";
  res.status(statusCode).json({
    message,
    ...(err.code ? { code: err.code } : {}),
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = errorHandler;
