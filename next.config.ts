import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
const supabaseConnections = (() => {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const websocket = new URL(url);
    websocket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${url.origin} ${websocket.origin}`;
  } catch {
    return "";
  }
})();
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseConnections}${isDevelopment ? " ws:" : ""}`.trim(),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  ...(!isDevelopment ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  // Development only; `next build` and `next start` never read this. The dev
  // server binds 0.0.0.0, so Next auto-allows "0.0.0.0" rather than the LAN
  // address a phone actually connects to, which blocks HMR and the error
  // overlay for on-device testing.
  allowedDevOrigins: ["localhost", "192.168.0.11"],

  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default nextConfig;
