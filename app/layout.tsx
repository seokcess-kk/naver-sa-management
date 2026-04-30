import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "네이버 SA 운영 어드민",
  description: "네이버 검색광고 다계정 운영 어드민",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {/* GNB 헤더(h-12 = 48px) 아래로 토스트가 떨어지도록 offset.
            top: 헤더 + 여유 8px. mobileOffset: 모바일에서도 동일 적용. */}
        <Toaster
          richColors
          position="top-right"
          offset={{ top: "56px", right: "16px" }}
          mobileOffset={{ top: "56px", right: "8px" }}
        />
      </body>
    </html>
  );
}
