import type { Metadata, Viewport } from "next";

import "./globals.css";
import "./chart.css";
import "./assistant.css";

export const metadata: Metadata = {
  title: "Foreman — the job schedule",
  description:
    "The wall chart, on your phone. Say what changed and it works out what moves with it.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the title block, so the phone's status bar reads as part of the
  // sheet rather than sitting on top of it.
  themeColor: "#f8fafc",
  // The one screen that must survive being pinched: the chart is deliberately
  // wider than a phone, and zooming it is a legitimate thing to want.
  maximumScale: 5,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
