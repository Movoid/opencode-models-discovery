import { enrichmentLimits, type ModelEnricher } from '../../core/model-enrichment'

function hasUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function createVLLMEnricher(_data: unknown): ModelEnricher {
  return {
    enrich(model, options) {
      const maxModelLen = model.max_model_len
      if (hasUsableNumber(maxModelLen)) {
        // vLLM reports only max_model_len, which describes the whole window
        // shared by input and output. Treat it as the context limit and let
        // the final limit normalization bound output to the default token
        // limit, matching the LM Studio enricher, so hosts do not reserve
        // the entire context for output tokens and reject requests that
        // exceed it after token accounting.
        const limits = enrichmentLimits(options, maxModelLen)
        if (limits) return { limit: limits }
      }
      return {}
    },
  }
}
