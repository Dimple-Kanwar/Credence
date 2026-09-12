/**
 * Minimal browser shim for the Node `crypto` module, aliased from the Vite
 * config so @worldcoin/agentkit's ESM bundle can bind its top-level
 * `import { randomBytes } from "crypto"` in-browser.
 *
 * That import belongs to the SDK's server-side resource-extension
 * (`agentkitResourceServerExtension`), which the browser never executes — we
 * only use `createAgentkitClient` + `declareAgentkitExtension` for signing an
 * `agentkit` header. This shim exists purely so the module graph binds the
 * named export; the implementation is a real CSPRNG via Web Crypto anyway.
 *
 * See vite.config.js -> resolve.alias.crypto.
 */
export function randomBytes(size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}