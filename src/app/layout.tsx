import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Morphie",
  description: "A multi-provider AI workspace: chat, an autonomous agent, documents, memory and a design studio.",
};
// viewportFit "cover" lets the app paint edge to edge under the notch / Dynamic Island / home indicator; every tappable
// edge then pads itself with env(safe-area-inset-*) (see the *-safe utilities in globals.css).
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#0d0e11" }, { media: "(prefers-color-scheme: light)", color: "#f6f3ee" }] };

// Applies the saved theme before first paint so there's no light/dark flash.
const THEME_INIT = `try{var t=localStorage.getItem("morphie.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined; // also opts the page into dynamic rendering so the nonce applies
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Browsers hide nonce attributes from the DOM once parsed, so React would report a false mismatch here. */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
