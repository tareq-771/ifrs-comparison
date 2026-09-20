import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Phase 4B.1 — distDir قابل للتهيئة كي يعمل خادم الاختبار المعزول (منفذ
  // مختلف + .next خاص به) جنبًا إلى جنب مع خادم التشغيل دون تعارض dev-lock.
  // غياب المتغير = .next الافتراضي (سلوك الإنتاج غير متأثر إطلاقًا).
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
