export interface ModelsDevModel {
  id: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  structured_output?: boolean
  temperature?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
}

export const DEFAULT_MODELS_DEV_URL = 'https://models.dev/models.json'
export const MODELS_DEV_PROVIDER_URL = 'https://models.dev/api.json'
const PREFIX_MATCH_MIN_SCORE = 70
const PREFIX_MATCH_MIN_SHARED_PARTS = 2

type Row = Record<string, unknown>

interface ModelsDevCatalog {
  models: Map<string, Row>
  /** null means ambiguous; undefined means absent. */
  bareID(id: string): string | null | undefined
  effortsFor(route: string): readonly string[] | undefined
}

const catalogCache = new Map<string, ModelsDevCatalog>()
const modelsDevCaches = new Map<string, Map<string, ModelsDevModel>>()

function isObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function modelID(provider: string | undefined, id: string): string {
  return provider && !id.includes('/') ? provider + '/' + id : id
}

export function readModelsDevMetadata(row: Row): Omit<ModelsDevModel, 'id'> {
  const { modalities, limit } = row
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : undefined
  return {
    name: typeof row.name === 'string' ? row.name : undefined,
    attachment: typeof row.attachment === 'boolean' ? row.attachment : undefined,
    reasoning: typeof row.reasoning === 'boolean' ? row.reasoning : undefined,
    tool_call: typeof row.tool_call === 'boolean' ? row.tool_call : undefined,
    structured_output: typeof row.structured_output === 'boolean' ? row.structured_output : undefined,
    temperature: typeof row.temperature === 'boolean' ? row.temperature : undefined,
    modalities: isObject(modalities) ? { input: strings(modalities.input), output: strings(modalities.output) } : undefined,
    limit: isObject(limit) ? {
      context: typeof limit.context === 'number' ? limit.context : undefined,
      input: typeof limit.input === 'number' ? limit.input : undefined,
      output: typeof limit.output === 'number' ? limit.output : undefined,
    } : undefined,
  }
}

type Layout = 'flat' | 'provider' | 'mirror' | 'legacy'

function* modelRows(data: unknown, layout: Layout): Generator<[key: string, row: Row, provider?: string]> {
  if (!isObject(data)) return
  for (const [key, value] of Object.entries(data)) {
    // An error envelope must not become a cached bare mirror model.
    if (!isObject(value) || (layout !== 'legacy' && key === 'error')) continue
    const canNest = layout === 'legacy' || (layout === 'mirror' && !key.includes('/'))
    if (layout === 'provider' || (canNest && isObject(value.models))) {
      if (!isObject(value.models) || (layout !== 'legacy' && !key.trim())) continue
      for (const [id, row] of Object.entries(value.models)) {
        if (isObject(row)) yield [id, row, key]
      }
    } else yield [key, value]
  }
}

function parseModelsDevData(data: unknown): Map<string, ModelsDevModel> {
  const models = new Map<string, ModelsDevModel>()
  for (const [key, row, provider] of modelRows(data, 'legacy')) {
    const rawID = typeof row.id === 'string' && row.id ? row.id : key
    if (!rawID) continue
    const id = modelID(provider, rawID)
    models.set(id, { id, ...readModelsDevMetadata(row) })
  }
  return models
}

function namedEfforts(options: unknown): readonly string[] | undefined {
  if (!Array.isArray(options)) return
  for (const option of options) {
    if (!isObject(option) || option.type !== 'effort' || !Array.isArray(option.values)) continue
    const choices = option.values.filter((s): s is string => typeof s === 'string' && !!s.trim())
    if (choices.length || !option.values.length) return [...new Set(choices.filter(s => s !== 'default'))]
  }
}

type CatalogUse = 'both' | 'metadata' | 'efforts'

function indexCatalog(data: unknown, layout: Layout, use: CatalogUse): ModelsDevCatalog | undefined {
  const models = new Map<string, Row>()
  const routes = new Map<string, Row[]>()
  const bareIDs = new Map<string, string | null>()
  const useRowID = layout === 'mirror' || use !== 'efforts'
  for (const [key, row, provider] of modelRows(data, layout)) {
    // Public efforts belong to routing keys. Mirrors use their projected model
    // IDs for both metadata and efforts, including explicit IDs on alias rows.
    const rawID = useRowID && typeof row.id === 'string' && row.id.trim() ? row.id : key
    const id = modelID(provider, rawID)
    const route = layout === 'mirror' ? id : provider ? provider + '/' + key : key
    const slash = route.indexOf('/')
    if (!rawID.trim() || (layout !== 'mirror' && (slash <= 0 || !route.slice(slash + 1).trim()))) continue
    if (use !== 'efforts') models.set(id, row)
    if (use === 'metadata') continue

    const aliases = routes.get(route)
    if (aliases) aliases.push(row)
    else routes.set(route, [row])
    if (!aliases && slash !== -1) {
      const bare = route.slice(slash + 1)
      bareIDs.set(bare, bareIDs.has(bare) ? null : route)
    }
  }
  if (!models.size && !routes.size) return
  return {
    models,
    bareID: id => routes.has(id) ? id : bareIDs.get(id),
    effortsFor(route) {
      const aliases = routes.get(route)
      if (!aliases) return
      const [first, ...others] = aliases.map(row => namedEfforts(row.reasoning_options))
      // Aliases keep last-write metadata, but must agree on the effort choices.
      if (first && others.every(list => list?.length === first.length && list.every(s => first.includes(s)))) return first
    },
  }
}

