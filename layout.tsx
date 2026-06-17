import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title:       "文字打ち替えAIアプリ",
  description: "画像内の文字をOCRで検出して編集・置換できるPWAアプリ",
  manifest:    "/manifest.json",
  appleWebApp: {
    capable:       true,
    statusBarStyle: "black-translucent",
    title:         "TextEditor",
  },
};

export const viewport: Viewport = {
  width:                 "device-width",
  initialScale:          1,
  maximumScale:          1,   // スマホでのピンチズームを無効化（編集操作と競合するため）
  userScalable:          false,
  themeColor:            "#0b0b0f",
  viewportFit:           "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <link rel="apple-touch-icon" sizes="192x192" href="/icon-192.png"/>
        <meta name="mobile-web-app-capable" content="yes"/>
      </head>
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function () {
                  navigator.serviceWorker.register('/sw.js').catch(function (err) {
                    console.warn('Service worker registration failed:', err);
                  });
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
