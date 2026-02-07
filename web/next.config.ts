import type { NextConfig } from "next";

const internalApiTarget = process.env.INTERNAL_API_TARGET || "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${internalApiTarget}/api/:path*`,
      },
      {
        source: "/cache/:path*",
        destination: `${internalApiTarget}/cache/:path*`,
      },
    ];
  },
};

export default nextConfig;
