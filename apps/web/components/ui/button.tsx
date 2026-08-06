"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type * as React from "react";
import { cn } from "@/lib/utils";

type ButtonVariant =
  | "default"
  | "destructive"
  | "outline"
  | "secondary"
  | "ghost"
  | "link";

type ButtonSize =
  | "default"
  | "sm"
  | "lg"
  | "icon"
  | "icon-sm"
  | "icon-lg";

/*
 * Every class name appears as a complete literal so Tailwind can find it. Do not
 * build these by interpolation (`btn-${variant}`) — the class would compile away.
 */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "btn-primary",
  destructive: "btn-error",
  outline: "btn-outline",
  secondary: "btn-neutral btn-soft",
  ghost: "btn-ghost",
  link: "btn-link",
};

/*
 * Sizes run one step smaller than daisyUI's defaults: this is a dense operations
 * console, so `sm` is the workhorse and `md` is reserved for primary actions.
 */
const SIZE_CLASS: Record<ButtonSize, string> = {
  default: "btn-sm",
  sm: "btn-xs",
  lg: "btn-md",
  icon: "btn-sm btn-square",
  "icon-sm": "btn-xs btn-square",
  "icon-lg": "btn-md btn-square",
};

export type ButtonProps = React.ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Render the single child element instead of a `<button>`, merging props onto
   * it. Retained from the previous Radix `Slot` API because ~100 call sites use
   * it to turn links into buttons; internally it becomes Base UI's `render`.
   */
  asChild?: boolean;
  /** Base UI's escape hatch: an element (or render function) to render as. */
  render?: useRender.RenderProp;
};

export function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  render,
  ...props
}: ButtonProps) {
  // `asChild` hands the child element to `render`; that element supplies its own
  // children, so they must not be spread onto it a second time.
  const { children, ...propsWithoutChildren } = props;
  const asChildElement =
    asChild && children ? (children as React.ReactElement) : undefined;

  return useRender({
    defaultTagName: "button",
    render: asChildElement ?? render,
    props: mergeProps<"button">(
      {
        className: cn(
          "btn",
          VARIANT_CLASS[variant],
          SIZE_CLASS[size],
          className,
        ),
      },
      asChildElement ? propsWithoutChildren : props,
    ),
  });
}
