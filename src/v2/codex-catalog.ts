import { advertisedListLimits, enrichmentLimits, tokenCount, type ModelEnricher } from "../core/model-enrichment.js"
import { codexClientVersion } from "./codex-client-version.js"

type CodexCatalog = ReadonlyMap<string, Record<string, unknown> | undefined>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function reasoningEfforts(levels: unknown, multiAgentEffort: unknown): ReadonlyMap<string, string> | undefined {
  if (!Array.isArray(levels)) return undefined
  const advertised = levels.flatMap(level =>
    isRecord(level) && typeof level.effort === "string" && level.effort.trim() ? [level.effort] : [])
  // Only an explicitly empty list replaces ordinary reasoning choices with none.
  if (levels.length && !advertised.length) return undefined
  const ultra = typeof multiAgentEffort === "string" && multiAgentEffort !== "ultra" && advertised.includes(multiAgentEffort)
    ? multiAgentEffort
    : advertised.includes("max") ? "max" : advertised.filter(effort => effort !== "ultra").pop() ?? "medium"
  return new Map(advertised.map(effort => [effort, effort === "ultra" ? ultra : effort === "persistent" ? "disabled" : effort]))
}

export async function fetchCodexCatalog(
  listURL: URL, headers: Headers, timeoutMs: number, fetchGateway: typeof fetch,
): Promise<CodexCatalog | undefined> {
  try {
    const endpoint = new URL(listURL)
    endpoint.searchParams.set("client_version", codexClientVersion())
    const response = await fetchGateway(endpoint.toString(), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 200) return undefined
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload.models)) return undefined
    const metadata = new Map<string, Record<string, unknown> | undefined>()
    for (const entry of payload.models as unknown[]) {
      if (!isRecord(entry) || typeof entry.slug !== "string" || !entry.slug.trim()) continue
      // A repeated slug is not a unique match for this route.
      metadata.set(entry.slug, metadata.has(entry.slug) ? undefined : entry)
    }
    return metadata
  } catch {
    return undefined
  }
}

function overlayEffortVariants(base: unknown, efforts: ReadonlyMap<string, string>): Record<string, unknown> {
  // Discovery adapters describe variants as a map. Service tiers and other
  // non-effort variants remain available alongside the Codex effort choices.
  const variants = new Map<string, Record<string, unknown>>()
  if (base && typeof base === "object" && !Array.isArray(base)) {
    for (const [id, variant] of Object.entries(base)) {
      if (!variant || typeof variant !== "object") continue
      const other = { ...variant as Record<string, unknown> }
      delete other.reasoningEffort
      if (!("reasoningEffort" in variant) || Object.keys(other).length) variants.set(id, other)
    }
  }
  for (const [id, effort] of efforts) {
    let variantID = id
    if (variants.has(id)) {
      // A shared label does not mean the user selected two independent options.
      // Reserve original effort IDs too, regardless of their order in the catalog.
      const prefix = "codex-" + id
      variantID = prefix
      for (let suffix = 2; variants.has(variantID) || efforts.has(variantID); suffix++) {
        variantID = prefix + "-" + suffix
      }
    }
    variants.set(variantID, { reasoningEffort: effort })
  }
  return Object.fromEntries(variants)
}

/** Join live and reference fields before the host applies defaults. The Codex catalog is optional. */
export function composeOpenAIMetadata(base: ModelEnricher | undefined, catalog: CodexCatalog | undefined, openAIEfforts: boolean): ModelEnricher {
  return {
    prepare: base?.prepare?.bind(base),
    enrich(model, context) {
      const metadata = catalog?.get(model.id)
      const options = { ...context, deferLimitNormalization: true }
      const { limit: declared, fallbackLimit, ...result } = base?.enrich(model, options) ?? {}
      if (result.skip) return result

      const inline = advertisedListLimits(model)
      const limit = enrichmentLimits(options,
        tokenCount(metadata?.context_window) ?? tokenCount(metadata?.max_context_window) ?? tokenCount(declared?.context)
          ?? inline.context ?? tokenCount(fallbackLimit?.context),
        tokenCount(metadata?.max_tokens) ?? tokenCount(declared?.output) ?? inline.output ?? tokenCount(fallbackLimit?.output),
        tokenCount(declared?.input) ?? inline.input ?? tokenCount(fallbackLimit?.input),
      )
      const efforts = openAIEfforts ? reasoningEfforts(metadata?.supported_reasoning_levels, metadata?.multi_agent_reasoning_effort) : undefined
      return {
        ...result,
        ...(limit ? { limit } : {}),
        // Advertised efforts do not imply a reasoning-text replay format.
        ...(efforts ? {
          variants: overlayEffortVariants(result.variants, efforts),
        } : {}),
      }
    },
  }
}
