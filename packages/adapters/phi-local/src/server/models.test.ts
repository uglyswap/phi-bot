import { describe, expect, it } from "vitest";
import { parsePhiModelsOutput, toPhiBotModels } from "./models.js";
import { ALIBABA_CODING_PLAN_MODELS, PHI_PROVIDER_KEY_ENV } from "./runtime-config.js";

// Excerpt of `phi --list-models` (0.99.5) printed on stdout.
const table = [
  "provider    model                                               context  max-out  thinking  images",
  "anthropic   claude-sonnet-4-6                                   1M       64K      yes       yes   ",
  "amazon-bedrock  anthropic.claude-x                              200K     8K       yes       no    ",
  "openrouter  anthropic/claude-sonnet-4.5                         1M       64K      yes       yes   ",
  "google      gemini-2.5-pro                                      1M       64K      yes       yes   ",
  "zai         glm-4.6                                             200K     128K     yes       no    ",
  "moonshotai  kimi-k2-thinking                                    256K     32K      yes       no    ",
  "moonshotai-cn  kimi-k2-thinking                                 256K     32K      yes       no    ",
  "minimax     MiniMax-M2                                          200K     128K     yes       no    ",
  "opencode-go  glm-5                                              200K     128K     yes       no    ",
  "opencode    gpt-5                                               400K     128K     yes       yes   ",
  "No models matching \"x\"",
].join("\n");

describe("phi model catalog", () => {
  it("parses the table and skips the header and free text", () => {
    expect(parsePhiModelsOutput(table).slice(0, 4)).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "amazon-bedrock", model: "anthropic.claude-x" },
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
      { provider: "google", model: "gemini-2.5-pro" },
    ]);
    expect(parsePhiModelsOutput(table)).toHaveLength(10);
  });

  it("keeps Phi Bot providers only, prefixes ids and adds the bundled Alibaba list", () => {
    const ids = toPhiBotModels(parsePhiModelsOutput(table)).map((model) => model.id);
    expect(ids).toContain("anthropic/claude-sonnet-4-6");
    expect(ids).toContain("openrouter/anthropic/claude-sonnet-4.5");
    expect(ids).toContain("google/gemini-2.5-pro");
    expect(ids).toContain("zai/glm-4.6");
    expect(ids).toContain("moonshotai/kimi-k2-thinking");
    expect(ids).toContain("minimax/MiniMax-M2");
    expect(ids).toContain("opencode-go/glm-5");
    expect(ids.some((id) => id.startsWith("amazon-bedrock/"))).toBe(false);
    expect(ids.some((id) => id.startsWith("moonshotai-cn/"))).toBe(false);
    expect(ids.some((id) => id.startsWith("opencode/"))).toBe(false);
    for (const model of ALIBABA_CODING_PLAN_MODELS) expect(ids).toContain(`alibaba/${model.id}`);
  });

  it("sets a placeholder key for every built-in provider when reading the catalog", () => {
    expect([...PHI_PROVIDER_KEY_ENV].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GROQ_API_KEY",
      "MINIMAX_API_KEY",
      "MISTRAL_API_KEY",
      "MOONSHOT_API_KEY",
      "OPENAI_API_KEY",
      "OPENCODE_API_KEY",
      "OPENROUTER_API_KEY",
      "XAI_API_KEY",
      "ZAI_API_KEY",
    ]);
  });
});
