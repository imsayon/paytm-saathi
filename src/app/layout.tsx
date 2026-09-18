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
  themeColor: "#012970",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body>
        <div className="ambient" aria-hidden="true" />
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
          <span>Synthetic demo. No live Paytm integration, no real customer is contacted.</span>
          <span>Rules own eligibility, consent, budget and state; the model only drafts.</span>
        </footer>
      </body>
    </html>
  );
}
