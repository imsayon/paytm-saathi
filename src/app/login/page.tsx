"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Reveal, SplitText, TiltCard } from "@/components/motion";
import { Banner, Icon } from "@/components/ui";
import { supabaseBrowser } from "@/lib/supabase-browser";

type Mode = "email" | "phone";

export default function LoginPage() {
  const router = useRouter();
  const supabase = supabaseBrowser();
  const [mode, setMode] = useState<Mode>("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callback = typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : "/auth/callback";

  async function sendCode() {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const result =
      mode === "email"
        ? await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: callback } })
        : await supabase.auth.signInWithOtp({ phone: phone.trim() });
    setBusy(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setSent(true);
  }

  async function verify() {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const result =
      mode === "email"
        ? await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" })
        : await supabase.auth.verifyOtp({ phone: phone.trim(), token: code.trim(), type: "sms" });
    setBusy(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function google() {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: callback } });
    if (oauthError) {
      setError(oauthError.message);
      setBusy(false);
    }
  }

  return (
    <Reveal ready>
      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Merchant sign-in
        </div>
        <h1>
          <SplitText text="Your shop," accent="your data." />
        </h1>
        <p className="lede">
          Sign in to get a private workspace. Every campaign, approval and report is scoped to your merchant account; nothing here is
          shared with the demo merchant.
        </p>
      </div>

      {!supabase ? (
        <div data-reveal>
          <Banner tone="warn" icon="alert">
            Sign-in is not configured on this deployment (missing <code>NEXT_PUBLIC_SUPABASE_URL</code> /{" "}
            <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>). The labelled demo session is available from <a href="/">Import</a>.
          </Banner>
        </div>
      ) : (
        <div className="grid two">
          <TiltCard className="card" data-reveal>
            <div className="split-label">
              <button className={`small ${mode === "email" ? "" : "secondary"}`} onClick={() => { setMode("email"); setSent(false); setError(null); }}>
                Email
              </button>
              <button className={`small ${mode === "phone" ? "" : "secondary"}`} onClick={() => { setMode("phone"); setSent(false); setError(null); }}>
                Mobile
              </button>
            </div>
            {mode === "email" ? (
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="email">Email address</label>
                <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} placeholder="you@example.com" />
              </div>
            ) : (
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="phone">Mobile number (with country code)</label>
                <input id="phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={sent} placeholder="+91 98765 43210" />
              </div>
            )}
            {sent ? (
              <div className="field">
                <label htmlFor="code">Enter the 6-digit code</label>
                <input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
                <p className="help">{mode === "email" ? "Sent to your inbox; the link in the email works too." : "Sent by SMS."}</p>
              </div>
            ) : null}
            <div className="actions" style={{ marginTop: 14 }}>
              {!sent ? (
                <button onClick={sendCode} disabled={busy || (mode === "email" ? !email.includes("@") : phone.trim().length < 8)}>
                  {busy ? <span className="spinner" /> : <Icon name="send" size={15} />} Send code
                </button>
              ) : (
                <>
                  <button onClick={verify} disabled={busy || code.trim().length < 6}>
                    {busy ? <span className="spinner" /> : <Icon name="check" size={15} />} Verify and sign in
                  </button>
                  <button className="ghost small" onClick={() => { setSent(false); setCode(""); }} disabled={busy}>
                    Use a different {mode === "email" ? "email" : "number"}
                  </button>
                </>
              )}
            </div>
            {error ? (
              <div style={{ marginTop: 12 }}>
                <Banner tone="bad" icon="alert">{error}</Banner>
              </div>
            ) : null}
          </TiltCard>

          <TiltCard className="card" data-reveal>
            <h3>Or continue with Google</h3>
            <p className="tiny muted" style={{ marginTop: 0 }}>Uses your Google account through Supabase Auth. No password is stored here.</p>
            <button className="secondary" onClick={google} disabled={busy}>
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9l3.3-2.5z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5L6.4 10c.8-2.3 3-4 5.6-4z"/></svg>
              Continue with Google
            </button>
            <div className="divider" />
            <p className="tiny muted" style={{ margin: 0 }}>
              Prefer to look around first? The <a href="/">demo merchant</a> needs no sign-in and uses synthetic data only.
            </p>
          </TiltCard>
        </div>
      )}
    </Reveal>
  );
}
