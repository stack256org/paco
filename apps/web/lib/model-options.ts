import {
  getProviderFromModelId,
  stripProviderPrefix,
} from "@/components/provider-icons";
import {
  APP_DEFAULT_MODEL_ID,
  type AvailableModel,
  type AvailableModelCost,
  getModelDisplayName,
} from "@/lib/models";

export interface ModelOption {
  id: string;
  label: string;
  shortLabel: string;
  description?: string;
  contextWindow?: number;
  cost?: AvailableModelCost;
  provider: string;
}

function toModelOption(model: AvailableModel): ModelOption {
  const label = getModelDisplayName(model);
  const provider = getProviderFromModelId(model.id);
  return {
    id: model.id,
    label,
    shortLabel: stripProviderPrefix(label, provider),
    description: model.description ?? undefined,
    contextWindow: model.context_window,
    ...(model.cost ? { cost: model.cost } : {}),
    provider,
  };
}

/**
 * The models the picker offers.
 *
 * One entry per Claude tier. Reasoning effort used to be folded in here as
 * extra "variant" entries, which meant the list mixed two different choices and
 * could only offer the model+effort pairings someone had named in advance.
 */
export function buildModelOptions(models: AvailableModel[]): ModelOption[] {
  return models.map(toModelOption);
}

export function getDefaultModelOptionId(modelOptions: ModelOption[]): string {
  if (modelOptions.some((option) => option.id === APP_DEFAULT_MODEL_ID)) {
    return APP_DEFAULT_MODEL_ID;
  }

  return modelOptions[0]?.id ?? APP_DEFAULT_MODEL_ID;
}
