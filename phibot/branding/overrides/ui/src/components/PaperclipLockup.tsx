import type { SVGProps } from "react";

interface PaperclipLockupProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  decorative?: boolean;
  title?: string;
}

/**
 * Phi Bot lockup: the phi mark plus the "Phi Bot" wordmark. Build-time
 * replacement of the upstream Paperclip lockup (BRAND_OVERRIDES in
 * scripts/phibot-rebrand-lib.mjs) with the same export and props, so every
 * caller keeps working. Every shape fills `currentColor` and follows the theme.
 * The wordmark is text stretched to a fixed length (textLength), so the viewBox
 * never clips it, whatever the font.
 *
 * Size it with a height class (`h-5 w-auto`); width follows the aspect.
 */
export function PaperclipLockup({
  decorative = false,
  title = "Phi Bot",
  className,
  ...rest
}: PaperclipLockupProps) {
  return (
    <svg
      {...rest}
      className={className}
      viewBox="0 0 124 32"
      fill="currentColor"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      <path
        fillRule="evenodd"
        d="M4 16a12 10 0 1 0 24 0a12 10 0 1 0 -24 0ZM10 16a6 6 0 1 0 12 0a6 6 0 1 0 -12 0Z"
      />
      <rect x="14" y="2" width="4" height="28" rx="2" />
      <text x="38" y="24" fontSize="22" fontWeight="600" textLength="84" lengthAdjust="spacingAndGlyphs">
        Phi Bot
      </text>
    </svg>
  );
}
