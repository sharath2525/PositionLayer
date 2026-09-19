import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["@jup-ag/lend-read", "@jup-ag/lend", "@solana/web3.js", "@solana/spl-token"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "xstocks-metadata.backed.fi", pathname: "/logos/tokens/**" }],
  },
  poweredByHeader: false,
  devIndicators: false,
};
export default config;
