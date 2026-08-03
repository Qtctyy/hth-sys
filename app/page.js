'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabaseClient';

const AGENTS = ['Hamzah', 'Hemam', 'Talal'];

export default function HomePage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push('/login');
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      if (!sess) router.push('/login');
    });
    return () => listener.subscription.unsubscribe();
  }, [router]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
  }

  if (session === undefined) {
    return <div className="center-screen"><div className="loading">Loading...</div></div>;
  }
  if (!session) return null;

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <div className="eyebrow">Ride Log</div>
          <div className="date-bar" style={{ marginBottom: 0 }}>{today}</div>
        </div>
        <button className="link" onClick={handleSignOut}>Sign out</button>
      </div>

      <h1 style={{ marginTop: 16, marginBottom: 6 }}>Who's this for?</h1>
      <div className="sub" style={{ marginBottom: 20 }}>Pick an agent to see or add their rides.</div>

      {AGENTS.map((agent) => (
        <a key={agent} className="menu-btn" href={`/rides?agent=${encodeURIComponent(agent)}`}>
          {agent}
        </a>
      ))}
    </div>
  );
}
