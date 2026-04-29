import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // F-5.3 이미지 확장소재: 5MB 이미지 base64 + 메타. 여유 6MB.
      bodySizeLimit: "6mb",
    },
  },
}

export default nextConfig
