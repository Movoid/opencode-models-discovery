import { vi } from "vitest"
import { parseProviderDiscoveryOptions } from "../../src/v2/provider-config.js"

export const endpoint = "https://cpa.example/v1/models"
export const provider = {
  id: "cpa",
  package: "@opencode/ai/providers/openai-compatible-responses",
  settings: { baseURL: "https://cpa.example/v1" },
  apiKey: "fixture-key",
}

export const sol = {
  id: "gpt-6.2-sol",
  reasoning: true,
  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
}
export function options(settings: Record<string, unknown> = {}) {
  return new Map([["cpa", parseProviderDiscoveryOptions({
    enabled: true,
    modelInfoFormat: "models.dev",
    ...settings,
  })!]])
}

export function publicCatalog() {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "https://models.dev/models.json") {
      return Response.json({
        "openai/gpt-6.2-sol": { ...sol, id: "openai/gpt-6.2-sol" },
        "anthropic/claude-test": { id: "anthropic/claude-test", reasoning: true },
      })
    }
    if (url === "https://models.dev/api.json") {
      return Response.json({
        openai: { models: { [sol.id]: { ...sol, reasoning_options: [
          { type: "effort", values: ["low", "high", "xhigh", "max", "max", "default"] },
        ] } } },
        // The qualified ID in this gateway's own catalog is NOT the canonical row.
        other: { models: { ["openai/" + sol.id]: { ...sol, id: "openai/" + sol.id, reasoning_options: [
          { type: "effort", values: ["gateway-level"] },
        ] } } },
      })
    }
    throw new Error("unexpected public request")
  })
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}
