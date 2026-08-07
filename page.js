'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);

    if (mode === 'signup') {
      const { error } = await supabase.auth.signUp({ email, password });
      setLoading(false);
      if (error) {
        setError(error.message);
        return;
      }
      setInfo('Account created. Check your email to confirm, then sign in.');
      setMode('signin');
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <div className="center-screen">
      <div className="wrap" style={{ maxWidth: 380 }}>
        <div className="eyebrow">Ride Log</div>
        <h1>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
        <div className="sub">
          {mode === 'signin'
            ? 'Your rides, kept separate from everyone else on the team.'
            : 'Takes a second. You\'ll each see only your own rides.'}
        </div>

        <form className="card" onSubmit={handleSubmit} style={{ marginTop: 20 }}>
          <label>Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <label>Password</label>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 6 characters"
          />
          <button className="primary" type="submit" disabled={loading}>
            {loading ? 'Please wait...' : mode === 'signin' ? 'Sign in' : 'Sign up'}
          </button>
          {error && <div className="error-msg">{error}</div>}
          {info && <div className="error-msg" style={{ background: 'var(--green-dim)', color: 'var(--green)' }}>{info}</div>}
        </form>

        <div style={{ textAlign: 'center', marginTop: 4 }}>
          {mode === 'signin' ? (
            <button className="link" onClick={() => { setMode('signup'); setError(''); setInfo(''); }}>
              Don't have an account? Sign up
            </button>
          ) : (
            <button className="link" onClick={() => { setMode('signin'); setError(''); setInfo(''); }}>
              Already have an account? Sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
