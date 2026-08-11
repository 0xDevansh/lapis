import { betterAuth } from "better-auth";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { Env } from "../types";

/**
 * Create a better-auth instance bound to the Worker's D1 binding.
 * Called once per request (Workers are stateless across invocations).
 */
export function createAuth(env: Env) {
  const db = new Kysely({ dialect: new D1Dialect({ database: env.DB }) });

  const socialProviders: {
    google?: { clientId: string; clientSecret: string; prompt?: "select_account" };
  } = {};

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      prompt: "select_account",
    };
  }

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: kyselyAdapter(db, { type: "sqlite" }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders,
    trustedOrigins: [
      env.BETTER_AUTH_URL,
      "http://localhost:5173",
      "http://localhost:8787",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:8787",
    ],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60 * 24 * 7, // 7 days
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
