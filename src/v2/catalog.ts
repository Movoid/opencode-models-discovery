import { isDeepStrictEqual } from "node:util"
import { Model, Provider, type Plugin } from "@opencode/plugin"

export interface DiscoveredV2Model {
  readonly id: string
  readonly modelID: string
  readonly name: string
  readonly capabilities: {
    readonly tools: boolean
    readonly input: string[]
    readonly output: string[]
  }
  readonly limit: {
    readonly context: number
    readonly output: number
    readonly input?: number
  }
  readonly variants?: Array<{
    readonly id: string
    readonly settings: Record<string, unknown>
    readonly body?: Record<string, unknown>
    readonly headers?: Record<string, string>
  }>
  readonly compatibility?: Record<string, unknown>
  readonly reasoning?: boolean
  readonly attachment?: boolean
  readonly cost?: unknown
}

export type Inventory = Map<string, Map<string, DiscoveredV2Model>>

export interface ConfiguredProvider {
  readonly id: string
  readonly name?: string
  readonly package: string
  readonly integrationID?: string
  readonly codexCatalog?: boolean
  readonly settings: Record<string, unknown>
  /** Ephemeral discovery credential. In Codex mode, null blocks discovery; undefined allows anonymous requests. */
  readonly apiKey?: string | null
  readonly pruneMissing?: boolean
}

type ProviderContext = Pick<Plugin.Context, "provider"> & Partial<Pick<Plugin.Context, "model" | "location">>

export interface ProviderController {
  readonly transform: (editor: Parameters<Plugin.Context["provider"]["transform"]>[0] extends (editor: infer Draft) => void ? Draft : never) => void
  readonly transformModels: Parameters<Plugin.Context["model"]["transform"]>[0]
  readonly replaceInventory: (next: Inventory, discoveredProviders?: readonly ConfiguredProvider[], ordinarySources?: Inventory) => Promise<void>
  readonly status: () => { providers: number; models: number }
  readonly getInventory: () => Inventory
}

function copyInventory(inventory: Inventory): Inventory {
  return new Map([...inventory].map(([providerID, models]) => [providerID, new Map(models)]))
}

