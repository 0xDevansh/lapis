import { betterAuth } from "better-auth";
import type { Env } from "../types";

/**
 * Create a better-auth instance bound to the Worker's D1 + KV bindings.
 * Called once per request (Workers are stateless across invocations).
 */
export function createAuth(env: Env) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    database: { provider: "sqlite", db: env.DB as any },
    emailAndPassword: {
      enabled: true,
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60 * 24 * 7, // 7 days
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
