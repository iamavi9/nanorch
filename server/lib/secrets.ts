import { readFileSync } from "fs";

export function loadSecret(name: string): string | undefined {
  const fileEnv = process.env[`${name}_FILE`];
  if (fileEnv) {
    try {
      return readFileSync(fileEnv, "utf-8").trim();
    } catch {
    }
  }
  return process.env[name];
}
