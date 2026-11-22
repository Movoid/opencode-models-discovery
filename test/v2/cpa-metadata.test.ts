import { afterEach, describe, expect, it, vi } from "vitest"
import { discoverInventory } from "../../src/v2/discovery.js"
import { modelsDevTestUtils } from "../../src/utils/models-dev-fetcher.js"
import { endpoint, options, provider, publicCatalog, sol } from "./metadata-fixture.js"

vi.mock("../../src/v2/codex-client-version.js", () => ({ codexClientVersion: () => "0.171.0" }))
const logger = { warn: vi.fn() }
const codex = { codexCatalog: true, modelInfoFormat: undefined }
const effort = (id: string, reasoningEffort = id) => ({ id, settings: { reasoningEffort } })

afterEach(() => {
  logger.warn.mockClear()
  vi.unstubAllGlobals()
  modelsDevTestUtils.resetCache()
})

describe("Codex catalog discovery", () => {
  it("joins exact listed IDs and retains independently usable fields, efforts and siblings", async () => {
    const gateway = async (url: string) => url === endpoint ? Response.json({ data: [
      null, { id: 41 }, { id: "main", context_length: 4000, max_completion_tokens: 20_000,
        max_input_tokens: "100", top_provider: { max_completion_tokens: 900.5 } },
      { id: "sibling", supports_reasoning: true }, { id: "no-efforts", supports_reasoning: true }, { id: "route/other" },
    ] }) : Response.json({ models: [
      { slug: "main", context_window: "8000", max_context_window: 80_000, max_tokens: false,
        supported_reasoning_levels: [null, { effort: "xhigh" }, { effort: false }, { effort: "ultra" }, { effort: "persistent" }],
        multi_agent_reasoning_effort: "xhigh" },
      { slug: "sibling", context_window: 9000, max_tokens: 700, supported_reasoning_levels: "not a list" },
      { slug: "no-efforts", supported_reasoning_levels: [] }, { slug: "other", context_window: 5000 }, {}, { slug: "catalog-only" },
    ] })
    const models = (await discoverInventory([provider], options({ ...codex, modelInfoFormat: "openrouter" }), gateway)).get("cpa")!
    expect([...models.keys()]).toEqual(["main", "sibling", "no-efforts", "route/other"])
    expect(models.get("main")?.limit).toEqual({ context: 80_000, output: 20_000 })
    expect(models.get("main")?.variants).toEqual([effort("xhigh"), effort("ultra", "xhigh"), effort("persistent", "disabled")])
    expect(models.get("main")?.compatibility?.reasoningField).toBeUndefined()
    expect(models.get("sibling")?.limit).toEqual({ context: 9000, output: 700 })
    expect(models.get("sibling")?.variants).toEqual([effort("low"), effort("medium"), effort("high")])
    expect(models.get("no-efforts")?.variants).toEqual([])
    expect(models.get("route/other")?.limit.context).toBe(200_000)
  })

  it("keeps a service tier independently selectable when a Codex effort shares its label", async () => {
    const gateway = async (url: string) => url === endpoint
      ? Response.json({ data: [{ id: "mixed", service_tiers: ["priority"], capabilities: { reasoning: true, effort_tiers: ["low"] } }] })
      : Response.json({ models: [{ slug: "mixed", supported_reasoning_levels: [{ effort: "fast" }] }] })
    const result = await discoverInventory([provider], options({ ...codex, modelInfoFormat: "omniroute" }), gateway)
    expect(result.get("cpa")?.get("mixed")?.variants).toEqual([
      { id: "fast", settings: {}, body: { service_tier: "fast" } }, effort("codex-fast", "fast"),
    ])
  })

  it("reads explicitly selected catalog limits for a custom adapter", async () => {
    const gateway = async (url: string) => url === endpoint ? Response.json({ data: [{ id: "listed" }] })
      : Response.json({ models: [{ slug: "listed", max_tokens: 4800, supported_reasoning_levels: [{ effort: "max" }] }] })
    const inventory = await discoverInventory([{ ...provider, package: "custom-adapter" }], options(codex), gateway)
    const model = inventory.get("cpa")?.get("listed")
    expect(model?.limit.output).toBe(4800)
    expect(model?.variants).toBeUndefined()
  })

  it("falls back to public metadata when the supplement is unavailable", async () => {
    const publicReference = publicCatalog()
    const gateway = async (url: string) => url === endpoint ? Response.json({ data: [{ id: sol.id }] }) : new Response(null, { status: 503 })
    const result = await discoverInventory([provider], options({ codexCatalog: true }), gateway, undefined, { logger })
    const model = result.get("cpa")?.get(sol.id)
    expect(model?.limit).toEqual(sol.limit)
    expect(model?.variants).toEqual(["low", "high", "xhigh", "max"].map(id => effort(id)))
    for (const [, init] of publicReference.mock.calls) expect(new Headers(init?.headers).has("authorization")).toBe(false)
  })

  it("does not use a supplemental catalog for membership when the list is unusable", async () => {
    const gateway = async (url: string) => url === endpoint ? Response.json({ data: {} }) : Response.json({ models: [{ slug: "extra" }] })
    const result = await discoverInventory([provider], options(codex), gateway, undefined, { logger })
    expect(result.has("cpa")).toBe(false)
  })

  it.each([undefined, "first-account"])("uses gateway credentials only on the configured origin (key: %s)", async apiKey => {
    const nested = { ...provider, apiKey, settings: { baseURL: "https://cpa.example/team/v1" } }
    const gateway = vi.fn(async (url: string, init?: RequestInit) => {
      const target = new URL(url)
      if (target.origin !== "https://cpa.example" || init?.redirect !== "error" ||
        new Headers(init?.headers).get("authorization") !== (apiKey ? "Bearer " + apiKey : null)) return new Response(null, { status: 403 })
      if (target.pathname !== "/team/v1/models") return new Response(null, { status: 404 })
      return target.searchParams.get("client_version") === "0.171.0"
        ? Response.json({ models: [{ slug: "member", context_window: 42_000 }] }) : Response.json({ data: [{ id: "member" }] })
    })
    const result = await discoverInventory([nested], options(codex), gateway, undefined, { logger })
    expect(result.get("cpa")?.get("member")?.limit.context).toBe(42_000)
    await discoverInventory([nested], options({ ...codex, endpoint: "//outside.example/models" }), gateway, undefined, { logger })
    expect(gateway.mock.calls.some(([url]) => new URL(url).origin !== "https://cpa.example")).toBe(false)
  })

  it.each(["models.dev", "aiproxy"])("does not reuse one account's private %s metadata for another", async modelInfoFormat => {
    const external = vi.fn(async () => new Response(null, { status: 401 }))
    vi.stubGlobal("fetch", external)
    const gateway = async (url: string, init?: RequestInit) => {
      if (url === endpoint) return Response.json({ data: [{ id: "mirror-model" }] })
      if (url !== "https://cpa.example/ref.json") return Response.json({ models: [] })
      if (init?.redirect !== "error" || new Headers(init.headers).get("authorization") !== "Bearer fixture-key") return new Response(null, { status: 401 })
      return Response.json({ "demo/mirror-model": { limit: { context: 123_456 } } })
    }
    const discovery = options({ codexCatalog: true, modelInfoFormat, modelInfoEndpoint: "/ref.json" })
    const read = async (apiKey: string) => (await discoverInventory([{ ...provider, apiKey }], discovery, gateway, undefined, { logger })).get("cpa")?.get("mirror-model")
    expect((await read("fixture-key"))?.limit.context).toBe(123_456)
    expect((await read("another-account"))?.limit.context).toBe(200_000)
    expect(external).not.toHaveBeenCalled()
  })

  it("reads an off-origin adapter reference without forwarding the gateway key", async () => {
    const modelInfoEndpoint = "https://external.example/model/info"
    const gateway = async (url: string, init?: RequestInit) => {
      if (url === endpoint) return Response.json({ data: [{ id: "listed" }] })
      if (url !== modelInfoEndpoint) return Response.json({ models: [] })
      if (new Headers(init?.headers).has("authorization")) return new Response(null, { status: 403 })
      return Response.json({ data: [{ model_name: "listed", model_info: { max_output_tokens: 7200 } }] })
    }
    const config = options({ ...codex, modelInfoFormat: "litellm", modelInfoEndpoint })
    const result = await discoverInventory([provider], config, gateway)
    expect(result.get("cpa")?.get("listed")?.limit.output).toBe(7200)
  })

  it("keeps private query parameters and errors out of diagnostics", async () => {
    const gateway = vi.fn().mockRejectedValue(new Error("fixture-key in private-query"))
    await discoverInventory([provider], options({ ...codex, endpoint: "/v1/models?token=private-query" }), gateway, undefined, { logger })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("discovery error"), { provider: "cpa" })
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/fixture-key|private-query/)
  })
})
