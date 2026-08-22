import type { VaultCoordinator } from "./vault/coordinator";

/**
 * Cloudflare Worker environment bindings.
 * Must stay in sync with wrangler.jsonc.
 *
 * Types are sourced from the wrangler-generated worker-configuration.d.ts
 * (run `pnpm cf-typegen` to regenerate after changing wrangler.jsonc).
 */
export interface Env {
  // Durable Objects
  VAULT_COORDINATOR: DurableObjectNamespace<VaultCoordinator>;

  // Storage
  VAULT_BUCKET: R2Bucket;
  DB: D1Database;
  KV: KVNamespace;

  // Artifacts — sealed Git history
  ARTIFACTS: Artifacts;

  // Static assets (web SPA)
  ASSETS: Fetcher;

  // Secrets
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  /** Secret used to encrypt GitHub PATs at rest before storing in D1 (Slice 25) */
  GITHUB_PAT_ENCRYPTION_KEY?: string;
}

/** Session context set by requireSession middleware */
export interface SessionContext {
  userId: string;
  sessionId: string;
}

// Hono variable type augmentation
declare module "hono" {
  interface ContextVariableMap {
    session: SessionContext;
  }
}
