import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { Env } from "../types";
import { fetchClientMetadataResource } from "./cimd-fetch";

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

export function getMcpResourceURL(baseURL: string): string {
  const resource = new URL("/api/mcp", baseURL);
  if (
    resource.protocol === "http:" &&
    resource.hostname !== "localhost" &&
    resource.hostname !== "127.0.0.1" &&
    resource.hostname !== "::1"
  ) {
    resource.protocol = "https:";
  }
  return resource.toString();
}

export function createAuth(env: Env) {
  const db = new Kysely({ dialect: new D1Dialect({ database: env.DB }) });
  const mcpResource = getMcpResourceURL(env.BETTER_AUTH_URL);

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
    plugins: [
      jwt(),
      mcp({
        loginPage: "/auth?mode=signin",
        consentPage: "/mcp/consent",
        resource: mcpResource,
        scopes: ["openid", "profile", "offline_access", "mcp:read", "mcp:write"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
