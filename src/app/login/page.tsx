"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Reveal, SplitText, TiltCard } from "@/components/motion";
import { Banner, Icon } from "@/components/ui";
import { neonAuthClient } from "@/lib/neon-auth-browser";

type Mode = "sign_in" | "sign_up";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((response) => response.json())
      .then((body: { auth_configured?: boolean }) => setConfigured(body.auth_configured === true))
      .catch(() => setConfigured(false));
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "sign_in"
          ? await neonAuthClient.signIn.email({ email: email.trim(), password })
          : await neonAuthClient.signUp.email({ email: email.trim(), password, name: name.trim() });
      if (result.error) {
        setError(result.error.message ?? "Authentication failed.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    setError(null);
    try {
      const result = await neonAuthClient.signIn.social({ provider: "google", callbackURL: "/" });
      if (result.error) {
        setError(result.error.message ?? "Google sign-in failed.");
        setBusy(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Google sign-in failed.");
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
          Sign in to open a private workspace. Campaigns, approvals and reports stay scoped to your merchant account.
        </p>
      </div>

      {configured === false ? (
        <div data-reveal>
          <Banner tone="warn" icon="alert">Authentication is temporarily unavailable. Please try again shortly.</Banner>
        </div>
      ) : (
        <div className="grid two">
          <TiltCard className="card" data-reveal>
            <div className="split-label">
              <button className={`small ${mode === "sign_in" ? "" : "secondary"}`} onClick={() => { setMode("sign_in"); setError(null); }}>
                Sign in
              </button>
              <button className={`small ${mode === "sign_up" ? "" : "secondary"}`} onClick={() => { setMode("sign_up"); setError(null); }}>
                Create account
              </button>
            </div>
            {mode === "sign_up" ? (
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="name">Your name</label>
                <input id="name" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Aarav Mehta" />
              </div>
            ) : null}
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="email">Email address</label>
              <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete={mode === "sign_in" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" />
            </div>
            <div className="actions" style={{ marginTop: 14 }}>
              <button onClick={() => void submit()} disabled={busy || !email.includes("@") || password.length < 8 || (mode === "sign_up" && name.trim().length < 2)}>
                {busy ? <span className="spinner" /> : <Icon name={mode === "sign_in" ? "arrow" : "check"} size={15} />}
                {mode === "sign_in" ? "Sign in with email" : "Create with email"}
              </button>
            </div>
            {error ? (
              <div style={{ marginTop: 12 }}>
                <Banner tone="bad" icon="alert">{error}</Banner>
              </div>
            ) : null}
          </TiltCard>

          <TiltCard className="card" data-reveal>
            <h3>Or continue with Google</h3>
            <p className="tiny muted" style={{ marginTop: 0 }}>Use your Google account to open the same private workspace.</p>
            <button className="secondary" onClick={() => void google()} disabled={busy}>
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 01-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0012 22z"/><path fill="#FBBC05" d="M6.4 14a6 6 0 010-3.9V7.5H3.1a10 10 0 000 9l3.3-2.5z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 003.1 7.5L6.4 10c.8-2.3 3-4 5.6-4z"/></svg>
              Continue with Google
            </button>
            <div className="divider" />
            <p className="tiny muted" style={{ margin: 0 }}>
              Need a quick look first? Open the <a href="/">preview workspace</a>.
            </p>
          </TiltCard>
        </div>
      )}
    </Reveal>
  );
}
