import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/demo": ["./artifacts/final-demo.json"],
  },
};

export default nextConfig;
