import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import chalk from "chalk";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function section(title: string): void {
  process.stdout.write(`\n${chalk.yellow(`==> ${title}`)}\n`);
}

// Runs `cmd` through `bash -c` so shell features (set -a, source, pipes,
// `$VAR` expansion) work. Inherits stdio so output streams live. Exits the
// process on non-zero status.
export function run(cmd: string, opts: { cwd?: string } = {}): void {
  process.stdout.write(`${chalk.gray(cmd)}\n`);
  const cwd = opts.cwd ?? REPO_ROOT;
  const result = spawnSync("bash", ["-c", cmd], { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
