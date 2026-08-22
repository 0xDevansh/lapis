import { createAuthClient } from "better-auth/react";

/**
 * The web app and auth API are served from the same origin. Using Better
 * Auth's client keeps response shapes, cookie handling, and session-store
 * invalidation aligned with the server package.
 */
export const authClient = createAuthClient();
