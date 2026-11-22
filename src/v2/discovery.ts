/* eslint-disable no-console */
import { type ConfiguredProvider, type DiscoveredV2Model, type Inventory } from "./catalog.js"
import { supportsOpenAIReasoning, usesModelsDevEfforts, type ProviderDiscoveryOptions } from "./provider-config.js"
import { mapToDiscoveredV2Model } from "../core/model-mapper.js"
import { discoverModelDrafts } from "../core/discovery-pipeline.js"
import { isDiscoveredRawModel, type DiscoveredRawModel } from "../core/model-types.js"
import { prepareModelEnricher, type ModelEnrichmentResult, type ModelEnricher } from "../core/model-enrichment.js"
import { createDiscoveryCacheEntry, discoveryCacheKey, readDiscoveryCache, writeDiscoveryCache, type DiscoveryCacheBackend, type DiscoveryCacheEntry, type DiscoveryCacheIdentity } from "../core/discovery-cache.js"
import { resolveModelInfoEnricher } from "../core/enricher-resolver.js"
import { createModelsDevEnricher, loadOpenAIModelsDevEnricher } from "../utils/model-info/models-dev.js"
import { createAIProxyEnricher } from "../utils/model-info/aiproxy.js"
import { fetchModelsDevCatalog } from "../utils/models-dev-fetcher.js"
import { ModelInfoFormat } from "../types/plugin-config.js"
import { fetchCodexCatalog, composeOpenAIMetadata } from "./codex-catalog.js"

export interface DiscoveryLogger {
  warn(message: string, context?: Record<string, unknown>): void
  info?(message: string, context?: Record<string, unknown>): void
  debug?(message: string, context?: Record<string, unknown>): void
  error?(message: string, context?: Record<string, unknown>): void
}

const defaultLogger: DiscoveryLogger = {
  warn(message, context) {
    if (context && Object.keys(context).length > 0) {
      console.warn(`[opencode-models-discovery] ${message}`, context)
    } else {
      console.warn(`[opencode-models-discovery] ${message}`)
    }
  },
  info(message, context) {
    if (context && Object.keys(context).length > 0) {
      console.info(`[opencode-models-discovery] ${message}`, context)
    } else {
      console.info(`[opencode-models-discovery] ${message}`)
    }
  },
}

function cachedEnricher(
  enrichments: Record<string, ModelEnrichmentResult>, ignoreVariants: boolean,
): ModelEnricher {
  return {
    enrich(model) {
      const result = enrichments[model.id] ?? {}
      return ignoreVariants ? { ...result, variants: undefined } : result
    },
  }
}

function isGatewayURL(target: URL, origin: string): boolean {
  return target.origin === origin && !target.username && !target.password
}

function withGatewayPolicy(fetcher: typeof fetch, origin: string, key?: string): typeof fetch {
  return (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input)
    if (!isGatewayURL(target, origin)) return fetcher(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (key) headers.set("authorization", "Bearer " + key)
    else headers.delete("authorization")
    return fetcher(input, { ...init, headers, redirect: "error" })
  }
}

function gatewayReferenceURL(endpoint: string | undefined, origin: string): string | undefined {
  if (!endpoint || !/^(https?:[/][/]|[/])/i.test(endpoint)) return undefined
  try {
    const target = new URL(endpoint, origin)
    if (isGatewayURL(target, origin)) return target.href
  } catch { /* Invalid overrides follow the existing anonymous fallback. */ }
  return undefined
}

function trimmedKey(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined
}

export interface OrdinaryListSnapshot {
  readonly baseURL: string
  readonly endpoint: string
  readonly rows: readonly DiscoveredRawModel[]
}

// A legacy inventory had provider-scoped fallback. Field-local limits also depend on their source.
export type InventoryFallbackIdentity = "legacy" | DiscoveryCacheIdentity

