import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "E2E Hub", template: "%s · E2E Hub" },
  description: "Запуск и разбор E2E-прогонов на тестовых стендах",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
