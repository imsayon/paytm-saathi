import type { Metadata, Viewport } from "next";
import { Icon, Nav } from "@/components/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paytm Saathi",
  description: "Bounded merchant-retention workflow: signal, plan, approval, mock delivery, holdout report.",
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
              <small>retention, approved and measured</small>
            </a>
            <Nav />
          </div>
        </header>
        <main className="shell">{children}</main>
        <footer className="footer">
          <div className="inner">
            <span>synthetic demo · no live paytm integration · no real customer is contacted</span>
            <span>rules own eligibility, consent, budget and state · the model only drafts</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
