import type { NextConfig } from "next";
const dev = process.env.NODE_ENV === "development";
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  turbopack: { root: process.cwd() },
  ...(dev
    ? {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: "http://127.0.0.1:8000/api/:path*",
            },
          ];
        },
      }
    : {}),
};
export default config;