export async function discoverInventory(
  providers: readonly ConfiguredProvider[],
  discovery: ReadonlyMap<string, ProviderDiscoveryOptions>,
  fetcher: typeof fetch = fetch,
  storage?: DiscoveryCacheBackend,
  options?: {
    readonly force?: boolean
    readonly logger?: DiscoveryLogger
    readonly ordinaryLists?: Map<string, OrdinaryListSnapshot>
    readonly fallbackIdentities?: Map<string, InventoryFallbackIdentity>
    /** Provider sources before named efforts are applied to newly discovered models. */
    readonly ordinarySources?: Inventory
  },
): Promise<Inventory> {
  const inventory: Inventory = new Map()
  const logger = options?.logger ?? defaultLogger
  const ordinaryLists = options?.ordinaryLists

  await Promise.all(providers.map(async (provider) => {
    const config = discovery.get(provider.id)
    if (!config) return
    const codexMode = config.codexCatalog === true
    const openAIEfforts = supportsOpenAIReasoning(provider.package)
    const compose = codexMode || (config.modelInfoFormat !== undefined && openAIEfforts)
    const modelsDevFormat = config.modelInfoFormat === ModelInfoFormat.ModelsDev
    const withModelsDevEfforts = usesModelsDevEfforts(provider.package, config)
    const providerContext = { provider: provider.id }

    const baseURL = typeof provider.settings.baseURL === "string" ? provider.settings.baseURL : undefined
    const endpoint = config.endpoint ?? "/v1/models"
    const lastList = ordinaryLists?.get(provider.id)
    // Only the named-effort path retains raw rows, so it can reproject under
    // current settings without reusing old variants. Do not cross endpoints.
    const previousRows = !codexMode && lastList && lastList.baseURL === baseURL && lastList.endpoint === endpoint
      ? lastList.rows : undefined
    if (!previousRows) ordinaryLists?.delete(provider.id)
    if (!compose) options?.fallbackIdentities?.set(provider.id, "legacy")
    if (!baseURL) {
      logger.warn(`Model discovery skipped for provider "${provider.id}": missing or invalid settings.baseURL`, {
        provider: provider.id,
      })
      return
    }

    const cacheConfig = config.cache
    // Account-scoped catalogs must not use the ordinary per-provider cache.
    const cacheSupported = !codexMode && cacheConfig?.enabled === true && storage !== undefined
    const cacheKey = discoveryCacheKey("opencode.models-discovery.v2", provider.id)
    const cacheIdentity = {
      providerID: provider.id,
      baseURL,
      endpoint,
      modelInfoFormat: config.modelInfoFormat,
      modelInfoEndpoint: config.modelInfoEndpoint,
      limitComposition: compose ? "field-local" as const : undefined,
    }
    if (compose && !codexMode && !withModelsDevEfforts) options?.fallbackIdentities?.set(provider.id, cacheIdentity)
    const cached: DiscoveryCacheEntry | undefined = cacheSupported && !options?.force
      ? await readDiscoveryCache(storage, cacheKey, cacheIdentity, cacheConfig.ttlSeconds)
      : undefined

    const key = codexMode ? provider.apiKey : trimmedKey(provider.apiKey) ?? trimmedKey(provider.settings.apiKey)

    if (key === null) {
      logger.warn("Codex catalog discovery skipped: gateway credentials are unavailable or unsupported", providerContext)
      return
    }

    let url: string | undefined
    const discoveryError = (error: unknown): undefined => {
      logger.warn(`Model discovery error for provider "${provider.id}"`, {
        provider: provider.id,
        ...(!codexMode ? { url, error: error instanceof Error ? error.message : String(error) } : {}),
      })
      return undefined
    }
    try {
      const base = new URL(baseURL)
      // Native packages concatenate their request path to baseURL. A query or
      // fragment anywhere in the base would instead swallow that request path.
      if (codexMode && /[?#]/.test(base.href)) {
        logger.warn("Codex catalog discovery requires a base URL without a query or fragment", providerContext)
        return
      }
      const origin = base.origin
      const listURL = new URL(endpoint, origin)
      if (codexMode && config.endpoint === undefined) {
        listURL.pathname = base.pathname.replace(/[/]+$/, "") + "/models"
      }
      if (codexMode && (!isGatewayURL(listURL, origin) ||
        !/^https?:$/.test(base.protocol) || base.username || base.password || listURL.searchParams.has("client_version"))) {
        logger.warn("Model discovery endpoint must use the configured provider origin", providerContext)
        return
      }
      url = listURL.toString()
      const headers = new Headers({ accept: "application/json" })
      if (!codexMode && key) headers.set("authorization", "Bearer " + key)
      // Retain the origin and redirect policy even for anonymous gateway requests.
      const request = codexMode ? withGatewayPolicy(fetcher, origin, key) : fetcher
      const privateReferenceURL = codexMode ? gatewayReferenceURL(config.modelInfoEndpoint, origin) : undefined
      const referenceURL = privateReferenceURL ?? config.modelInfoEndpoint
      const privateFetcher = privateReferenceURL ? request : undefined
      const resolveEnricher = () => {
        if (withModelsDevEfforts) return loadOpenAIModelsDevEnricher(referenceURL, privateFetcher)
        if (codexMode && (config.modelInfoFormat === ModelInfoFormat.AIProxy || modelsDevFormat)) {
          return fetchModelsDevCatalog(referenceURL, privateFetcher, "metadata")
            .then(catalog => modelsDevFormat ? createModelsDevEnricher(catalog?.models) : createAIProxyEnricher(catalog?.models))
        }
        return resolveModelInfoEnricher({
          baseURL,
          // The request applies gateway authentication at the origin boundary.
          apiKey: codexMode ? undefined : key,
          providerName: provider.id,
          fetcher: request,
          logger: codexMode ? { warn: () => logger.warn("Additional model metadata unavailable", providerContext) } : logger,
        }, {
          format: config.modelInfoFormat,
          endpoint: config.modelInfoEndpoint,
          filterNonChat: config.filterNonChat,
          timeoutMs: config.timeoutMs,
        })
      }
      const readList = async () => {
        const response = await request(listURL.href, { headers, signal: AbortSignal.timeout(config.timeoutMs) })
        const enhanced = codexMode || withModelsDevEfforts
        if (!response.ok || (enhanced && response.status === 206)) {
          logger.warn(`Model discovery request failed for provider "${provider.id}"`, {
            ...providerContext, status: response.status, ...(!codexMode ? { url, statusText: response.statusText } : {}),
          })
          return undefined
        }
        const payload = await response.json() as { data?: unknown } | null
        if (Array.isArray(payload?.data)) {
          return payload.data.filter(isDiscoveredRawModel)
        }
        logger.warn(`Model discovery returned invalid payload for provider "${provider.id}": expected array in "data" property`, {
          ...providerContext,
          ...(!codexMode ? {
            url, payloadType: typeof payload,
            keys: payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : undefined,
          } : {}),
        })
        return undefined
      }

      // Consume the list body independently of optional metadata and its timeout.
      const list = cached ? Promise.resolve(cached.rawModels.filter(isDiscoveredRawModel)) : readList()
      const [listed, reference, codex] = await Promise.all([
        previousRows ? list.catch(discoveryError) : list,
        cached && !withModelsDevEfforts ? cachedEnricher(cached.enrichments, modelsDevFormat) : resolveEnricher().catch(() => {
          logger.warn("Additional model metadata unavailable", providerContext)
          return undefined
        }),
        codexMode ? fetchCodexCatalog(listURL, headers, config.timeoutMs, request) : undefined,
      ])
      const rawModels = listed ?? previousRows
      if (!rawModels) return
      if (codexMode && !codex) logger.warn("Codex metadata unavailable; using ordinary model discovery", providerContext)
      let enricher = compose ? composeOpenAIMetadata(reference, codex, openAIEfforts) : reference
      if (!cached) await prepareModelEnricher(enricher, rawModels.map(model => model.id))

      const persistList = cacheSupported && !cached && listed !== undefined
      const enrichments: Record<string, ModelEnrichmentResult> = {}
      const source = enricher
      if (persistList && source) {
        enricher = {
          enrich(model, context) {
            const result = source.enrich(model, context)
            enrichments[model.id] = withModelsDevEfforts ? { ...result, variants: undefined } : result
            return result
          },
        }
      }
      const drafts = discoverModelDrafts(rawModels, {
        filter: {
          includeBy: config.includeBy.map((filter) => ({ ...filter, match: filter.match ? new RegExp(filter.match) : undefined })),
          excludeBy: config.excludeBy.map((filter) => ({ ...filter, match: filter.match ? new RegExp(filter.match) : undefined })),
          includeRegex: config.includeRegex,
          excludeRegex: config.excludeRegex,
        },
        smartModelName: config.smartModelName,
        enricher,
        enrichmentContext: { filterNonChat: config.filterNonChat },
      })
      const models = new Map<string, DiscoveredV2Model>()
      const ordinarySources = !codexMode && withModelsDevEfforts ? options?.ordinarySources : undefined
      const sources = ordinarySources && new Map<string, DiscoveredV2Model>()
      for (const draft of drafts) {
        const model = mapToDiscoveredV2Model(draft, config)
        models.set(draft.id, model)
        // models.dev supplies variants only on the named-effort path. Reuse the
        // ordinary mapper for the source that configured models inherit.
        sources?.set(draft.id, draft.variants === undefined ? model : mapToDiscoveredV2Model({ ...draft, variants: undefined }, config))
      }
      inventory.set(provider.id, models)
      if (sources) ordinarySources?.set(provider.id, sources)
      if (!codexMode && withModelsDevEfforts && listed) {
        ordinaryLists?.set(provider.id, { baseURL, endpoint, rows: rawModels })
      } else if (!withModelsDevEfforts) {
        ordinaryLists?.delete(provider.id)
      }
      if (persistList) {
        await writeDiscoveryCache(storage, cacheKey, createDiscoveryCacheEntry(cacheIdentity, rawModels, enrichments))
      }
    } catch (error) {
      discoveryError(error)
    }
  }))

  return inventory
}
