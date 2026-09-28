const mongoose = require("mongoose");

// How long to wait between connection attempts. A transient MongoDB outage
// (service restarting, laptop sleep/wake dropping the socket) must never
// take the API down with it, so we retry forever instead of process.exit().
const RETRY_MS = Number(process.env.MONGO_RETRY_MS || 5000);

// Atlas SRV clusters can be slow on first selection (DNS + TLS handshake),
// so allow a generous server-selection window. Overridable via env.
const SERVER_SELECTION_TIMEOUT_MS = Number(
  process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 30000
);

// Mask credentials before logging: mongodb+srv://user:****@cluster.../db?...
const maskUri = (uri) => {
  if (!uri) return "<missing>";
  try {
    return String(uri).replace(/\/\/([^:/?#]+:)([^@/?#]*)@/g, "//$1****@");
  } catch {
    return "<unparseable>";
  }
};

// Short human-readable target for logs, e.g. "Atlas cluster
// festivecook.xxxxx.mongodb.net / db festivecook". Never includes secrets.
const describeUri = (uri) => {
  const s = String(uri || "");
  if (s.startsWith("mongodb+srv://")) {
    const m = s.match(/^mongodb\+srv:\/\/[^@]+@([^/?#]+)(?:\/([^?#]*))?/);
    const host = m?.[1] || "atlas cluster";
    const db = m?.[2] || mongoose.connection?.name || "<default>";
    return `MongoDB Atlas (${host} / db "${db}")`;
  }
  const m = s.match(/^mongodb:\/\/(?:[^@]+@)?([^/?#]+)(?:\/([^?#]*))?/);
  if (m) return `MongoDB (${m[1]} / db "${m[2] || "<default>"}")`;
  return "MongoDB (custom URI)";
};

const bindConnectionEvents = () => {
  // Without an 'error' listener, a mid-run connection failure is emitted as
  // an 'error' event with no handler — which throws and kills the process.
  // Logging it here keeps the server alive while the driver reconnects.
  mongoose.connection.on("error", (err) => {
    console.error(`MongoDB connection error (retrying in background): ${err.message}`);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected — retrying in background...");
  });
  mongoose.connection.on("reconnected", () => {
    console.log("MongoDB reconnected");
  });
};

const connectDB = async () => {
  bindConnectionEvents();
  const uri = (process.env.MONGODB_URI || "").trim();
  // Atlas SRV strings plus Atlas standard URIs (explicit *.mongodb.net
  // shard hosts — same cluster, no SRV DNS lookup needed).
  const isAtlas = uri.startsWith("mongodb+srv://") || uri.includes(".mongodb.net");

  if (!uri) {
    console.error(
      "MONGODB_URI is not set — the API will stay up but all DB calls will fail. " +
        "Set it to your Atlas SRV string " +
        "(mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<db>?retryWrites=true&w=majority) " +
        "and restart. Retrying in background..."
    );
  } else if (process.env.NODE_ENV === "production" && !isAtlas) {
    console.warn(
      "NODE_ENV=production but MONGODB_URI is not an Atlas (mongodb+srv://) URI. " +
        "Localhost MongoDB will not exist on most hosts — use your Atlas SRV string."
    );
  }

  if (isAtlas) {
    console.log(`Connecting to ${describeUri(uri)} ...`);
    console.log(
      "Atlas checklist if this fails: database user exists + correct password " +
        "(URL-encode @ : / ? # in it), IP allowlist includes your host (0.0.0.0/0 for hosted platforms), " +
        "and the connection string includes the database name."
    );
  }

  for (;;) {
    try {
      if (!uri) {
        throw new Error("MONGODB_URI is not set");
      }
      const conn = await mongoose.connect(uri, {
        // Works for both Atlas (SRV/TLS) and local mongod; the driver
        // ignores what doesn't apply.
        serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
        socketTimeoutMS: 45000,
        // Pool sizing: the driver queues queries once the pool is saturated, so
        // a 10-connection pool serialises a traffic spike (1000 concurrent
        // users) into long waits + serverSelection timeouts. 50 is a safe
        // default for a single API instance against Atlas M10+/free-tier limits;
        // raise it (e.g. 100) only if the Atlas cluster tier allows it.
        maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 50),
        // Keep one warm connection so the first request after an idle spell
        // doesn't pay the full TCP+TLS handshake.
        minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 1),
      });
      console.log(
        `MongoDB connected: ${conn.connection.host} / db "${conn.connection.name}"`
      );
      return conn;
    } catch (error) {
      const hint =
        isAtlas && /server selection|timed out|ENOTFOUND|bad auth|authentication/i.test(
          String(error?.message || "")
        )
          ? " (Atlas: check user/password, IP allowlist, and cluster state)"
          : "";
      console.error(
        `MongoDB connection failed (${maskUri(uri) || "<missing>"}): ${error.message}${hint} — retrying in ${RETRY_MS / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
};

module.exports = connectDB;
