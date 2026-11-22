import { setImmediate } from "node:timers/promises"
import { afterEach, expect, it, vi } from "vitest"

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it("supplies an offline version immediately and keeps a successful registry update during an outage", async () => {
  vi.useFakeTimers({ toFake: ["performance"] })
  const registry = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ version: "1.0.0" }))
    .mockRejectedValue(new Error("offline"))
  vi.stubGlobal("fetch", registry)
  const { codexClientVersion } = await import("../../src/v2/codex-client-version.js")
  expect(codexClientVersion()).toBe("0.171.0")
  await setImmediate()
  expect(codexClientVersion()).toBe("1.0.0")
  vi.advanceTimersByTime(24 * 60 * 60 * 1000)
  codexClientVersion()
  await setImmediate()
  expect(codexClientVersion()).toBe("1.0.0")
})
