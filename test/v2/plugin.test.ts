import { describe, expect, it, vi } from "vitest"
import plugin from "../../src/v2/index.js"

vi.mock("../../src/v2/codex-client-version.js", () => ({ codexClientVersion: () => "0.171.0" }))

function closedEvents() {
  return { subscribe: vi.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {},
  }) }
}

function context(overrides: Record<string, unknown> = {}) {
  const providerTransform = vi.fn().mockImplementation(async (callback) => {
    callback({
      get: vi.fn().mockReturnValue(undefined),
      add: vi.fn(),
      update: vi.fn(),
      models: { set: vi.fn() },
    })
  })
  const providerReload = vi.fn().mockResolvedValue(undefined)
  const integrationTransform = vi.fn().mockImplementation(async (callback) => {
    callback({ update: vi.fn(), method: { update: vi.fn() } })
  })
  const integrationReload = vi.fn().mockResolvedValue(undefined)
  const toolTransform = vi.fn().mockImplementation(async (callback) => callback({ add: vi.fn() }))
  const commandTransform = vi.fn().mockImplementation(async (callback) => callback({ add: vi.fn() }))
  const commandReload = vi.fn().mockResolvedValue(undefined)
  const synthetic = vi.fn().mockResolvedValue(undefined)
  return {
    app: { version: "2.0.14" },
    options: {
      providers: {},
    },
    provider: {
      transform: providerTransform,
      reload: providerReload,
      list: vi.fn().mockResolvedValue({ data: [{
        id: "local",
        name: "Local",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: "http://127.0.0.1:1234/v1",
          modelsDiscovery: {
            enabled: true,
          },
        },
      }] }),
    },
    integration: {
      transform: integrationTransform,
      reload: integrationReload,
      connection: { active: vi.fn().mockResolvedValue(undefined), resolve: vi.fn() },
    },
    event: closedEvents(),
    tool: { transform: toolTransform },
    command: { transform: commandTransform, reload: commandReload },
    session: { synthetic },
    ...overrides,
  }
}

