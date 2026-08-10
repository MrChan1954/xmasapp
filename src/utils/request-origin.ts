import "server-only";

export function getRequestOrigin(request: Request) {
  const configuredOrigin = process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL;
  if (configuredOrigin) {
    try {
      const configuredUrl = new URL(configuredOrigin);
      if (
        (configuredUrl.protocol === "http:" || configuredUrl.protocol === "https:") &&
        !configuredUrl.username &&
        !configuredUrl.password
      ) {
        return configuredUrl.origin;
      }
    } catch {
      // Fall back to the framework-normalized request URL below.
    }
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
    throw new Error("The request origin is not HTTP or HTTPS.");
  }
  return requestUrl.origin;
}
