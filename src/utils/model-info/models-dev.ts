import { DEFAULT_MODELS_DEV_URL, MODELS_DEV_PROVIDER_URL, fetchModelsDevCatalog, lookupModelsDevData, readModelsDevMetadata } from '../models-dev-fetcher'
import { advertisedListLimits, enrichmentLimits, type ModelEnricher } from '../../core/model-enrichment'

type ReasoningVariants = { id: string; settings: { reasoningEffort: string } }[]

export function createModelsDevEnricher(data: unknown, variantsFor?: (id: string) => ReasoningVariants | undefined): ModelEnricher {
  const cache = data instanceof Map ? data as Map<string, Record<string, unknown>> : undefined
  return {
    enrich(model, options) {
      const row = cache && lookupModelsDevData(model.id, cache)
      const info = row && readModelsDevMetadata(row)
      const ref = info?.limit
      // In V2 composition this adapter supplies only reference fields. V1/native
      // retain their original inline precedence and input-as-context fallback.
      const count = (n: unknown) => typeof n === 'number' && n > 0 && Number.isFinite(n) ? n : undefined
      const inline = options.deferLimitNormalization ? undefined : advertisedListLimits(model, count)
      const limits = options.deferLimitNormalization
        ? enrichmentLimits(options, ref?.context, ref?.output, ref?.input)
        : enrichmentLimits(options, inline?.context ?? count(ref?.context) ?? ref?.input, inline?.output ?? ref?.output, ref?.input)
      const variants = variantsFor?.(model.id)
      return {
        metadataName: info?.name,
        ...(limits ? options.deferLimitNormalization ? { fallbackLimit: limits } : { limit: limits } : {}),
        ...(typeof info?.attachment === 'boolean' ? { attachment: info.attachment } : {}),
        ...(typeof info?.reasoning === 'boolean' ? { reasoning: info.reasoning } : {}),
        ...(typeof info?.tool_call === 'boolean' ? { toolCall: info.tool_call } : {}),
        ...(typeof info?.structured_output === 'boolean' ? { structuredOutput: info.structured_output } : {}),
        ...(typeof info?.temperature === 'boolean' ? { temperature: info.temperature } : {}),
        ...(info?.modalities ? { modalities: info.modalities } : {}),
        ...(variants ? { variants } : {}),
      }
    },
  }
}

/** The flat catalog provides canonical IDs and limits; the provider catalog supplies effort choices. */
export async function loadOpenAIModelsDevEnricher(
  endpoint = DEFAULT_MODELS_DEV_URL, privateFetcher?: typeof fetch,
) {
  const [reference, supplemental] = await Promise.all([
    fetchModelsDevCatalog(endpoint, privateFetcher),
    !privateFetcher && endpoint === DEFAULT_MODELS_DEV_URL ? fetchModelsDevCatalog(MODELS_DEV_PROVIDER_URL, undefined, 'efforts') : undefined,
  ])
  function variantsFor(id: string): ReasoningVariants | undefined {
    let key: string | null | undefined = id
    if (!id.includes('/')) {
      if (!reference) return undefined // A missing snapshot cannot establish absence.
      key = reference.bareID(id)
      if (key === undefined) key = supplemental?.bareID(id)
    }
    const efforts = key == null ? undefined : reference?.effortsFor(key) ?? supplemental?.effortsFor(key)
    // An explicit empty/default-only declaration blocks the secondary source,
    // but does not suppress ordinary reasoning defaults.
    return efforts?.length ? efforts.map(id => ({ id, settings: { reasoningEffort: id } })) : undefined
  }
  return createModelsDevEnricher(reference?.models, variantsFor)
}
