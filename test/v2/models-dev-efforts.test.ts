import { afterEach, describe, expect, it, vi } from "vitest"
import { discoverInventory } from "../../src/v2/discovery.js"
import { modelsDevTestUtils } from "../../src/utils/models-dev-fetcher.js"
import { options, provider, publicCatalog, sol } from "./metadata-fixture.js"

afterEach(() => {
  vi.unstubAllGlobals()
  modelsDevTestUtils.resetCache()
})

const mirror = { modelInfoEndpoint: "https://mirror.example/catalog", smartModelName: true }
const named = (...values: string[]) => ({ reasoning_options: [{ type: "effort", values }] })
const effort = (id: string) => ({ id, settings: { reasoningEffort: id } })

async function discover(ids: string[], settings = {}, source = provider) {
  const list = async () => Response.json({ data: ids.map(id => ({ id })) })
  return (await discoverInventory([source], options(settings), list)).get(source.id)!
}

describe("models.dev named efforts", () => {
  it("prefers the ordinary gateway's input limit over its reference", async () => {
    publicCatalog()
    const list = async () => Response.json({ data: [{ id: sol.id, max_input_tokens: 8192 }] })
    const models = (await discoverInventory([provider], options(), list)).get(provider.id)
    expect(models?.get(sol.id)?.limit).toEqual({ ...sol.limit, input: 8192 })
  })

  it("augments exact routes and unique bare IDs; ordinary metadata can still use a prefix match", async () => {
    publicCatalog()
    const canonical = "openai/" + sol.id
    const routed = "other/" + canonical
    const dated = sol.id + "-2099"
    const ids = [sol.id, canonical, routed, dated]
    const models = await discover(ids)
    expect([...models.keys()]).toEqual(ids)
    const expected = ["low", "high", "xhigh", "max"].map(effort)
    expect(models.get(canonical)?.variants).toEqual(expected)
    expect(models.get(sol.id)?.variants).toEqual(expected)
    expect(models.get(routed)?.variants).toEqual([effort("gateway-level")])
    expect(models.get(dated)).toMatchObject({ limit: sol.limit, variants: ["low", "medium", "high"].map(effort) })

    const native = await discover([sol.id], {}, { ...provider, package: "@opencode/ai/providers/google" })
    expect(native.get(sol.id)).toMatchObject({ limit: sol.limit, variants: ["low", "medium", "high"].map(effort) })
  })

  it("requires an unambiguous bare ID and keeps explicit default-only efforts ahead of the supplement", async () => {
    vi.stubGlobal("fetch", async (url: string) => Response.json(url.endsWith("/models.json") ? {
      "first/chat": { reasoning: true, ...named("default") }, "second/chat": {},
    } : { first: { models: { chat: named("xhigh") } } }))
    const models = await discover(["chat", "first/chat"])
    expect(models.get("chat")?.variants).toBeUndefined()
    expect(models.get("first/chat")?.variants).toEqual(["low", "medium", "high"].map(effort))
  })

  it("uses a mirror's explicit model ID and keeps independently usable metadata fields and efforts", async () => {
    vi.stubGlobal("fetch", async () => Response.json({
      vendor: { models: {
        alias: { id: "canonical", name: "Mirror Chat", limit: { context: "64000", input: 48_000, output: 8_000 }, ...named("max") },
        peer: { name: "Peer", limit: { context: 64_000 }, modalities: { input: [false], output: ["audio"] }, reasoning_options: false },
      } },
    }))
    const models = await discover(["vendor/canonical", "vendor/alias", "peer"], mirror)
    expect(models.get("vendor/canonical")).toMatchObject({
      name: "Mirror Chat", limit: { context: 200_000, input: 48_000, output: 8_000 }, variants: [effort("max")],
    })
    expect(models.get("vendor/alias")?.variants).toBeUndefined()
    expect(models.get("peer")).toMatchObject({ name: "Peer", limit: { context: 64_000 }, capabilities: { input: ["text"], output: ["audio"] } })
  })

  it("keeps the last mirror metadata but does not choose between conflicting efforts for one projected ID", async () => {
    vi.stubGlobal("fetch", async () => Response.json({
      first: { id: "local", limit: { context: 64_000 }, ...named("high") },
      second: { id: "local", limit: { context: 80_000 }, ...named("max") },
    }))
    const model = (await discover(["local"], mirror)).get("local")
    expect(model?.limit.context).toBe(80_000)
    expect(model?.variants).toBeUndefined()
  })
})
