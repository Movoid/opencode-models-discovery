const FALLBACK_VERSION = "0.171.0" // Verified native Codex catalog protocol.
const REGISTRY_URL = "https://registry.npmjs.org/@openai%2fcodex/latest"
const RECHECK_MS = 6 * 60 * 60 * 1000

let version = FALLBACK_VERSION
let checkAfter = 0

function registryVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const parts = value.split(".").map(Number)
  if (parts.length !== 3 || parts.join(".") !== value || !parts.every(part => Number.isSafeInteger(part) && part >= 0)) {
    return undefined
  }
  const floor = FALLBACK_VERSION.split(".").map(Number)
  const difference = parts.map((part, index) => part - floor[index]!).find(part => part !== 0)
  return difference !== undefined && difference < 0 ? FALLBACK_VERSION : value
}

async function refreshVersion(): Promise<void> {
  try {
    const response = await fetch(REGISTRY_URL, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    })
    if (response.status !== 200) return
    const metadata = await response.json()
    version = registryVersion(metadata?.version) ?? version
  } catch {
    // Retain the previous version if the registry is unavailable.
  } finally {
    checkAfter = performance.now() + RECHECK_MS
  }
}

/** Check lazily in the background; discovery never waits for npm. */
export function codexClientVersion(): string {
  if (performance.now() >= checkAfter) {
    checkAfter = Infinity
    void refreshVersion()
  }
  return version
}
