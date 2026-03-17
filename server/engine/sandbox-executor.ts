import { spawn } from "child_process";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? "nanoorch-sandbox:latest";
const SANDBOX_RUNTIME = process.env.SANDBOX_RUNTIME ?? "runsc";
const DEFAULT_SANDBOX_TIMEOUT_S = 30;

const INFRA_ERROR_PATTERNS = [
  "no such image",
  "unable to find image",
  "unknown runtime",
  "cannot connect to the docker daemon",
  "permission denied",
  "no such file or directory",
  "failed to start sandbox container",
];

function isInfraError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return INFRA_ERROR_PATTERNS.some((p) => lower.includes(p));
}

export function isSandboxAvailable(): boolean {
  const socketPath = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
  return existsSync(socketPath);
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  infraError?: boolean;
}

export async function executeCodeInSandbox(
  language: string,
  code: string,
  timeoutSeconds: number = DEFAULT_SANDBOX_TIMEOUT_S
): Promise<SandboxResult> {
  const codeB64 = Buffer.from(code).toString("base64");
  const innerTimeoutSeconds = Math.max(5, timeoutSeconds - 5);
  const outerTimeoutMs = timeoutSeconds * 1000;

  const dockerSocket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

  const dockerArgs = [
    "run",
    "--rm",
    "--runtime", SANDBOX_RUNTIME,
    "--network", "none",
    "--read-only",
    "--memory", "256m",
    "--cpus", "0.5",
    "--pids-limit", "64",
    "--tmpfs", "/tmp:size=64m",
    "-e", `LANGUAGE=${language}`,
    "-e", `CODE_B64=${codeB64}`,
    "-e", `TIMEOUT_SECONDS=${innerTimeoutSeconds}`,
    SANDBOX_IMAGE,
  ];

  return new Promise((resolve) => {
    const proc = spawn("docker", dockerArgs, {
      env: { ...process.env, DOCKER_HOST: `unix://${dockerSocket}` },
    });

    let rawStdout = "";
    let rawStderr = "";

    proc.stdout.on("data", (d: Buffer) => { rawStdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { rawStderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ stdout: "", stderr: `Sandbox timed out after ${timeoutSeconds} seconds`, exitCode: 124 });
    }, outerTimeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(rawStdout.trim()) as SandboxResult;
        resolve(result);
      } catch {
        const stderr = rawStderr.slice(0, 5000) || "Container exited unexpectedly";
        resolve({
          stdout: rawStdout.slice(0, 10000),
          stderr,
          exitCode: code ?? 1,
          infraError: isInfraError(stderr),
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const stderr = `Failed to start sandbox container: ${err.message}`;
      resolve({ stdout: "", stderr, exitCode: 1, infraError: true });
    });
  });
}

const LOCAL_RUNNERS: Record<string, { cmd: string; ext: string }> = {
  python: { cmd: "python3", ext: "py" },
  python3: { cmd: "python3", ext: "py" },
  javascript: { cmd: "node", ext: "js" },
  js: { cmd: "node", ext: "js" },
  node: { cmd: "node", ext: "js" },
  typescript: { cmd: "node", ext: "js" },
  ts: { cmd: "node", ext: "js" },
  bash: { cmd: "bash", ext: "sh" },
  sh: { cmd: "bash", ext: "sh" },
};

export async function executeCodeLocally(
  language: string,
  code: string,
  timeoutSeconds: number = DEFAULT_SANDBOX_TIMEOUT_S
): Promise<SandboxResult> {
  const runner = LOCAL_RUNNERS[language.toLowerCase()];
  if (!runner) {
    return {
      stdout: "",
      stderr: `Language '${language}' is not available for local execution. Supported: python, javascript, bash.`,
      exitCode: 1,
      infraError: false,
    };
  }

  const tmpFile = join(
    tmpdir(),
    `nanoorch_${Date.now()}_${Math.random().toString(36).slice(2)}.${runner.ext}`
  );

  try {
    writeFileSync(tmpFile, code, "utf-8");
  } catch (err: any) {
    return { stdout: "", stderr: `Failed to write temp file: ${err.message}`, exitCode: 1, infraError: false };
  }

  return new Promise((resolve) => {
    const proc = spawn(runner.cmd, [tmpFile]);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      try { unlinkSync(tmpFile); } catch {}
      resolve({ stdout: "", stderr: `Execution timed out after ${timeoutSeconds} seconds`, exitCode: 124, infraError: false });
    }, timeoutSeconds * 1000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch {}
      resolve({
        stdout: stdout.slice(0, 10000),
        stderr: stderr.slice(0, 5000),
        exitCode: code ?? 0,
        infraError: false,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch {}
      const msg = err.message.includes("ENOENT") || err.message.includes("not found")
        ? `${runner.cmd} is not installed on this server`
        : `Failed to execute: ${err.message}`;
      resolve({ stdout: "", stderr: msg, exitCode: 1, infraError: false });
    });
  });
}

export async function runCode(
  language: string,
  code: string,
  timeoutSeconds: number = DEFAULT_SANDBOX_TIMEOUT_S
): Promise<SandboxResult> {
  if (isSandboxAvailable()) {
    const result = await executeCodeInSandbox(language, code, timeoutSeconds);
    if (!result.infraError) return result;
  }
  return executeCodeLocally(language, code, timeoutSeconds);
}
