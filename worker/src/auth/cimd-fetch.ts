const MAX_METADATA_BYTES = 128 * 1024;

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPublicHttps(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopback(url.hostname);
}

/**
 * Workers-safe-ish CIMD fetch boundary. Cloudflare Workers do not expose DNS
 * resolution pinning, so keep the rest of the boundary strict: HTTPS except
 * loopback, no redirects, JSON only, and a bounded response body.
 */
export async function fetchClientMetadataResource(input: string | URL | Request) {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  if (!isPublicHttps(url)) {
    throw new Error("CIMD metadata must be fetched over HTTPS");
  }

  const response = await fetch(request, {
    redirect: "manual",
    headers: {
      Accept: "application/json",
      ...Object.fromEntries(request.headers),
    },
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("CIMD metadata redirects are not allowed");
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  if (response.ok && !contentType.includes("application/json")) {
    throw new Error("CIMD metadata must be JSON");
  }

  const length = Number(response.headers.get("Content-Length") ?? "0");
  if (length > MAX_METADATA_BYTES) {
    throw new Error("CIMD metadata response is too large");
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_METADATA_BYTES) {
    throw new Error("CIMD metadata response is too large");
  }

  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
