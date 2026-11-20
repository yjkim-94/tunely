import type { Metadata, Viewport } from "next";
import "./globals.css";
import { DEFAULT_LOOK, EARLY_LOOK_SCRIPT } from "./look-config";
export const metadata: Metadata = {
  title: "Tunely · 나만의 음악",
  description: "찾고, 담고, 어디서나 들어요.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Tunely" },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#efe6d3",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="ko"
      data-theme={DEFAULT_LOOK.theme}
      data-accent={DEFAULT_LOOK.accent}
      data-title-font={DEFAULT_LOOK.font}
      data-icons={DEFAULT_LOOK.icons}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the saved 꾸미기 settings before the first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_LOOK_SCRIPT }} />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css"
        />
      </head>
      <body>
        {/* Shared filters for the hand-drawn icon set (DESIGN.md §7). */}
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
          <defs>
            <filter
              id="tunely-wob1"
              x="-10%"
              y="-10%"
              width="120%"
              height="120%"
            >
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.09"
                numOctaves={2}
                seed={4}
              />
              <feDisplacementMap in="SourceGraphic" scale={0.9} />
            </filter>
            <filter
              id="tunely-wob2"
              x="-10%"
              y="-10%"
              width="120%"
              height="120%"
            >
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.12"
                numOctaves={2}
                seed={11}
              />
              <feDisplacementMap in="SourceGraphic" scale={1.2} />
            </filter>
          </defs>
        </svg>
        {children}
      </body>
    </html>
  );
}
