import { Waves } from "lucide-react";
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function AnthropicIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" {...props}>
      <path
        fill="#D97757"
        d="m3.14 10.61 3.15-1.76.05-.15-.05-.09h-.16l-.52-.03-1.8-.05-1.56-.06-1.51-.08-.38-.09L0 7.84l.04-.24.32-.21.45.04 1.02.07 1.52.1 1.1.07 1.63.17h.26l.04-.1-.1-.07-.06-.07-1.57-1.06-1.7-1.12-.9-.65-.48-.33-.24-.3-.1-.67.43-.48.59.04.15.04.6.45 1.27.99 1.66 1.21.24.2.1-.06V5.8l-.1-.18L5.27 4 4.3 2.35l-.43-.7-.11-.4a2 2 0 0 1-.07-.49l.5-.67.27-.09.67.09.28.24.41.94.67 1.48 1.04 2.02.3.6.16.55.06.17h.1v-.1l.1-1.13.15-1.4.15-1.79.06-.5.25-.6.5-.34.39.19.32.46-.05.3-.19 1.22-.37 1.93-.24 1.3h.14l.16-.17.66-.87 1.1-1.37.48-.54.57-.6.36-.3h.7l.5.76-.23.77-.7.9-.6.76-.84 1.13L11 7l.05.08.12-.02 1.9-.4 1.03-.18 1.23-.21.56.25.06.27-.22.53-1.31.33-1.54.3-2.3.54-.02.02.03.04 1.03.1.44.03h1.08l2.02.15.52.34.32.43-.05.32-.81.41-1.1-.26-2.55-.6-.87-.22h-.12v.07l.72.71 1.34 1.2 1.67 1.56.09.38-.22.3-.22-.03-1.47-1.1-.57-.5-1.28-1.08h-.09v.12l.3.43 1.56 2.34.08.72-.11.23-.4.14-.45-.08-.92-1.28-.94-1.44-.76-1.29-.1.05-.45 4.83-.2.24-.5.19-.4-.3-.21-.5.21-.99.26-1.28.21-1.01.2-1.27.1-.42v-.02h-.1L6.9 11.5l-1.46 1.95-1.15 1.23-.27.11-.48-.25.04-.44.27-.39 1.6-2.02.95-1.25.62-.72v-.1h-.04l-4.23 2.73-.75.1-.32-.3.04-.5.15-.16z"
      />
    </svg>
  );
}

/**
 * Poolside's mark: water, not their logo.
 *
 * Lucide's `Waves`, the set every other glyph in these pickers comes from, so
 * it carries the same stroke weight and stays legible at the `size-3.5` the
 * compact trigger renders it at — a hand-drawn pool-ladder mark collapsed
 * into a blob at that size. It inherits `currentColor`, so it takes the
 * trigger's muted colour and the list's opacity with no per-theme treatment.
 * Anthropic's is the one icon here carrying a fixed brand colour, which is
 * the daisyUI skill's own exception for an SVG that must not change with the
 * theme.
 */
function PoolsideIcon(props: IconProps) {
  return <Waves {...props} />;
}

function DefaultProviderIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  );
}

const providerIconMap: Record<string, React.FC<IconProps>> = {
  anthropic: AnthropicIcon,
  poolside: PoolsideIcon,
};

const providerDisplayNames: Record<string, string> = {
  anthropic: "Anthropic",
  poolside: "Poolside",
};

/**
 * Prefixes in model display names that match the provider brand (stripped in
 * compact UI).
 *
 * Poolside is deliberately absent. Its labels are "Laguna S" and "Laguna XS",
 * and "Laguna" is the model family, not the vendor: stripping it would leave
 * a trigger reading "S" and a list of "S" and "XS". The rule this table
 * encodes is "drop the word that only repeats the provider icon beside it",
 * and no Poolside label does that.
 */
const providerLabelPrefixes: Record<string, string[]> = {
  anthropic: ["Claude"],
};

/**
 * The provider behind a model id.
 *
 * Paco's own ids are bare tier aliases — `opus`, `sonnet`, `haiku` — which the
 * Claude Code CLI resolves. They carry no provider prefix, and returning the
 * alias itself made the picker group models under headings named "Opus" and
 * "Sonnet" as though those were vendors. Everything Paco runs is Anthropic, so
 * an unprefixed id says so. The `provider/model` form is still parsed, for ids
 * that arrive already qualified.
 */
export function getProviderFromModelId(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  if (slashIndex === -1) return "anthropic";
  return modelId.slice(0, slashIndex);
}

/**
 * Strip the provider brand prefix from a model label for compact display.
 * e.g. "Claude Opus 4.6" → "Opus 4.6", "GPT-5.4" → "GPT-5.4"
 */
export function stripProviderPrefix(label: string, provider: string): string {
  const prefixes = providerLabelPrefixes[provider];
  if (!prefixes) return label;
  for (const prefix of prefixes) {
    if (label.startsWith(prefix + " ")) {
      return label.slice(prefix.length + 1);
    }
  }
  return label;
}

export function getProviderDisplayName(provider: string): string {
  return (
    providerDisplayNames[provider] ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

interface ProviderIconProps extends IconProps {
  provider: string;
}

export function ProviderIcon({ provider, ...props }: ProviderIconProps) {
  const Icon = providerIconMap[provider] ?? DefaultProviderIcon;
  return <Icon {...props} />;
}
