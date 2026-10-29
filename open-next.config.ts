import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Morphie has no ISR / static data cache needs: every page and API route is dynamic and per-user,
// so the default (no incremental cache) is correct. Add an R2/KV cache override here only if you
// later add cached pages. See https://opennext.js.org/cloudflare/caching
//
// The Worker is built with webpack: Turbopack repeats shared server code in every route's chunks, which made the
// Worker 3.7 MB gzipped, over the Workers Free plan's 3 MB. webpack shares it (about 2.8 MB).
export default { ...defineCloudflareConfig(), buildCommand: "npx next build --webpack" };
