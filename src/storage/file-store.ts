import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class FileStore {
  constructor(private readonly baseDir: string) {}

  async writeJson<T>(relativePath: string, value: T): Promise<void> {
    const fullPath = resolve(this.baseDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  async readJson<T>(relativePath: string): Promise<T | null> {
    const fullPath = resolve(this.baseDir, relativePath);

    try {
      const raw = await readFile(fullPath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  async appendJsonLine(relativePath: string, value: unknown): Promise<void> {
    const fullPath = resolve(this.baseDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await appendFile(fullPath, `${JSON.stringify(value)}\n`, "utf8");
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
