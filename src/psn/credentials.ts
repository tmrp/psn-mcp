import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface CredentialsFile {
  npsso?: string;
}

export function credentialsPath(): string {
  return (
    process.env.PSN_NPSSO_FILE ??
    join(homedir(), ".config", "psn-mcp", "credentials.json")
  );
}

export async function loadStoredNpsso(): Promise<string | null> {
  try {
    const data = JSON.parse(
      await readFile(credentialsPath(), "utf8"),
    ) as CredentialsFile;
    return data.npsso || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveStoredNpsso(npsso: string): Promise<string> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ npsso }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
  return path;
}
