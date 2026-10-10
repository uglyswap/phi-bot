import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { phibotText } from "./phibot-text";

const TONE_CLASSES: Record<AdapterEnvironmentTestResult["status"], string> = {
  pass: "border-green-300 bg-green-50 text-green-800 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-200",
  warn: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
  fail: "border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200",
};

/** Result of the phi_local environment test, with every check the adapter reported. */
export function PhiBotTestResult({ result }: { result: AdapterEnvironmentTestResult }) {
  const text = phibotText();
  const title =
    result.status === "pass" ? text.testPassed : result.status === "warn" ? text.testWarn : text.testFailed;
  return (
    <div role="status" className={`rounded-md border px-3 py-2 text-xs ${TONE_CLASSES[result.status]}`}>
      <p className="font-medium">{title}</p>
      <ul className="mt-1 space-y-1">
        {result.checks.map((check, index) => (
          <li key={`${check.code}-${index}`} className="break-words">
            <span className="font-medium uppercase">{check.level}</span> {check.message}
            {check.hint ? <span className="block opacity-90">{check.hint}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
