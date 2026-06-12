import { betterAuth } from "better-auth";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { Env } from "../types";

/**
 * Create a better-auth instance bound to the Worker's D1 + KV bindings.
 * Called once per request (Workers are stateless across invocations).
 */
export function createAuth(env: Env) {
  const db = new Kysely({ dialect: new D1Dialect({ database: env.DB }) });
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: kyselyAdapter(db, { type: "sqlite" }),
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
