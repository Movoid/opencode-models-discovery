import { ModelInfoFormat } from "../types/plugin-config.js"

const OPENAI_REASONING_PACKAGES = new Set([
  "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openai-compatible/responses",
  "@opencode/ai/providers/openai-compatible-responses",
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/chat",
  "@opencode/ai/providers/openai/responses",
  // OpenCode V2 also uses these specifiers when it migrates legacy npm config.
  "aisdk:@ai-sdk/openai",
  "aisdk:@ai-sdk/openai-compatible",
])

export function supportsOpenAIReasoning(specifier: string): boolean {
  return OPENAI_REASONING_PACKAGES.has(specifier)
}

export function usesModelsDevEfforts(specifier: string, config: ProviderDiscoveryOptions | undefined): boolean {
  return config?.modelInfoFormat === ModelInfoFormat.ModelsDev && supportsOpenAIReasoning(specifier)
}

export interface ModelFieldFilter {
  readonly field: string
  readonly equals?: string | number | boolean | null
  readonly match?: string
}

export interface ProviderDiscoveryOptions {
  readonly enabled: boolean
  readonly endpoint?: string
  readonly codexCatalog?: boolean
  readonly timeoutMs: number
  readonly includeRegex: RegExp[]
  readonly excludeRegex: RegExp[]
  readonly includeBy: ModelFieldFilter[]
  readonly excludeBy: ModelFieldFilter[]
  readonly smartModelName: boolean
  readonly modelInfoFormat?: ModelInfoFormat
  readonly modelInfoEndpoint?: string
  readonly filterNonChat: boolean
  readonly pruneMissing: boolean
  readonly cache?: {
    readonly enabled: boolean
    readonly ttlSeconds: number
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function regexes(value: unknown): RegExp[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((pattern) => {
    if (typeof pattern !== "string") return []
    try {
      return [new RegExp(pattern)]
    } catch {
      return []
    }
  })
}

function filters(value: unknown): ModelFieldFilter[] {
  if (!Array.isArray(value)) return []
  const result: ModelFieldFilter[] = []
  for (const filter of value) {
    const entry = object(filter)
    if (!entry || typeof entry.field !== "string") continue
    if (typeof entry.match === "string") {
      try {
        new RegExp(entry.match)
        result.push({ field: entry.field, match: entry.match })
      } catch {
        continue
      }
      continue
    }
    if (entry.equals === null || ["string", "number", "boolean"].includes(typeof entry.equals)) {
      result.push({ field: entry.field, equals: entry.equals as ModelFieldFilter["equals"] })
    }
  }
  return result
}

function isModelInfoFormat(value: unknown): value is ModelInfoFormat {
  return Object.values(ModelInfoFormat).includes(value as ModelInfoFormat)
}

export function parseProviderDiscoveryOptions(raw: unknown): ProviderDiscoveryOptions | undefined {
  const value = object(raw)
  if (!value) return undefined
  if (value.enabled !== true) return undefined

  const models = object(value.models)
  const codexCatalog = value.codexCatalog === true
  const endpoint = typeof value.endpoint === "string" && value.endpoint.startsWith("/")
    ? value.endpoint
    : codexCatalog ? undefined : "/v1/models"
  const timeoutMs = typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
    ? Math.max(1_000, Math.floor(value.timeoutMs))
    : 5_000

  const modelInfoFormat = isModelInfoFormat(value.modelInfoFormat) ? value.modelInfoFormat : undefined
  const modelInfoEndpoint = typeof value.modelInfoEndpoint === "string" && value.modelInfoEndpoint.trim().length > 0
    ? value.modelInfoEndpoint.trim()
    : undefined

  // Default filterNonChat to true when LiteLLM or ModelsDev is active, matching V1 behavior
  const filterNonChat = typeof value.filterNonChat === "boolean" ? value.filterNonChat : true
  const cacheValue = object(value.cache)
  const cache = cacheValue?.enabled === true
    ? {
        enabled: true,
        ttlSeconds: typeof cacheValue.ttlSeconds === "number" && Number.isFinite(cacheValue.ttlSeconds) && cacheValue.ttlSeconds > 0
          ? cacheValue.ttlSeconds
          : 86_400,
      }
    : undefined

  return {
    enabled: true,
    endpoint,
    ...(codexCatalog ? { codexCatalog: true } : {}),
    timeoutMs,
    includeRegex: regexes(models?.includeRegex),
    excludeRegex: regexes(models?.excludeRegex),
    includeBy: filters(models?.includeBy),
    excludeBy: filters(models?.excludeBy),
    smartModelName: value.smartModelName === true,
    modelInfoFormat,
    modelInfoEndpoint,
    filterNonChat,
    pruneMissing: value.pruneMissing === true,
    cache,
  }
}
