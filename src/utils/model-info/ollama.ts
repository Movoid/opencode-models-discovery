import { enrichmentLimits, type ModelEnricher, type ModelEnricherDeferredContext } from '../../core/model-enrichment'
import type { ModelLimitDraft } from '../../core/model-types'
import { buildModelInfoURL } from '../../core/model-info-url'

export const DEFAULT_OLLAMA_ENDPOINT = '/api/show'
export const DEFAULT_OLLAMA_CONCURRENCY = 4
const DEFAULT_OLLAMA_TIMEOUT_MS = 5000

interface ParsedOllamaMetadata {
  readonly runtimeContext?: number
  readonly fallbackContext?: number
  readonly capabilities: ReadonlySet<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function parseCapabilities(value: unknown): ReadonlySet<string> {
  const capabilities = new Set<string>()
  if (!Array.isArray(value)) return capabilities

  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      capabilities.add(entry.trim().toLowerCase())
    }
  }
  return capabilities
}

/**
 * Reads a complete num_ctx value from a Modelfile-style parameters line.
 * Retains the existing supported forms: "num_ctx 4096",
 * "num_ctx: 8192", and "\"num_ctx\": 16384".
 */
function parseNumCtx(parameters: unknown): number | undefined {
  if (isRecord(parameters)) {
    return positiveNumber(parameters.num_ctx)
  }
  if (typeof parameters !== 'string') return undefined

  const match = parameters.match(/^[ \t]*"?num_ctx"?[ \t]*[:=]?[ \t]*(\d+)[ \t]*\r?$/im)
  return match ? positiveNumber(Number(match[1])) : undefined
}

/**
 * Resolves a fallback when the model parameters do not specify num_ctx:
 * model_info.<architecture>.context_length, any *.context_length, then
 * the top-level context_length field some providers expose.
 */
function resolveFallbackContext(show: Record<string, unknown>): number | undefined {
  const modelInfo = isRecord(show.model_info) ? show.model_info : undefined
  if (modelInfo) {
    const architecture = typeof modelInfo['general.architecture'] === 'string'
      ? modelInfo['general.architecture']
      : undefined
    const family = isRecord(show.details) && typeof show.details.family === 'string'
      ? show.details.family
      : undefined

    for (const name of [architecture, family]) {
      if (!name) continue
      const value = positiveNumber(modelInfo[`${name}.context_length`])
      if (value) return value
    }

    let fallback: number | undefined
    for (const [key, value] of Object.entries(modelInfo)) {
      if (!key.endsWith('.context_length')) continue
      const candidate = positiveNumber(value)
      if (candidate && (fallback === undefined || candidate > fallback)) {
        fallback = candidate
      }
    }
    if (fallback) return fallback
  }

  return positiveNumber(show.context_length)
}

function parseShow(value: unknown): ParsedOllamaMetadata | undefined {
  if (!isRecord(value)) return undefined

  const capabilities = parseCapabilities(value.capabilities)
  const runtimeContext = parseNumCtx(value.parameters)
  const fallbackContext = runtimeContext === undefined ? resolveFallbackContext(value) : undefined
  if (runtimeContext === undefined && fallbackContext === undefined && capabilities.size === 0) return undefined

  return { runtimeContext, fallbackContext, capabilities }
}

/**
 * Creates a deferred enricher backed by Ollama's POST /api/show endpoint.
 *
 * The enricher does not make requests at resolution time. prepare() performs
 * bounded-concurrency per-model requests after the provider model list is
 * known; enrich() is a synchronous lookup. Per-model failures are ignored so
 * discovery always continues.
 */
export function createOllamaEnricher(options: ModelEnricherDeferredContext): ModelEnricher {
  const metadata = new Map<string, ParsedOllamaMetadata>()
  const showUrl = buildModelInfoURL(options.baseURL, options.endpoint ?? DEFAULT_OLLAMA_ENDPOINT)
  const fetcher = options.fetcher ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS
  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' })
  if (options.apiKey) headers.set('authorization', `Bearer ${options.apiKey}`)

  async function fetchShow(modelId: string): Promise<ParsedOllamaMetadata | undefined> {
    try {
      const response = await fetcher(showUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelId }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        options.logger?.warn('Ollama model info discovery failed', {
          endpoint: showUrl,
          modelId,
          status: response.status,
        })
        return undefined
      }
      return parseShow(await response.json())
    } catch (error) {
      options.logger?.warn('Ollama model info discovery failed', {
        endpoint: showUrl,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  return {
    async prepare(modelIds) {
      const ids = [...new Set(modelIds)].filter((id) => id.length > 0 && !metadata.has(id))
      let cursor = 0

      const worker = async (): Promise<void> => {
        while (cursor < ids.length) {
          const modelId = ids[cursor++]
          const parsed = await fetchShow(modelId)
          if (parsed) metadata.set(modelId, parsed)
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(DEFAULT_OLLAMA_CONCURRENCY, ids.length) }, () => worker()),
      )
    },

    enrich(model, context) {
      const parsed = metadata.get(model.id)
      if (!parsed) return {}

      const capabilities = parsed.capabilities
      if (context.filterNonChat && capabilities.has('embedding') && !capabilities.has('completion')) {
        return { skip: true }
      }

      const result: {
        limit?: ModelLimitDraft
        fallbackLimit?: ModelLimitDraft
        modalities?: { input: string[]; output: string[] }
        reasoning?: boolean
        toolCall?: boolean
      } = {}

      if (context.deferLimitNormalization && parsed.fallbackContext !== undefined) {
        result.fallbackLimit = { context: parsed.fallbackContext }
      } else {
        const limits = enrichmentLimits(context, parsed.runtimeContext ?? parsed.fallbackContext)
        if (limits) result.limit = limits
      }

      const input = ['text']
      if (capabilities.has('vision') || capabilities.has('images')) input.push('image')
      if (capabilities.has('audio')) input.push('audio')
      if (input.length > 1) result.modalities = { input, output: ['text'] }

      if (capabilities.has('thinking')) result.reasoning = true
      if (capabilities.has('tools') || capabilities.has('function_calling') || capabilities.has('tool_calling')) {
        result.toolCall = true
      }

      return result
    },
  }
}
