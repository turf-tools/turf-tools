#!/usr/bin/env node
// Dev Postgres helpers for root package.json scripts.
//
// Resolves DATABASE_URL from the environment or local .env files, waits on its
// host:port, starts (or wipes) Docker Compose Postgres only for the built-in
// docker-compose.dev.yml URL, and derives Quickwit's metastore URI from the
// same credentials.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import waitOn from "wait-on";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Built-in URL for docker-compose.dev.yml — mirrors packages/db + apps/data defaults. */
export const DEV_DOCKER_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";

const ENV_CANDIDATES = [
  resolve(root, "packages/db/.env"),
  resolve(root, "apps/web/.env"),
  resolve(root, "apps/data/.env"),
];

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const path of ENV_CANDIDATES) {
    const url = parseEnvFile(path).DATABASE_URL;
    if (url) return url;
  }
  return DEV_DOCKER_DATABASE_URL;
}

// Each app reads only its own .env, falling back to the Docker URL, so files
// that disagree (or one that's unset) put the apps on different databases. A
// shell DATABASE_URL overrides every file, so there's nothing to compare.
function warnIfEnvFilesDisagree() {
  if (process.env.DATABASE_URL) return;
  const urls = ENV_CANDIDATES.map(
    (path) => parseEnvFile(path).DATABASE_URL || DEV_DOCKER_DATABASE_URL,
  );
  if (new Set(urls).size === 1) return;
  console.warn("DATABASE_URL differs across .env files; each app uses its own:");
  ENV_CANDIDATES.forEach((path, i) =>
    console.warn(`  ${path.slice(root.length + 1)}: ${describeDatabaseUrl(urls[i])}`),
  );
}

export function usesDevDockerDb(url = resolveDatabaseUrl()) {
  return url === DEV_DOCKER_DATABASE_URL;
}

function hostPort(url) {
  const parsed = new URL(url);
  return `${parsed.hostname || "127.0.0.1"}:${parsed.port || "5432"}`;
}

/** host:port/database, without credentials, for logs. */
function describeDatabaseUrl(url) {
  return `${hostPort(url)}${new URL(url).pathname}`;
}

export function tcpTarget(url = resolveDatabaseUrl()) {
  return `tcp:${hostPort(url)}`;
}

/** Same host/user/password as DATABASE_URL, database name `quickwit`. */
export function quickwitMetastoreUri(url = resolveDatabaseUrl()) {
  const parsed = new URL(url);
  parsed.pathname = "/quickwit";
  return parsed.toString();
}

/** Host Quickwit CLI path — `QUICKWIT_BINARY`, else `apps/data/.env`, else PATH name. */
export function resolveQuickwitBinary() {
  if (process.env.QUICKWIT_BINARY?.trim()) return process.env.QUICKWIT_BINARY.trim();
  const fromFile = parseEnvFile(resolve(root, "apps/data/.env")).QUICKWIT_BINARY?.trim();
  if (fromFile) return fromFile;
  return "quickwit";
}

function run(command, args, { env = process.env, cwd = root } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd, env, shell: false });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} exited via ${signal}`));
      else if (code) reject(new Error(`${command} exited with code ${code}`));
      else resolvePromise();
    });
  });
}

// Long enough for a first-run image pull or Docker Desktop starting up.
const WAIT_TIMEOUT_MS = 5 * 60_000;

async function waitForDb() {
  const target = tcpTarget();
  console.log(`waiting for Postgres at ${target}`);
  try {
    await waitOn({ resources: [target], timeout: WAIT_TIMEOUT_MS });
  } catch {
    throw new Error(
      `Postgres at ${describeDatabaseUrl(resolveDatabaseUrl())} didn't accept connections within 5 minutes`,
    );
  }
}

async function dockerUp({ detach }) {
  const args = ["compose", "-f", "docker-compose.dev.yml", "up"];
  if (detach) args.push("-d");
  args.push("postgres");
  await run("docker", args);
}

function logExternal() {
  console.log(
    `Using external DATABASE_URL (${describeDatabaseUrl(resolveDatabaseUrl())}); skipping Docker Postgres`,
  );
}

async function cmdDocker() {
  warnIfEnvFilesDisagree();
  if (!usesDevDockerDb()) {
    logExternal();
    return;
  }
  await dockerUp({ detach: false });
}

async function cmdUp() {
  warnIfEnvFilesDisagree();
  if (usesDevDockerDb()) {
    await dockerUp({ detach: true });
  } else {
    logExternal();
  }
  await waitForDb();
}

// Only the Docker database is ours to wipe; an external one is left alone.
async function cmdClear() {
  warnIfEnvFilesDisagree();
  if (!usesDevDockerDb()) {
    throw new Error(
      `DATABASE_URL points at your own Postgres (${describeDatabaseUrl(resolveDatabaseUrl())}); db:clear only resets the Docker database`,
    );
  }
  await run("docker", ["compose", "-f", "docker-compose.dev.yml", "down", "-v"]);
}

async function cmdQuickwit() {
  // Spawn Quickwit directly (not via `sh | grep`) so SIGTERM from concurrently
  // stops the searcher instead of leaving UDP :7280 held by an orphan.
  const dataDir = resolve(root, "apps/data");
  mkdirSync(resolve(dataDir, "qwdata"), { recursive: true });
  const env = {
    ...process.env,
    QW_METASTORE_URI: process.env.QW_METASTORE_URI?.trim() || quickwitMetastoreUri(),
  };
  const binary = resolveQuickwitBinary();
  const interesting = /(REST server is ready|ERROR|FATAL|command failed)/;

  await new Promise((resolvePromise, reject) => {
    const child = spawn(binary, ["run", "--config", "quickwit/node.yaml"], {
      cwd: dataDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stopping = false;
    const stopChild = (signal = "SIGTERM") => {
      if (stopping || child.killed || child.exitCode != null) return;
      stopping = true;
      child.kill(signal);
      // Quickwit can ignore a soft stop briefly; escalate so :7280 is freed.
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
      }, 2000).unref();
    };
    const onSignal = () => stopChild("SIGTERM");
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    const forward = (stream) => {
      createInterface({ input: stream }).on("line", (line) => {
        if (interesting.test(line)) console.log(line);
      });
    };
    forward(child.stdout);
    forward(child.stderr);

    child.on("error", (err) => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      if (signal && signal !== "SIGTERM" && signal !== "SIGINT" && signal !== "SIGKILL") {
        reject(new Error(`${binary} exited via ${signal}`));
      } else if (code) reject(new Error(`${binary} exited with code ${code}`));
      else resolvePromise();
    });
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "wait") await waitForDb();
  else if (command === "docker") await cmdDocker();
  else if (command === "up") await cmdUp();
  else if (command === "clear") await cmdClear();
  else if (command === "quickwit") await cmdQuickwit();
  else {
    console.error(`usage: node scripts/dev-database.mjs <wait|docker|up|clear|quickwit>`);
    process.exit(1);
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
