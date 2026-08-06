"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { buildModelOptions, type ModelOption } from "@/lib/model-options";
import type { AvailableModel } from "@/lib/models";
import { fetcher } from "@/lib/swr";

interface ModelsResponse {
  models: AvailableModel[];
}

interface UseModelOptionsConfig {
  initialModelOptions?: ModelOption[];
}

const EMPTY_MODELS: AvailableModel[] = [];
const EMPTY_MODEL_OPTIONS: ModelOption[] = [];

/**
 * The models offered in the picker: the three Claude tiers, nothing else.
 *
 * This used to also fetch "model variants" and splice them into the same list,
 * so the dropdown mixed tiers with named model+effort pairings. Effort is its
 * own control now, which leaves this a single request.
 */
export function useModelOptions(config: UseModelOptionsConfig = {}) {
  const { data, error, isLoading } = useSWR<ModelsResponse>(
    "/api/models",
    fetcher,
  );

  const models = data?.models ?? EMPTY_MODELS;
  const initialModelOptions = config.initialModelOptions ?? EMPTY_MODEL_OPTIONS;

  const fetchedModelOptions = useMemo<ModelOption[]>(
    () => buildModelOptions(models),
    [models],
  );

  const modelOptions =
    data !== undefined || initialModelOptions.length === 0
      ? fetchedModelOptions
      : initialModelOptions;

  return {
    modelOptions,
    models,
    loading:
      initialModelOptions.length === 0 && data === undefined && isLoading,
    error: error?.message ?? null,
  };
}
