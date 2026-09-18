import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paytm Saathi",
  description: "Bounded merchant-retention workflow: signal, plan, approval, mock delivery, holdout report.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="inner">
            <div className="brand">
              <span className="dot" />
              Paytm Saathi
            </div>
            <nav>
              <a href="/">Import</a>
              <a href="/signals">Signal</a>
            </nav>
          </div>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
