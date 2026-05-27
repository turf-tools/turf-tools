import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import chalk from "chalk";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Per-script logger with a `[name]` prefix and bracket-tagged severities.
export function createLogger(name: string) {
  const prefix = chalk.gray(`[${name}]`);
  const tag = {
    task: "[" + chalk.yellow("task") + "]",
    info: "[" + chalk.blue("info") + "]",
    success: "[" + chalk.green("success") + "]",
    skip: "[" + chalk.magenta("skip") + "]",
    error: "[" + chalk.red("error") + "]",
  };
  return {
    task: (msg: string) => console.log(`${prefix} ${tag.task} ${msg}`),
    info: (msg: string) => console.log(`${prefix} ${tag.info} ${msg}`),
    success: (msg: string) => console.log(`${prefix} ${tag.success} ${msg}`),
    skip: (msg: string) => console.log(`${prefix} ${tag.skip} ${msg}`),
    error: (msg: string) => console.error(`${prefix} ${tag.error} ${msg}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;

// Runs `cmd` through `bash -c` so shell features (set -a, source, pipes,
// `$VAR` expansion) work. Inherits stdio so output streams live. Echoes
// the command through the caller's logger as `[name] [info] executing: …`,
// then exits the process on non-zero status.
export function run(log: Logger, cmd: string, opts: { cwd?: string } = {}): void {
  log.info(`executing: ${cmd}`);
  const cwd = opts.cwd ?? REPO_ROOT;
  const result = spawnSync("bash", ["-c", cmd], { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
