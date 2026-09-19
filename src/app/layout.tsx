import type { Metadata, Viewport } from "next";
import { Icon, Nav } from "@/components/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paytm Saathi",
  description: "A simple workspace for understanding customer activity and planning thoughtful offers.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#070d1f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>
        <div className="ambient" aria-hidden="true">
          <div className="dots" />
          <div className="glow a" />
          <div className="glow b" />
          <div className="grain" />
        </div>
        <header className="topbar">
          <div className="inner">
            <a className="brand" href="/">
              <span className="mark">
                <Icon name="spark" />
              </span>
              Paytm Saathi
              <small>merchant workspace</small>
            </a>
            <Nav />
          </div>
        </header>
        <main className="shell">{children}</main>
        <footer className="footer">
          <div className="inner">
            <span>Paytm Saathi · merchant workspace</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
