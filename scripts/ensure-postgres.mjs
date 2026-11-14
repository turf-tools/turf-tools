#!/usr/bin/env node
// Dev Postgres helper. The repo's defaults point at 127.0.0.1:5432, so every
// app service has to know whether the database is up before it connects:
//
//   node scripts/ensure-postgres.mjs --wait         wait until it is reachable
//   node scripts/ensure-postgres.mjs --ensure       start it with docker if needed
//   node scripts/ensure-postgres.mjs --foreground   run `docker compose up postgres`
//   node scripts/ensure-postgres.mjs --foreground   (used by `dev:db`)
//
// Inside the dev container Postgres is already running as a compose service and
// reachable at DB_HOST, so every mode short-circuits on the reachability check
// and never tries to start a container.
import net from "node:net";
import { spawn } from "node:child_process";

const mode = process.argv.includes("--foreground")
  ? "foreground"
  : process.argv.includes("--ensure")
    ? "ensure"
    : "wait";
const host = process.env.DB_HOST ?? "127.0.0.1";
// An explicit DB_HOST means something outside this script owns the database
// (inside the dev container it is the compose service). Without one, the
// repo's default of 127.0.0.1 applies, and a listener there is not
// necessarily the compose database, so the compose path still has to run and
// fail loudly if something else owns the port.
const hostIsExplicit = process.env.DB_HOST !== undefined;
const port = Number(process.env.DB_PORT ?? 5432);
const target = `${host}:${port}`;

function probe() {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitFor(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return probe();
}

function runCompose(args) {
  const child = spawn("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`could not start postgres with docker: ${error.message}`);
    console.error("Inside the dev container, start the compose stack instead.");
    process.exit(1);
  });
  return child;
}

if (await probe()) {
  console.log(`postgres reachable at ${target}`);
  process.exit(0);
}

if (mode === "wait") {
  if (await waitFor(120_000)) {
    console.log(`postgres reachable at ${target}`);
    process.exit(0);
  }
  console.error(`postgres did not become reachable at ${target}`);
  process.exit(1);
}

const child = runCompose(mode === "foreground" ? ["up", "postgres"] : ["up", "-d", "postgres"]);

child.on("exit", async (code) => {
  if (code !== 0) process.exit(code ?? 1);
  if (mode === "foreground") process.exit(0);

  if (await waitFor(60_000)) {
    console.log(`postgres reachable at ${target}`);
    process.exit(0);
  }
  console.error(`postgres started but did not become reachable at ${target}`);
  process.exit(1);
});
