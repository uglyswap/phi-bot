import type { SVGProps } from "react";
import { cn } from "../lib/utils";

// Phi Bot build-time replacement of the upstream animated paperclip
// (BRAND_OVERRIDES in scripts/phibot-rebrand-lib.mjs): same exports, props and
// CSS animation (.paperclip-thinking-icon-path in ui/src/index.css). The phi is
// one stroke (stem top, bowl, stem down); pathLength keeps the dash length of
// the upstream keyframes (85.717).
export function AnimatedPaperclipIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="-1 -1 26 26"
      className={cn("paperclip-thinking-icon", className)}
      aria-hidden="true"
      {...props}
    >
      <path
        className="paperclip-thinking-icon-path"
        d="M12 1.5V6A6.75 6 0 0 0 12 18A6.75 6 0 0 0 12 6V22.5"
        pathLength={85.717}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Full-page loading state: a large, centered, gray animated phi. */
export function PaperclipLoading({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex min-h-dvh w-full items-center justify-center", className)}
    >
      <AnimatedPaperclipIcon className="h-24 w-24 text-muted-foreground" />
      <span className="sr-only">Loading...</span>
    </div>
  );
}
