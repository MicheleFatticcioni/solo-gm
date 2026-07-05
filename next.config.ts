import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // C'è un package-lock.json vagante in ~ che confonde l'inferenza della root
    root: __dirname,
  },
  experimental: {
    // Il proxy (src/proxy.ts) bufferizza il body in memoria per poterlo rileggere
    // nella route handler; il default è 10MB e tronca silenziosamente gli upload
    // PDF più grandi. Allineato al limite MAX_PDF_MB (vedi .env.example).
    proxyClientMaxBodySize: "100mb",
  },
};

export default nextConfig;
