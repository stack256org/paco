"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useThemePreference } from "@/hooks/use-theme-preference";
import type { ThemePreference } from "@/lib/theme";

const OPTIONS: readonly {
  value: ThemePreference;
  label: string;
  Icon: typeof Monitor;
}[] = [
  { value: "system", label: "Match system theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
];

/*
 * Written out in full rather than interpolated: Tailwind only sees class names
 * it can find as complete literals, so a composed string risks the variant
 * being absent from the build.
 */
const BUTTON_CLASS = "btn btn-ghost join-item btn-xs px-2";
const BUTTON_CLASS_ACTIVE = "btn btn-ghost join-item btn-xs px-2 btn-active";

/**
 * Three-way theme control: system, light, dark.
 *
 * "system" is expressed by removing `data-theme` and letting daisyUI's
 * `prefersdark` resolve it in CSS, so this control never has to follow the OS
 * itself — no `matchMedia` listener, and the OS can change while the page is
 * open. The buttons track the stored *preference*, so "system" stays selected
 * on a dark-mode machine instead of appearing to be "dark".
 */
export function ThemeToggle() {
  const { preference, setPreference } = useThemePreference();

  return (
    <fieldset className="join">
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          aria-label={label}
          aria-pressed={preference === value}
          className={preference === value ? BUTTON_CLASS_ACTIVE : BUTTON_CLASS}
          key={value}
          onClick={() => setPreference(value)}
          type="button"
        >
          <Icon aria-hidden="true" className="size-3.5" />
        </button>
      ))}
    </fieldset>
  );
}
