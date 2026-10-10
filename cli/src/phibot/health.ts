import { PHIBOT_LOCAL_URL, PHIBOT_UNIT_NAME } from "./constants.js";
import type { PhibotSystem } from "./system.js";

export interface HealthSnapshot {
  ok: boolean;
  /** "ready" once an instance admin exists, "bootstrap_pending" before. */
  bootstrapStatus: string | null;
  error: string | null;
}

const HEALTH_URL = `${PHIBOT_LOCAL_URL}/api/health`;
const POLL_MS = 2_000;

/**
 * Anonymous GET /api/health. In authenticated mode the answer never contains serverVersion
 * (server/src/routes/health.ts:45-51, :406-425): the installed version is read on disk instead.
 */
export async function probeHealth(sys: PhibotSystem, url: string = HEALTH_URL): Promise<HealthSnapshot> {
  try {
    const response = await sys.fetch(url, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as { status?: unknown; bootstrapStatus?: unknown };
    return {
      ok: response.ok && body.status === "ok",
      bootstrapStatus: typeof body.bootstrapStatus === "string" ? body.bootstrapStatus : null,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, bootstrapStatus: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function isServiceActive(sys: PhibotSystem, unit: string = PHIBOT_UNIT_NAME): Promise<boolean> {
  const result = await sys.exec("systemctl", ["is-active", unit]);
  return result.stdout.trim() === "active";
}

/** Polls until `predicate` holds or the delay expires; returns the last snapshot. */
export async function waitForHealthy(
  sys: PhibotSystem,
  timeoutMs: number,
  predicate: (snapshot: HealthSnapshot) => Promise<boolean> | boolean = (snapshot) => snapshot.ok,
): Promise<{ healthy: boolean; last: HealthSnapshot }> {
  const deadline = sys.now().getTime() + timeoutMs;
  let last: HealthSnapshot = { ok: false, bootstrapStatus: null, error: "aucune réponse" };
  while (sys.now().getTime() <= deadline) {
    last = await probeHealth(sys);
    if (await predicate(last)) return { healthy: true, last };
    await sys.sleep(POLL_MS);
  }
  return { healthy: false, last };
}

/** Success criterion of setup step 8, update and doctor (review B2): unit active and health ok. */
export async function waitForServiceHealthy(sys: PhibotSystem, timeoutMs: number): Promise<{ healthy: boolean; last: HealthSnapshot }> {
  return waitForHealthy(sys, timeoutMs, async (snapshot) => snapshot.ok && (await isServiceActive(sys)));
}

export async function serviceJournalTail(sys: PhibotSystem, lines = 100): Promise<string> {
  const result = await sys.exec("journalctl", ["-u", PHIBOT_UNIT_NAME, "-n", String(lines), "--no-pager"]);
  return result.stdout.trimEnd();
}
