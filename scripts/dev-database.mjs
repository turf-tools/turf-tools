#!/usr/bin/env node
// Dev Postgres helpers for root package.json scripts.
//
// Resolves DATABASE_URL from the environment or local .env files, waits on its
// host:port, starts Docker Compose only for the built-in docker-compose.dev.yml
// URL, and derives Quickwit's metastore URI from the same credentials.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

export function usesDevDockerDb(url = resolveDatabaseUrl()) {
  return url === DEV_DOCKER_DATABASE_URL;
}

export function tcpTarget(url = resolveDatabaseUrl()) {
  const parsed = new URL(url);
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port || "5432";
  return `tcp:${host}:${port}`;
}

/** Same host/user/password as DATABASE_URL, database name `quickwit`. */
export function quickwitMetastoreUri(url = resolveDatabaseUrl()) {
  const parsed = new URL(url);
  parsed.pathname = "/quickwit";
  return parsed.toString();
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

async function waitForDb() {
  const target = tcpTarget();
  console.log(`waiting for Postgres at ${target}`);
  await waitOn({ resources: [target], timeout: 60_000 });
}

async function dockerUp({ detach }) {
  const args = ["compose", "-f", "docker-compose.dev.yml", "up"];
  if (detach) args.push("-d");
  args.push("postgres");
  await run("docker", args);
}

async function cmdDocker() {
  if (!usesDevDockerDb()) {
    console.log(`Using external DATABASE_URL (${resolveDatabaseUrl()}); skipping Docker Postgres`);
    return;
  }
  await dockerUp({ detach: false });
}

async function cmdUp() {
  if (usesDevDockerDb()) {
    await dockerUp({ detach: true });
  } else {
    console.log(`Using external DATABASE_URL (${resolveDatabaseUrl()}); skipping Docker Postgres`);
  }
  await waitForDb();
}

async function cmdQuickwit() {
  const env = {
    ...process.env,
    QW_METASTORE_URI: process.env.QW_METASTORE_URI ?? quickwitMetastoreUri(),
  };
  await run(
    "sh",
    [
      "-c",
      "mkdir -p qwdata && quickwit run --config quickwit/node.yaml 2>&1 | grep --line-buffered -E '(REST server is ready|ERROR|FATAL|command failed)'",
    ],
    { cwd: resolve(root, "apps/data"), env },
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "wait") await waitForDb();
  else if (command === "docker") await cmdDocker();
  else if (command === "up") await cmdUp();
  else if (command === "quickwit") await cmdQuickwit();
  else {
    console.error(`usage: node scripts/dev-database.mjs <wait|docker|up|quickwit>`);
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
