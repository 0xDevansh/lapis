import { betterAuth } from "better-auth";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { Env } from "../types";

/**
 * Create a Better Auth instance backed by the Worker's D1 binding.
 * Called once per request (Workers are stateless across invocations).
 */
export function getTrustedOrigins(baseURL: string): string[] {
  const appOrigin = new URL(baseURL).origin;
  const trustedOrigins = [appOrigin];
  if (new URL(appOrigin).hostname === "localhost") {
    trustedOrigins.push("http://localhost:5173");
  }
  return trustedOrigins;
}

export function createAuth(env: Env) {
  const db = new Kysely({ dialect: new D1Dialect({ database: env.DB }) });

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: getTrustedOrigins(env.BETTER_AUTH_URL),
    database: kyselyAdapter(db, { type: "sqlite" }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {},
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        trustedProviders: ["google"],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
