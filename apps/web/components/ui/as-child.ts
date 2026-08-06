import type * as React from "react";

/**
 * Translate the Radix `asChild` convention onto Base UI's `render` prop.
 *
 * Both express the same idea — render the given element instead of the default
 * one and merge props into it — but Radix takes the element as the single child
 * while Base UI takes it as a prop. Roughly a hundred call sites use `asChild`,
 * so it is translated once here rather than rewritten everywhere.
 *
 * Passing `asChild` and `render` together is a mistake; `render` wins, because
 * it is the underlying library's own API.
 */
export function withAsChild<P extends Record<string, unknown>>(
  props: P & { asChild?: boolean; render?: unknown; children?: React.ReactNode },
): Omit<P, "asChild"> {
  const { asChild, children, render, ...rest } = props;

  if (!asChild || render !== undefined) {
    return { ...rest, children, ...(render === undefined ? {} : { render }) } as Omit<
      P,
      "asChild"
    >;
  }

  return { ...rest, render: children as React.ReactElement } as Omit<P, "asChild">;
}
