/**
 * Upstream messages name the `paperclipai` command; on Phi Bot the command is `phibot`.
 * Package scopes (`@paperclipai/...`) and the upstream repository (`paperclipai/paperclip`) are kept.
 */
export function rebrandCliText(text: string): string {
  return text.replace(/(?<![@\w/-])paperclipai(?![\w/-])/g, "phibot");
}
