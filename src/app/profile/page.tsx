"use client";

import { useCallback, useEffect, useState } from "react";
import { Reveal, SplitText, TiltCard } from "@/components/motion";
import { apiCall, Banner, ErrorBanner, Icon, InitialLoad, rupees } from "@/components/ui";

type Profile = {
  name: string;
  timezone: string;
  default_cap_minor: number;
  email: string | null;
  phone: string | null;
};

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [cap, setCap] = useState("300");
  const [error, setError] = useState<{ message: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await apiCall<{ profile: Profile }>("/api/profile");
      setProfile(result.profile);
      setName(result.profile.name);
      setTimezone(result.profile.timezone);
      setCap(String(result.profile.default_cap_minor / 100));
    } catch (caught) {
      setError(caught as Error);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const result = await apiCall<{ profile: Profile }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ name, timezone, default_cap_minor: Math.round(Number(cap) * 100) }),
      });
      setProfile(result.profile);
      setName(result.profile.name);
      setTimezone(result.profile.timezone);
      setCap(String(result.profile.default_cap_minor / 100));
      setFlash("Profile saved.");
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <InitialLoad error={error} retry={() => void load()} />;

  return (
    <Reveal ready>
      <div data-reveal>
        <div className="eyebrow"><span className="blink" /> Workspace profile</div>
        <h1><SplitText text="Your workspace," accent="your settings." /></h1>
        <p className="lede">Keep the merchant identity, reporting timezone and default campaign budget in one place.</p>
      </div>

      <div className="grid two">
        <TiltCard className="card" data-reveal>
          <h3>Merchant details</h3>
          <div className="field">
            <label htmlFor="merchant-name">Merchant name</label>
            <input id="merchant-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your store name" />
          </div>
          <div className="field">
            <label htmlFor="timezone">Reporting timezone</label>
            <input id="timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Kolkata" />
          </div>
          <div className="field">
            <label htmlFor="default-cap">Default reward budget (₹)</label>
            <input id="default-cap" type="number" min="1" step="1" value={cap} onChange={(event) => setCap(event.target.value)} />
            <p className="help">New campaigns start with {rupees(Math.round(Number(cap || 0) * 100))} as the suggested limit.</p>
          </div>
          <div className="actions" style={{ marginTop: 16 }}>
            <button onClick={save} disabled={busy || name.trim().length < 2}>
              {busy ? <span className="spinner" /> : <Icon name="check" size={15} />} Save profile
            </button>
          </div>
          {flash ? <div style={{ marginTop: 12 }}><Banner tone="ok">{flash}</Banner></div> : null}
          <div style={{ marginTop: 12 }}><ErrorBanner error={error} /></div>
        </TiltCard>

        <TiltCard className="card" data-reveal>
          <h3>Account</h3>
          <div className="kv"><span className="key">Sign-in email</span><span className="value">{profile.email ?? "Connected account"}</span></div>
          <div className="kv"><span className="key">Phone</span><span className="value">{profile.phone ?? "Not connected"}</span></div>
          <p className="note">Authentication stays with Neon Auth. Your merchant profile and operational data stay in the workspace database.</p>
        </TiltCard>
      </div>
    </Reveal>
  );
}
