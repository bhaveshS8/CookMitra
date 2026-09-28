const errorHandler = (err, req, res, next) => {
  // Invalid MongoDB ObjectId in URL params -> 404, not 500
  // Expected client error: skip stack logging to keep logs clean
  if (err.name === "CastError") {
    return res.status(404).json({ message: "Resource not found" });
  }

  // Client-caused schema failures (bad enum, missing required, etc.) are
  // 400s, not 500s.
  if (err.name === "ValidationError") {
    return res.status(400).json({ message: err.message || "Validation failed" });
  }

  console.error(err.stack);

  const statusCode = err.statusCode || 500;
  // Never reflect internal failure detail (Mongo errors, stack fragments,
  // driver messages) to clients in production — log it, send a generic note.
  const message =
    statusCode >= 500 && process.env.NODE_ENV === "production"
      ? "Something went wrong. Please try again later."
      : err.message || "Internal Server Error";
  res.status(statusCode).json({
    message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = errorHandler;
