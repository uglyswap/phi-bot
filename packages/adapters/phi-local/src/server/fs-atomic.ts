import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

/**
 * Replace `target` with `content` through a unique temporary file and a
 * rename (atomic on one filesystem): a concurrent reader never sees a
 * partial file. Mode 0600: these files belong to the Phi Bot account.
 */
export async function writeFileAtomically(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Windows refuses to replace a file another process is reading (EPERM/EBUSY): retry briefly. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
