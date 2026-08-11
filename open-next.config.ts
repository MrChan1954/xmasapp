import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * No incremental cache override is configured. Every route this app serves is
 * either `force-dynamic` (the admin API) or client-rendered from Supabase, so
 * there is no ISR output to cache. Adding the R2 cache would mean provisioning
 * a bucket for nothing — revisit only if a route starts using `revalidate`.
 */
export default defineCloudflareConfig();
