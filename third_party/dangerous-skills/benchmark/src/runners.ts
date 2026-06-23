import { spawn } from "node:child_process";
import type { ClaudePermissionMode, Runner } from "./types.js";

interface RunAgentOptions {
  runner: Runner;
  model: string;
  projectDir: string;
  prompt: string;
  timeoutMs?: number;
  /** Extra environment variables to set for this run */
  envOverrides?: Record<string, string>;
  /** Permission mode for the claude runner (default: "skip") */
  claudePermissionMode?: ClaudePermissionMode;
}

interface RunAgentResult {
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Kill an entire process group: SIGTERM first, then SIGKILL after grace period.
 */
function killProcessGroup(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); } catch {}
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }, 3_000);
}

/**
 * Run an agent (claude or opencode) with the given prompt in the given directory.
 * Returns the combined stdout+stderr output.
 * Stdin is closed immediately so interactive agents don't hang.
 *
 * For JSON output mode: detects complete JSON responses and resolves early,
 * since some CLI processes hang after outputting results.
 */
export function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { runner, model, projectDir, prompt, timeoutMs = 300_000, envOverrides, claudePermissionMode = "skip" } = opts;

  let args: string[];
  if (runner === "claude") {
    const permArgs =
      claudePermissionMode === "auto"
        ? ["--permission-mode", "auto"]
        : ["--dangerously-skip-permissions"];
    args = [
      ...permArgs,
      "--model",
      model,
      "-p",
      prompt,
      "--output-format",
      "json",
    ];
  } else {
    args = ["run", "--model", model, "--format", "json", "--dir", projectDir, prompt];
  }

  const bin = runner === "claude" ? "claude" : "opencode";

  return new Promise((resolve) => {
    const start = Date.now();
    const chunks: Buffer[] = [];
    let timedOut = false;
    let resolved = false;

    const finish = (exitCode: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const output = Buffer.concat(chunks).toString("utf-8");
      resolve({ output, exitCode, durationMs, timedOut });
    };

    const proc = spawn(bin, args, {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: "/bin/zsh",
      detached: true,
      env: { ...process.env, ...envOverrides },
    });

    // Detect complete JSON output and resolve early.
    // Claude CLI with --output-format json emits a single JSON object on stdout.
    // The process sometimes hangs after outputting, so we detect the closing brace
    // and kill the process rather than waiting for it to exit.
    proc.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (resolved) return;

      const soFar = Buffer.concat(chunks).toString("utf-8").trimEnd();
      if (soFar.startsWith("{") && soFar.endsWith("}")) {
        try {
          JSON.parse(soFar);
          // Valid complete JSON — resolve and kill the process
          finish(0);
          killProcessGroup(proc.pid!);
        } catch {
          // Incomplete JSON, keep waiting
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      finish(1);
      killProcessGroup(proc.pid!);
    }, timeoutMs);

    proc.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}
