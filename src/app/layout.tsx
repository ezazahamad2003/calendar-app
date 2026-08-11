import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./auth.css";
import "./app.css";
import "./landing.css";

export const metadata: Metadata = {
  // Pages override this. The landing page sets its own, which is the one that
  // ends up in search results and link previews.
  title: "Foreman — construction scheduling you can talk to",
  description:
    "Move a date by saying so. Foreman cascades the dependent tasks, drafts the email and waits for you to confirm.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#173532",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
