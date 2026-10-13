
if (!process.env.TZ) process.env.TZ = "Asia/Kolkata";
const cluster = require("node:cluster");
const os = require("node:os");

const WORKERS = Number(process.env.WORKERS || os.cpus().length);

if (cluster.isPrimary) {
  console.log(`Cluster master ${process.pid} starting ${WORKERS} worker(s)...`);
  for (let i = 0; i < WORKERS; i += 1) cluster.fork();

  cluster.on("exit", (worker, code, signal) => {
    console.warn(
      `Worker ${worker.process.pid} died (code=${code}, signal=${signal}) — reforking...`
    );
    cluster.fork();
  });

  const shutdown = (sig) => {
    console.log(`Master received ${sig} — stopping workers...`);
    for (const id of Object.keys(cluster.workers || {})) {
      cluster.workers[id]?.kill(sig);
    }
    setTimeout(() => process.exit(0), 6000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} else {
  require("./server");
}
