import { describe, expect, it } from "vitest";
import { PHIBOT_PROVIDERS } from "@paperclipai/adapter-phi-local/ui";
import { AuthApiError } from "../../api/auth";
import { PhiBotSetupError } from "../../lib/phibot-llm";
import {
  describePhiBotError,
  describePhiBotPasswordError,
  phiBotProviderName,
  phibotText,
  type PhiBotText,
} from "./phibot-text";

const EM_DASH = String.fromCharCode(0x2014);

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [String(value(1, "x"))];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("Phi Bot text dictionary", () => {
  const fr = phibotText("fr");
  const en = phibotText("en");

  it("has the same keys in French and English", () => {
    const keys = (text: PhiBotText) =>
      Object.entries(text).flatMap(([key, value]) =>
        value && typeof value === "object" ? Object.keys(value).map((sub) => `${key}.${sub}`) : [key],
      );
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });

  it("never uses the em dash character", () => {
    for (const text of [fr, en]) {
      for (const entry of strings(text)) expect(entry.includes(EM_DASH), entry).toBe(false);
    }
  });

  it("translates the two custom endpoints and keeps brand names", () => {
    const names = PHIBOT_PROVIDERS.map((provider) => phiBotProviderName(provider, en));
    expect(names).toContain("OpenAI-compatible (custom URL)");
    expect(names).toContain("Anthropic-compatible (custom URL)");
    expect(names[0]).toBe("Anthropic (Claude)");
    expect(PHIBOT_PROVIDERS.map((provider) => phiBotProviderName(provider, fr))).toContain(
      "Compatible Anthropic (URL personnalisée)",
    );
  });

  it("maps setup and password failures to dictionary messages", () => {
    expect(describePhiBotError(new PhiBotSetupError("environmentMissing"), fr)).toBe(fr.errors.environmentMissing);
    expect(describePhiBotPasswordError(new AuthApiError("Invalid password", 400, null, "INVALID_PASSWORD"), fr)).toBe(
      fr.passwordErrors.currentPasswordInvalid,
    );
    expect(describePhiBotPasswordError(new AuthApiError("short", 400, null, "PASSWORD_TOO_SHORT"), en)).toBe(
      en.passwordErrors.newPasswordLength,
    );
  });
});
