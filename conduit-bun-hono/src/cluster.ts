// Multi-core launcher (Bun's documented pattern, bun.com/docs/guides/http/cluster): one server process per core,
// all listening on the same port with `reusePort: true`, so the Linux kernel (SO_REUSEPORT) balances connections.
// No restart: a worker that dies stays dead.
const workers = navigator.hardwareConcurrency;
const server = new URL("./server.ts", import.meta.url).pathname;
const procs = Array.from({ length: workers }, () =>
  Bun.spawn({
    cmd: [process.execPath, server],
    env: { ...process.env, WORKERS: String(workers) },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }),
);
const kill = () => { for (const p of procs) p.kill(); };
process.on("SIGINT", () => { kill(); process.exit(0); });
process.on("SIGTERM", () => { kill(); process.exit(0); });
process.on("exit", kill);
