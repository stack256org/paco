import {
  getProviderDisplayName,
  getProviderFromModelId,
} from "@/components/provider-icons";

/** Providers pinned to the top of a grouped model list. */
const PRIORITY_PROVIDERS = ["anthropic", "openai"];

export interface ModelProviderGroup<T> {
  /** The provider key — `anthropic`, `poolside`, … */
  provider: string;
  /** The heading to render — `getProviderDisplayName`'s answer. */
  label: string;
  options: T[];
}

/**
 * Split a list of models into one group per provider, headed by that
 * provider's display name.
 *
 * Shared by both pickers rather than living in one of them, because the
 * compact composer picker had a hardcoded `heading="Anthropic"` while the
 * settings combobox grouped properly — so a Poolside chat listed
 * `poolside/laguna-*` under "Anthropic". One implementation is what makes
 * the two agree by construction; nothing here knows a vendor's name.
 *
 * `item.provider` wins over the id when present (`ModelOption` computes it
 * once, at `buildModelOptions` time); otherwise the id is parsed. An
 * unprefixed Claude tier alias — `opus`, `sonnet`, `haiku` — answers
 * `anthropic` either way: see `getProviderFromModelId`'s own note on why the
 * alias must not become its own "provider".
 *
 * Order is stable: priority providers first in the order listed, then the
 * rest alphabetically, and within a group the input order is preserved so
 * the catalog's own tier ordering (opus, sonnet, haiku) survives.
 */
export function groupModelsByProvider<
  T extends { id: string; provider?: string },
>(items: T[]): ModelProviderGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const provider = item.provider ?? getProviderFromModelId(item.id);
    const existing = groups.get(provider);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(provider, [item]);
    }
  }

  const providers = [...groups.keys()].sort((a, b) => {
    const aIdx = PRIORITY_PROVIDERS.indexOf(a);
    const bIdx = PRIORITY_PROVIDERS.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) {
      return aIdx - bIdx;
    }
    if (aIdx !== -1) {
      return -1;
    }
    if (bIdx !== -1) {
      return 1;
    }
    return a.localeCompare(b);
  });

  return providers.map((provider) => ({
    provider,
    label: getProviderDisplayName(provider),
    options: groups.get(provider) ?? [],
  }));
}
