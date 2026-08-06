import type * as React from "react";

/**
 * The Paco mark: a shell prompt chevron over a command line.
 *
 * The product is a terminal agent given a browser, so the identity is the prompt
 * itself rather than an abstract glyph. It was previously inlined in two places
 * under a name left over from the upstream project.
 */
export function PacoLogo({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      aria-label="Paco"
      className={className}
      fill="none"
      role="img"
      viewBox="0 0 24 24"
      {...props}
    >
      <path
        d="M4 17L10 11L4 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <path
        d="M12 19H20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
