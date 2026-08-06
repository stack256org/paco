"use client";

import { SearchIcon } from "lucide-react";
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Filterable command list.
 *
 * This replaces `cmdk`. The exported parts and the props the eight pickers use —
 * `heading` on a group, `onSelect` on an item, `placeholder` on the input — are
 * unchanged, so none of them needed editing.
 *
 * Filtering and keyboard navigation are implemented here rather than delegated:
 * every consumer is a "type to narrow a list, arrow to choose" picker, and that
 * is a context, a substring match, and an active index. Base UI's Combobox is
 * built around a committed *value*, which is a different contract from these
 * action lists.
 */

interface RegisteredItem {
  text: string;
  disabled: boolean;
  onSelect?: (value: string) => void;
  value: string;
}

interface CommandContextValue {
  search: string;
  setSearch: (value: string) => void;
  /** Items register so the root can drive keyboard navigation and empty state. */
  register: (id: string, item: RegisteredItem) => void;
  unregister: (id: string) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  matchCount: number;
  matches: (text: string) => boolean;
}

const CommandContext = React.createContext<CommandContextValue | null>(null);

function useCommand(): CommandContextValue {
  const context = React.useContext(CommandContext);
  if (!context) {
    throw new Error("Command parts must be rendered inside <Command>");
  }
  return context;
}

/** Case- and whitespace-insensitive substring match, as cmdk did. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function Command({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const [search, setSearch] = React.useState("");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const itemsRef = React.useRef(new Map<string, RegisteredItem>());
  const [itemVersion, setItemVersion] = React.useState(0);

  const register = React.useCallback((id: string, item: RegisteredItem) => {
    itemsRef.current.set(id, item);
    setItemVersion((version) => version + 1);
  }, []);

  const unregister = React.useCallback((id: string) => {
    itemsRef.current.delete(id);
    setItemVersion((version) => version + 1);
  }, []);

  const matches = React.useCallback(
    (text: string) => {
      const query = normalize(search);
      return query === "" || normalize(text).includes(query);
    },
    [search],
  );

  // Recomputed when items or the query change; drives empty state and arrow keys.
  const visible = React.useMemo(() => {
    void itemVersion;
    return [...itemsRef.current.entries()]
      .filter(([, item]) => !item.disabled && matches(item.text))
      .map(([id]) => id);
  }, [itemVersion, matches]);

  // Keep the highlight on a row that is still on screen.
  React.useEffect(() => {
    if (visible.length === 0) {
      setActiveId(null);
      return;
    }
    setActiveId((current) =>
      current && visible.includes(current) ? current : visible[0],
    );
  }, [visible]);

  const context: CommandContextValue = {
    search,
    setSearch,
    register,
    unregister,
    activeId,
    setActiveId,
    matchCount: visible.length,
    matches,
  };

  const move = (delta: number) => {
    if (visible.length === 0) {
      return;
    }
    const index = activeId ? visible.indexOf(activeId) : -1;
    // Wraps, so holding an arrow key cannot dead-end.
    setActiveId(visible[(index + delta + visible.length) % visible.length]);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter" && activeId) {
      const item = itemsRef.current.get(activeId);
      if (item && !item.disabled) {
        event.preventDefault();
        item.onSelect?.(item.value);
      }
    }
  };

  return (
    <CommandContext value={context}>
      {/* The container owns arrow-key navigation for the options it holds,
          which is the listbox keyboard contract. */}
      <div
        className={cn(
          "flex h-full w-full flex-col overflow-hidden bg-base-100 text-base-content",
          className,
        )}
        onKeyDown={onKeyDown}
        role="listbox"
        tabIndex={-1}
        {...props}
      >
        {children}
      </div>
    </CommandContext>
  );
}

export function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  children?: React.ReactNode;
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn("overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({
  className,
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<"input">, "value" | "onChange"> & {
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const { search, setSearch } = useCommand();

  return (
    <div className="flex h-10 items-center gap-2 border-b border-base-300 px-3">
      <SearchIcon aria-hidden="true" className="size-4 shrink-0 opacity-50" />
      <input
        // The visible placeholder is decorative; screen readers need a name, and
        // the field has no visible label because the search icon carries the
        // meaning visually.
        aria-label={props.placeholder ?? "Search"}
        // The browser must not autocomplete over the list this is filtering.
        autoComplete="off"
        className={cn(
          "h-9 w-full bg-transparent text-sm outline-none placeholder:text-base-content/50 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        onChange={(event) => {
          setSearch(event.target.value);
          onValueChange?.(event.target.value);
        }}
        value={value ?? search}
        {...props}
      />
    </div>
  );
}

export function CommandList({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-y-auto overflow-x-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { matchCount } = useCommand();
  if (matchCount > 0) {
    return null;
  }
  return (
    <div
      className={cn("py-6 text-center text-sm text-base-content/60", className)}
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  heading,
  children,
  ...props
}: React.ComponentProps<"div"> & { heading?: React.ReactNode }) {
  return (
    <div className={cn("p-1", className)} {...props}>
      {heading ? (
        <div className="px-2 py-1.5 text-xs font-medium text-base-content/60">
          {heading}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("-mx-1 h-px bg-base-300", className)} {...props} />;
}

export function CommandItem({
  className,
  children,
  value,
  disabled = false,
  onSelect,
  ...props
}: Omit<React.ComponentProps<"button">, "onSelect" | "type"> & {
  value?: string;
  disabled?: boolean;
  onSelect?: (value: string) => void;
}) {
  const { register, unregister, activeId, setActiveId, matches } = useCommand();
  const id = React.useId();
  const ref = React.useRef<HTMLButtonElement>(null);

  // Filter on the visible label, which is what cmdk matched against.
  const text =
    value ??
    (typeof children === "string" ? children : (ref.current?.textContent ?? ""));

  React.useEffect(() => {
    register(id, { text, disabled, onSelect, value: value ?? text });
    return () => unregister(id);
  }, [id, text, disabled, onSelect, value, register, unregister]);

  const active = activeId === id;

  // Keep the highlighted row in view while arrowing through a long list.
  React.useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  if (!matches(text)) {
    return null;
  }

  return (
    <button
      aria-selected={active}
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
        active && "bg-base-200",
        disabled && "pointer-events-none opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      disabled={disabled}
      onClick={() => onSelect?.(value ?? text)}
      onPointerMove={() => setActiveId(id)}
      ref={ref}
      role="option"
      tabIndex={-1}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-base-content/60",
        className,
      )}
      {...props}
    />
  );
}