describe("V2 plugin entrypoint", () => {
  it("registers provider and integration transforms, then reloads after discovery", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "discovered-model" }] }),
    } as Response)
    const ctx = context()

    try {
      await plugin.setup(ctx as never)
      expect(ctx.integration.transform).toHaveBeenCalledTimes(1)
      expect(ctx.provider.transform).toHaveBeenCalledTimes(1)
      expect(ctx.integration.reload).toHaveBeenCalledTimes(1)
      expect(ctx.provider.reload).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.mockRestore()
    }
  })

  it("uses a managed key only for discovery requests", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as Response)
    const ctx = context()
    const connection = ctx.integration.connection as { active: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> }
    connection.active.mockResolvedValue({ type: "credential", id: "credential" })
    connection.resolve.mockResolvedValue({ type: "key", key: "managed-key" })

    try {
      await plugin.setup(ctx as never)
      expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        headers: expect.any(Object),
      }))
      expect(JSON.stringify({ status: { providers: 1, models: 0 } })).not.toContain("managed-key")
    } finally {
      fetcher.mockRestore()
    }
  })

  it("does not fail when no provider options are configured", async () => {
    const ctx = context({ options: {}, provider: {
      transform: vi.fn().mockImplementation(async (callback) => callback({ get: vi.fn().mockReturnValue(undefined), add: vi.fn(), update: vi.fn(), models: { set: vi.fn() } })),
      reload: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ data: [] }),
    } })
    await expect(plugin.setup(ctx as never)).resolves.toBeTypeOf("function")
    expect(ctx.provider.reload).toHaveBeenCalled()
  })

  it("ignores provider definitions inside plugin options", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
    const ctx = context({
      options: {
        providers: {
          legacy: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: "http://127.0.0.1:1234/v1", modelsDiscovery: { enabled: true } },
          },
        },
      },
      provider: {
        transform: vi.fn().mockImplementation(async (callback) => callback({ get: vi.fn().mockReturnValue(undefined), add: vi.fn(), update: vi.fn(), models: { set: vi.fn() } })),
        reload: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    })

    try {
      await plugin.setup(ctx as never)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })

  it("reads discovery options from the top-level provider settings", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "top-level-model" }] }),
    } as Response)
    const ctx = context({ options: {} })

    try {
      await plugin.setup(ctx as never)
      expect(fetcher).toHaveBeenCalledWith(
        "http://127.0.0.1:1234/v1/models",
        expect.objectContaining({ headers: expect.any(Object) }),
      )
    } finally {
      fetcher.mockRestore()
    }
  })

  it("serializes refreshes and does not refresh from its own provider reload", async () => {
    let releaseFirst: (() => void) | undefined
    const firstRefresh = new Promise<void>((resolve) => { releaseFirst = resolve })
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        await firstRefresh
        return { ok: true, json: async () => ({ data: [] }) } as Response
      })
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as Response)
    const events = {
      subscribe: vi.fn().mockReturnValue((async function* () {
        yield { type: "provider.updated" }
        yield { type: "config.updated" }
      })()),
    }
    const ctx = context({ event: events })

    try {
      const setup = plugin.setup(ctx as never)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetcher).toHaveBeenCalledTimes(1)
      releaseFirst?.()
      await setup
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      fetcher.mockRestore()
    }
  })

  it("reloads provider configuration before refreshing after config updates", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "initial-model" }] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "updated-model" }] }) } as Response)
    let currentBaseURL = "http://127.0.0.1:1234/v1"
    let providerReloads = 0
    const events = {
      subscribe: vi.fn().mockReturnValue((async function* () {
        yield { type: "config.updated" }
      })()),
    }
    const ctx = context({
      event: events,
      provider: {
        transform: vi.fn().mockImplementation(async (callback) => callback({ get: vi.fn().mockReturnValue(undefined), add: vi.fn(), update: vi.fn(), models: { set: vi.fn() } })),
        reload: vi.fn().mockImplementation(async () => {
          providerReloads += 1
          if (providerReloads >= 1) {
            currentBaseURL = "http://127.0.0.1:5678/v1"
          }
        }),
        list: vi.fn().mockImplementation(async () => ({ data: [{
          id: "local",
          name: "Local",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: currentBaseURL,
            modelsDiscovery: { enabled: true },
          },
        }] })),
      },
    })

    try {
      await plugin.setup(ctx as never)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ctx.provider.reload).toHaveBeenCalledTimes(3)
      expect(ctx.integration.transform).toHaveBeenCalledTimes(1)
      expect(ctx.provider.transform).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenNthCalledWith(1, "http://127.0.0.1:1234/v1/models", expect.any(Object))
      expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:5678/v1/models", expect.any(Object))
    } finally {
      fetcher.mockRestore()
    }
  })

  it("refreshes discovery after credential.updated and integration.updated events", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "model-after-connect" }] }),
    } as Response)

    const events = {
      subscribe: vi.fn().mockReturnValue((async function* () {
        yield { type: "credential.updated" }
        yield { type: "integration.updated" }
      })()),
    }
    const ctx = context({ event: events })

    try {
      await plugin.setup(ctx as never)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally {
      fetcher.mockRestore()
    }
  })

  it("never resolves or publishes an OAuth credential for a Codex gateway", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
    const connection = {
      active: vi.fn().mockResolvedValue({ type: "credential", method: "oauth", id: "fake-oauth" }),
      resolve: vi.fn().mockResolvedValue({ type: "oauth", access: "must-not-forward" }),
    }
    const makeProvider = () => ({
      id: "cpa", package: "@opencode/ai/providers/openai-compatible-responses", integrationID: "official",
      settings: { baseURL: "https://cpa.example/v1", apiKey: "must-not-fall-back", integrationID: "ignored-setting", modelsDiscovery: { enabled: true, codexCatalog: true } },
    })
    const providerUpdate = vi.fn()
    const methodUpdate = vi.fn()
    let transform: (editor: unknown) => void = () => {}
    const ctx = context({ provider: {
      list: async () => ({ data: [makeProvider()] }),
      transform: async (callback: typeof transform) => { transform = callback },
      reload: async () => transform({ get: () => ({ provider: makeProvider(), models: new Map() }), update: providerUpdate, models: { set: vi.fn() } }),
    }, integration: { ...context().integration, connection,
      transform: async (callback: (editor: unknown) => void) => callback({ method: { update: methodUpdate } }),
    } })
    try {
      const stop = await plugin.setup(ctx as never)
      expect(connection.active).toHaveBeenCalledWith("official")
      expect(connection.resolve).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
      expect(providerUpdate).not.toHaveBeenCalled()
      expect(methodUpdate).not.toHaveBeenCalled()
      stop?.()
    } finally {
      fetcher.mockRestore()
    }
  })

  it("queries a local Codex gateway anonymously only when no credential is configured", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      new URL(String(url)).searchParams.has("client_version")
        ? Response.json({ models: [{ slug: "local-model", context_window: 100_000 }] })
        : Response.json({ data: [{ id: "local-model" }] }),
    )
    const ctx = context()
    ctx.provider.list.mockResolvedValue({ data: [{
      id: "local", package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:1234/v1", modelsDiscovery: { enabled: true, codexCatalog: true } },
    }] })
    try {
      const stop = await plugin.setup(ctx as never)
      expect(ctx.integration.connection.resolve).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalled()
      expect(fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("authorization"))).toBe(true)
      stop?.()

      fetcher.mockClear()
      ctx.integration.connection.active.mockResolvedValue({ type: "env", name: "UNAVAILABLE_GATEWAY_KEY" })
      const stopUnresolved = await plugin.setup(ctx as never)
      expect(fetcher).not.toHaveBeenCalled()
      stopUnresolved?.()
    } finally {
      fetcher.mockRestore()
    }
  })

  it("publishes the active account’s models and drops stale models on list failure", async () => {
    let key = "key-a"
    let unavailable = false
    const gateway = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (unavailable) return new Response(null, { status: 503 })
      const endpoint = new URL(String(url))
      const id = key === "key-a" ? "old-model" : "new-model"
      return endpoint.searchParams.has("client_version")
        ? Response.json({ models: [{ slug: id, context_window: 300_000, supported_reasoning_levels: [{ effort: "max" }] }] })
        : Response.json({ data: [{ id }] })
    })
    const source = {
      id: "cpa", package: "@opencode/ai/providers/openai-compatible-responses",
      settings: { baseURL: "https://cpa.example/v1", apiKey: "fallback-key", modelsDiscovery: { enabled: true, codexCatalog: true } },
    }
    let fold: (editor: unknown) => void = () => {}
    const visible = new Map<string, unknown>()
    const rpcHandlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    const ctx = context({
      provider: {
        ...context().provider,
        list: async () => ({ data: [source] }),
        reload: async () => {
          visible.clear()
          fold({ provider: { get: () => ({ provider: source }) }, get: () => undefined,
            update: (_provider: string, id: string, apply: (draft: object) => void) => {
              const draft = {}
              apply(draft)
              visible.set(id, draft)
            } })
        },
      },
      model: { transform: async (callback: typeof fold) => { fold = callback } },
      integration: { ...context().integration, connection: {
        active: async () => ({ type: "credential", method: "key", id: key }),
        resolve: async () => ({ type: "key", key }),
      } },
      rpc: { register: async (_definition: unknown, handlers: typeof rpcHandlers) => Object.assign(rpcHandlers, handlers) },
    })
    let stop: (() => void) | undefined
    try {
      stop = await plugin.setup(ctx as never)
      expect([...visible.keys()]).toEqual(["old-model"])
      key = "key-b"
      await rpcHandlers.refresh!({ force: true })
      expect([...visible.keys()]).toEqual(["new-model"])
      expect(visible.get("new-model")).toMatchObject({ limit: { context: 300_000 }, variants: [{ id: "max", settings: { reasoningEffort: "max" } }] })
      unavailable = true
      await rpcHandlers.refresh!({ force: true })
      expect(visible.size).toBe(0)
    } finally {
      stop?.()
      gateway.mockRestore()
    }
  })

  it("uses the newly active integration credential after a credential event", async () => {
    let activeKey = "first-key"
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "credential-model" }] }),
    } as Response)
    const events = {
      subscribe: vi.fn().mockReturnValue((async function* () {
        await new Promise((resolve) => setTimeout(resolve, 0))
        activeKey = "second-key"
        yield { type: "credential.switched" }
      })()),
    }
    const ctx = context({
      event: events,
      integration: {
        transform: vi.fn().mockImplementation(async (callback) => callback({ update: vi.fn(), method: { update: vi.fn() } })),
        reload: vi.fn().mockResolvedValue(undefined),
        connection: {
          active: vi.fn().mockResolvedValue({ type: "credential", id: "active-credential" }),
          resolve: vi.fn().mockImplementation(async () => ({ type: "key", key: activeKey })),
        },
      },
    })

    try {
      await plugin.setup(ctx as never)
      await new Promise((resolve) => setTimeout(resolve, 10))
      const authorizationHeaders = fetcher.mock.calls.map(([, init]) => {
        const headers = (init as RequestInit | undefined)?.headers
        return headers instanceof Headers ? headers.get("authorization") : (headers as Record<string, string> | undefined)?.authorization
      })
      expect(authorizationHeaders).toContain("Bearer first-key")
      expect(authorizationHeaders).toContain("Bearer second-key")
    } finally {
      fetcher.mockRestore()
    }
  })

  it("preserves the last known inventory when a provider request fails", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "stable-model" }] }) } as Response)
      .mockResolvedValueOnce({ ok: false } as Response)
    const rpcHandlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    const ctx = context({
      rpc: {
        register: vi.fn().mockImplementation(async (definition, handlers) => {
          if (definition.id === "opencode.models-discovery") Object.assign(rpcHandlers, handlers)
        }),
      },
    })

    try {
      await plugin.setup(ctx as never)
      const status = rpcHandlers.status as (input?: unknown) => Promise<{ providers: Array<{ models: Array<{ id: string }> }> }>
      const before = await status({ details: true })
      expect(before.providers[0]?.models.map((model) => model.id)).toContain("stable-model")

      const refresh = rpcHandlers.refresh as (input?: unknown) => Promise<unknown>
      await refresh({ force: true })
      const after = await status({ details: true })
      expect(after.providers[0]?.models.map((model) => model.id)).toContain("stable-model")
    } finally {
      fetcher.mockRestore()
    }
  })

  it("does not reload the provider catalog until a refresh has discovered models", async () => {
    let releaseRefresh: (() => void) | undefined
    const refreshStarted = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "initial-model" }] }) } as Response)
      .mockImplementationOnce(async () => {
        await refreshStarted
        return { ok: true, json: async () => ({ data: [{ id: "refreshed-model" }] }) } as Response
      })
    const rpcHandlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    const ctx = context({
      rpc: {
        register: vi.fn().mockImplementation(async (definition, handlers) => {
          if (definition.id === "opencode.models-discovery") Object.assign(rpcHandlers, handlers)
        }),
      },
    })

    try {
      await plugin.setup(ctx as never)
      expect(ctx.provider.reload).toHaveBeenCalledTimes(1)

      const refresh = rpcHandlers.refresh as (input?: unknown) => Promise<unknown>
      const pending = refresh({ force: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ctx.provider.reload).toHaveBeenCalledTimes(1)

      releaseRefresh?.()
      await pending
      expect(ctx.provider.reload).toHaveBeenCalledTimes(2)
    } finally {
      fetcher.mockRestore()
    }
  })

  it("keeps discovered defaults separate from overridden values after a failed refresh", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "stable-model" }] }) } as Response)
      .mockResolvedValueOnce({ ok: false } as Response)
    const storageStore = new Map<string, unknown>()
    const rpcHandlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    const ctx = context({
      storage: {
        get: vi.fn().mockImplementation(async (key: string) => storageStore.get(key)),
        set: vi.fn().mockImplementation(async (key: string, value: unknown) => { storageStore.set(key, value) }),
        remove: vi.fn().mockImplementation(async (key: string) => { storageStore.delete(key) }),
        scan: vi.fn().mockImplementation(async ({ prefix }: { prefix: string }) => ({
          entries: [...storageStore.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
        })),
      },
      rpc: {
        register: vi.fn().mockImplementation(async (definition, handlers) => {
          if (definition.id === "opencode.models-discovery") Object.assign(rpcHandlers, handlers)
        }),
      },
    })

    try {
      await plugin.setup(ctx as never)
      const set = rpcHandlers.overrideSet as (input: unknown) => Promise<unknown>
      const refresh = rpcHandlers.refresh as (input?: unknown) => Promise<unknown>
      const status = rpcHandlers.status as (input?: unknown) => Promise<{
        providers: Array<{ models: Array<{ name: string; defaultValues?: { name: string } }> }>
      }>

      await set({ providerID: "local", modelID: "stable-model", patch: { name: "Custom name" } })
      await refresh({ force: true })
      const model = (await status({ details: true })).providers[0]?.models[0]
      expect(model?.name).toBe("Custom name")
      expect(model?.defaultValues?.name).toBe("stable-model")
    } finally {
      fetcher.mockRestore()
    }
  })

  it("removes a provider inventory when that provider is removed from configuration", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "model-before-removal" }] }),
    } as Response)
    let configured = true
    const rpcHandlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    const ctx = context({
      provider: {
        transform: vi.fn().mockImplementation(async (callback) => callback({ get: vi.fn().mockReturnValue(undefined), add: vi.fn(), update: vi.fn(), models: { set: vi.fn() } })),
        reload: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockImplementation(async () => ({ data: configured ? [{
          id: "local",
          name: "Local",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "http://127.0.0.1:1234/v1", modelsDiscovery: { enabled: true } },
        }] : [] })),
      },
      rpc: {
        register: vi.fn().mockImplementation(async (definition, handlers) => {
          if (definition.id === "opencode.models-discovery") Object.assign(rpcHandlers, handlers)
        }),
      },
    })

    try {
      await plugin.setup(ctx as never)
      const refresh = rpcHandlers.refresh as (input?: unknown) => Promise<unknown>
      const status = rpcHandlers.status as (input?: unknown) => Promise<{ providers: Array<{ id: string }> }>
      configured = false
      await refresh({ force: true })
      expect((await status({ details: true })).providers).toEqual([])
    } finally {
      fetcher.mockRestore()
    }
  })
})
