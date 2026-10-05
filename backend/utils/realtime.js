const jwt = require("jsonwebtoken");
const User = require("../models/User");

const clients = new Set();

const sseHandler = async (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ message: "Authentication token required for real-time stream" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }

  const userId = String(decoded.id || decoded._id || "");
  const role = String(decoded.role || "").toUpperCase();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const clientId = `${userId}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const clientObj = { id: clientId, res, userId, role };
  clients.add(clientObj);

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(clientObj);
  });
};

const emit = (eventType, data = {}, options = {}) => {
  const { targetUserIds, targetRoles } = options;
  const targetUserSet = targetUserIds ? new Set(targetUserIds.map((id) => String(id))) : null;
  const targetRoleSet = targetRoles ? new Set(targetRoles.map((r) => String(r).toUpperCase())) : null;

  const payload = `event: ${eventType}\ndata: ${JSON.stringify({ ...data, timestamp: Date.now() })}\n\n`;

  for (const client of clients) {
    const matchUser = targetUserSet ? targetUserSet.has(client.userId) : true;
    const matchRole = targetRoleSet ? targetRoleSet.has(client.role) : true;

    if (matchUser && matchRole) {
      try {
        client.res.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }
};

module.exports = {
  sseHandler,
  emit,
  clients,
};
