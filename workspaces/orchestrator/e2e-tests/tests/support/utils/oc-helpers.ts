import { execFileSync } from "node:child_process";

export function runOc(args: string[], timeoutMs = 30_000): string {
  return execFileSync("oc", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Like runOc but returns exit code instead of throwing on failure. */
export function runOcOptional(
  args: string[],
  timeoutMs = 30_000,
): { exitCode: number; stdout: string } {
  try {
    return { exitCode: 0, stdout: runOc(args, timeoutMs) };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
}