export async function fetchModelsDevCatalog(url = DEFAULT_MODELS_DEV_URL, privateFetcher?: typeof fetch, use: CatalogUse = 'both'): Promise<ModelsDevCatalog | undefined> {
  const key = use + ':' + url
  const cached = !privateFetcher && catalogCache.get(key)
  if (cached) return cached
  try {
    const response = await (privateFetcher ?? fetch)(url, { method: 'GET', signal: AbortSignal.timeout(3000) })
    if (response.status !== 200) return
    const layout = url === DEFAULT_MODELS_DEV_URL ? 'flat' : url === MODELS_DEV_PROVIDER_URL ? 'provider' : 'mirror'
    const catalog = indexCatalog(await response.json(), layout, use)
    if (!privateFetcher && catalog) catalogCache.set(key, catalog)
    return catalog
  } catch {
    return undefined
  }
}

export async function fetchModelsDevData(url: string = DEFAULT_MODELS_DEV_URL): Promise<Map<string, ModelsDevModel>> {
  const cached = modelsDevCaches.get(url)
  if (cached) return cached

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    })

    if (!response.ok) {
      return new Map()
    }

    const models = parseModelsDevData(await response.json())
    modelsDevCaches.set(url, models)
    return models
  } catch {
    return new Map()
  }
}

function splitModelId(modelId: string): { provider?: string; model: string } {
  const parts = modelId.split('/')
  if (parts.length <= 1) {
    return { model: modelId }
  }

  return {
    provider: parts[0].toLowerCase(),
    model: parts.slice(1).join('/'),
  }
}

function calculatePrefixScore(modelA: string, modelB: string): number {
  const partsA = modelA.split('-')
  const partsB = modelB.split('-')
  const shorter = partsA.length <= partsB.length ? partsA : partsB
  const longer = partsA.length <= partsB.length ? partsB : partsA

  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) {
      return 0
    }
  }

  if (shorter.length < PREFIX_MATCH_MIN_SHARED_PARTS) {
    return 0
  }

  return Math.max(0, 100 - ((longer.length - shorter.length) * 10))
}

export function lookupModelsDevData<T>(
  modelId: string,
  cache: Map<string, T>
): T | undefined {
  let cleanId = modelId.replace(/:[a-zA-Z0-9_-]+$/g, '')
  const parts = cleanId.split('/')
  if (parts.length > 2) {
    cleanId = parts.slice(-2).join('/')
  }

  const exactMatch = cache.get(cleanId) ?? cache.get(cleanId.toLowerCase())
  if (exactMatch) return exactMatch

  const requestedModelLower = splitModelId(cleanId).model.toLowerCase()
  const allCandidates: Array<[string, T]> = []

  for (const [key, value] of cache.entries()) {
    const candidate = splitModelId(key)
    const candidateModelLower = candidate.model.toLowerCase()
    allCandidates.push([candidateModelLower, value])
  }

  const exactModelMatches = allCandidates.filter(([candidateModel]) => candidateModel === requestedModelLower)
  if (exactModelMatches.length === 1) return exactModelMatches[0]?.[1]
  if (exactModelMatches.length > 1) return undefined

  let bestMatch: T | undefined
  let bestScore = 0
  let bestScoreMatches = 0

  for (const [candidateModel, value] of allCandidates) {
    const score = calculatePrefixScore(requestedModelLower, candidateModel)
    if (score >= PREFIX_MATCH_MIN_SCORE && score > bestScore) {
      bestScore = score
      bestMatch = value
      bestScoreMatches = 1
    } else if (score >= PREFIX_MATCH_MIN_SCORE && score === bestScore) {
      bestScoreMatches++
    }
  }

  return bestScoreMatches === 1 ? bestMatch : undefined
}

export const modelsDevTestUtils = {
  parseModelsDevData,
  resetCache(): void {
    modelsDevCaches.clear()
    catalogCache.clear()
  },
}
