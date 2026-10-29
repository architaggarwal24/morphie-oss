import path from "node:path";
import { fileURLToPath } from "node:url";
import { allHeaders } from "./security-headers.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 writes an AGENTS.md into the project on `next dev`; Morphie ships its own docs.
  agentRules: false,
  // unpdf and mammoth are bundled, not left as externals: Turbopack links externals into .next/node_modules as
  // symlinks, which OpenNext then recreates, and Windows refuses to create symlinks without admin/Developer Mode.
  // Next 16 builds with Turbopack (dev and build), which reads tsconfig "paths" itself. Because a `turbopack` key is
  // present, Next uses it and ignores the `webpack` hook below; the hook only matters for an opt-out `next build --webpack`.
  // Pinning the root also silences the "multiple lockfiles" warning when a parent folder has its own package-lock.json.
  turbopack: { root },
  webpack(config) {
    config.resolve.alias["@"] = path.join(root, "src");
    return config;
  },
  async headers() {
    return allHeaders({ production: process.env.NODE_ENV === "production" });
  },
};
export default nextConfig;
