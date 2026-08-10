import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./auth.css";
import "./enhancements.css";
import "./timeline.css";
import "./management.css";

export const metadata: Metadata = {
  title: "Foreman | Construction Schedule",
  description: "AI-assisted crew and project scheduling for Northstar Builders.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#173532",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
