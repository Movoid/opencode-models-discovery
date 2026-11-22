import { inlineFormatLimits, type ModelEnricher } from '../../core/model-enrichment'
import type { ModelLimitDraft } from '../../core/model-types'

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function getModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const supportedModalities = new Set(['text', 'audio', 'image', 'video', 'pdf'])
  const modalities = [...new Set(value
    .filter((modality): modality is string => typeof modality === 'string')
    .map((modality) => modality.trim().toLowerCase())
    .map((modality) => modality === 'speech' ? 'audio' : modality)
    .filter((modality) => supportedModalities.has(modality)))]
  return modalities.length > 0 ? modalities : undefined
}

const SUPPORTED_REASONING_TIERS: Record<string, true> = {
  none: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

function getReasoningVariants(rawModel: Record<string, unknown>): Record<string, { reasoningEffort: string }> | undefined {
  const reasoning = rawModel.reasoning
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) return undefined

  const block = reasoning as Record<string, unknown>
  if (!Array.isArray(block.supported_efforts) || block.supported_efforts.length === 0) return undefined

  const variants: Record<string, { reasoningEffort: string }> = {}
  for (const tier of block.supported_efforts) {
    if (typeof tier !== 'string') continue
    const normalized = tier.trim().toLowerCase()
    if (!SUPPORTED_REASONING_TIERS[normalized] || variants[normalized]) continue
    variants[normalized] = { reasoningEffort: normalized }
  }

  return Object.keys(variants).length > 0 ? variants : undefined
}

export function createBifrostEnricher(_data: unknown): ModelEnricher {
  return {
    enrich(model, options) {
      const result: {
        metadataName?: string
        limit?: ModelLimitDraft
        modalities?: { input?: string[]; output?: string[] }
        cost?: { input: number; output: number }
        reasoning?: boolean
        variants?: Record<string, { reasoningEffort: string }>
      } = {}

      const limit = inlineFormatLimits(model, options)
      if (limit) result.limit = limit

      const name = model.normalized_name
      if (typeof name === 'string' && name.length > 0) result.metadataName = name

      const architecture = model.architecture
      if (architecture && typeof architecture === 'object' && !Array.isArray(architecture)) {
        const inputModalities = getModalities((architecture as Record<string, unknown>).input_modalities)
        const outputModalities = getModalities((architecture as Record<string, unknown>).output_modalities)
        if (inputModalities || outputModalities) {
          result.modalities = {
            ...(inputModalities ? { input: inputModalities } : {}),
            ...(outputModalities ? { output: outputModalities } : {}),
          }
        }
      }

      const pricing = model.pricing
      if (pricing && typeof pricing === 'object' && !Array.isArray(pricing)) {
        const inputCost = parseNonNegativeNumber((pricing as Record<string, unknown>).prompt)
        const outputCost = parseNonNegativeNumber((pricing as Record<string, unknown>).completion)
        if (inputCost !== undefined && outputCost !== undefined) {
          result.cost = { input: inputCost * 1_000_000, output: outputCost * 1_000_000 }
        }
      }

      const variants = getReasoningVariants(model as Record<string, unknown>)
      if (variants) {
        result.reasoning = true
        result.variants = variants
      }

      return result
    },
  }
}
