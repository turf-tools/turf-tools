import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import chalk from "chalk";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function section(title: string): void {
  process.stdout.write(`\n${chalk.yellow(`==> ${title}`)}\n`);
}

// Per-script logger with a `[name]` prefix and tagged severities. Tags are
// fixed-width ([info] padded to match [success]/[error]) so multi-line
// output aligns cleanly.
export function createLogger(name: string) {
  const prefix = chalk.gray(`[${name}]`);
  const tag = {
    info: chalk.gray("[info]   "),
    success: chalk.green("[success]"),
    error: chalk.red("[error]  "),
  };
  return {
    info: (msg: string) => console.log(`${prefix} ${tag.info} ${msg}`),
    success: (msg: string) => console.log(`${prefix} ${tag.success} ${msg}`),
    error: (msg: string) => console.error(`${prefix} ${tag.error} ${msg}`),
  };
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
