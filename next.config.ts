import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // C'è un package-lock.json vagante in ~ che confonde l'inferenza della root
    root: __dirname,
  },
};

export default nextConfig;