export function createProviderController(
  ctx: ProviderContext,
  configured: readonly ConfiguredProvider[],
  integrationID: (providerID: string) => string,
): ProviderController {
  let inventory: Inventory = new Map()
  let modelProviders = new Map<string, ConfiguredProvider>()
  let ordinarySources: Inventory = new Map()
  let ordinaryAdditions = new Map<string, Set<string>>()
  let collectingAdditions = false

  const transform: ProviderController["transform"] = (editor) => {
    for (const provider of configured) {
      if (provider.codexCatalog) continue
      const providerID = Provider.ID.make(provider.id)
      const targetIntegrationID = (provider.settings.integrationID as string | undefined) ?? integrationID(provider.id)
      const current = editor.get(providerID)
      const authHeaders = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : undefined

      if (!current) {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: provider.name ?? provider.id,
            package: provider.package,
            headers: authHeaders,
            integrationID: targetIntegrationID as never,
            activation: "enabled",
          },
          models: [],
        })
      } else {
        const needsIntegration = !current.provider?.integrationID
        const hasExistingAuthHeader = Boolean(current.provider?.headers?.authorization)
        const needsHeaders = Boolean(authHeaders) || hasExistingAuthHeader
        if (needsIntegration || needsHeaders) {
          editor.update(providerID, (draft) => {
            if (needsIntegration) {
              draft.integrationID = targetIntegrationID as never
            }
            if (authHeaders) {
              draft.headers = {
                ...draft.headers,
                ...authHeaders,
              }
            } else if (draft.headers?.authorization) {
              const nextHeaders = { ...draft.headers }
              delete nextHeaders.authorization
              draft.headers = nextHeaders
            }
          })
        }
      }

      const sourceInventory = ordinarySources.get(provider.id)
      const models = sourceInventory ?? inventory.get(provider.id)
      if (!models) continue
      const source = editor.get(providerID)
      const sourceModels = source ? [...source.models.values()] : []
      // An empty inventory is what a failed first request looks like, so it must never prune.
      // Match on either key: a source model can alias a listed upstream model under its own id.
      const listed = new Set([...models.values()].flatMap((model) => [model.id, model.modelID]))
      const existing = provider.pruneMissing && models.size > 0
        ? sourceModels.filter((model) => listed.has(String(model.id)) || listed.has(String((model as { modelID?: unknown }).modelID)))
        : sourceModels
      if (modelProviders.has(provider.id) && !sourceInventory) {
        // The model transform sees user definitions added after this provider fold.
        if (existing.length !== sourceModels.length) editor.models.set(providerID, existing)
        continue
      }
      const existingIDs = new Set(existing.map((model) => String(model.id)))
      editor.models.set(providerID, [
        ...existing,
        ...[...models.values()].filter((model) => !existingIDs.has(model.id)).map((model) => Object.assign(
          Model.Info.default(providerID, Model.ID.make(model.modelID) as Model.ID),
          sourceInventory ? structuredClone(model) : model,
        )),
      ])
    }
  }

  return {
    transform,
    transformModels(editor) {
      for (const provider of modelProviders.values()) {
        const current = editor.provider.get(provider.id)?.provider
        if (!current || current.package !== provider.package ||
          current.settings?.baseURL !== provider.settings.baseURL ||
          (current.integrationID ?? current.id) !== (provider.integrationID ?? provider.id) ||
          current.settings?.apiKey !== provider.settings.apiKey ||
          !isDeepStrictEqual(current.settings?.modelsDiscovery, provider.settings.modelsDiscovery)) continue

        const models = inventory.get(provider.id)
        if (!models?.size) continue
        const sources = ordinarySources.get(provider.id)
        const additions = collectingAdditions && !provider.codexCatalog ? new Set<string>() : undefined
        if (additions) ordinaryAdditions.set(provider.id, additions)
        // Each fold starts with the host's catalog. Missing discoveries fall
        // out on rebuild; definitions owned by the host or other plugins stay.
        for (const model of models.values()) {
          if (sources) {
            // The provider fold supplied the baseline. Only a discovery-owned
            // ID receives its named efforts; the host applies user variants last.
            if (ordinaryAdditions.get(provider.id)?.has(model.id) && model.variants &&
              !isDeepStrictEqual(model.variants, sources.get(model.id)?.variants)) {
              const variants = structuredClone(model.variants)
              editor.update(provider.id, model.id, draft => Object.assign(draft, { variants }))
            }
            continue
          }
          // Existing definitions can include aliases whose targets are applied
          // by a later host transform. Do not attach discovery metadata to them.
          if (editor.get(provider.id, model.id)) continue
          additions?.add(model.id)
          editor.update(provider.id, model.id, draft => Object.assign(draft, structuredClone(model)))
        }
      }
    },
    async replaceInventory(next, discoveredProviders = [], nextSources = new Map()) {
      inventory = copyInventory(next)
      modelProviders = new Map(discoveredProviders.map(provider => [provider.id, provider]))
      ordinarySources = new Map()
      ordinaryAdditions = new Map()
      if (ctx.model && [...nextSources.values()].some(models => models.size > 0)) {
        // The config provider transform creates placeholders after our provider
        // transform. Observe those IDs before publishing our own source models.
        // model.list drives the lazy model fold, including disabled candidates.
        collectingAdditions = true
        try {
          await ctx.provider.reload()
          if ([...nextSources].some(([id, models]) => models.size && !ordinaryAdditions.has(id))) {
            await ctx.model.list(ctx.location ? { location: ctx.location } : undefined)
          }
        } catch {
          // Without a complete ownership snapshot, keep only the ordinary sources.
          ordinaryAdditions.clear()
        } finally {
          collectingAdditions = false
        }
      }
      ordinarySources = nextSources
      await ctx.provider.reload()
    },
    status() {
      return {
        providers: inventory.size,
        models: [...inventory.values()].reduce((total, models) => total + models.size, 0),
      }
    },
    getInventory() {
      return copyInventory(inventory)
    },
  }
}
