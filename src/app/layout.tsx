import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WINDTUNNEL",
  description: "Agents shouldn't make the same mistake twice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
