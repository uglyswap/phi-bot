import { describe, expect, it } from "vitest";
import { rebrandCliText } from "../phibot/rebrand.js";

describe("rebrandCliText", () => {
  it("names the phibot command in upstream messages", () => {
    expect(rebrandCliText("Run `paperclipai onboard` or `paperclipai configure --section database`")).toBe(
      "Run `phibot onboard` or `phibot configure --section database`",
    );
    expect(rebrandCliText("Use paperclipai run instead.")).toBe("Use phibot run instead.");
  });

  it("keeps package scopes, the upstream repository and longer words", () => {
    const text = "@paperclipai/db, paperclipai/paperclip, paperclipai-db, /node_modules/paperclipai/";
    expect(rebrandCliText(text)).toBe(text);
  });
});
