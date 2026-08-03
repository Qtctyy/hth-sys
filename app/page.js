'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabaseClient';

const AGENTS = ['Hamzah', 'Hemam', 'Talal'];

const emptyForm = {
  name: '',
  mobile_number: '',
  building_number: '',
  street_name: '',
  to_work_pickup: '',
  to_work_dest: '',
  to_work_time: '15:00',
  way_back_enabled: true,
  way_back_pickup: '',
  way_back_dest: '',
  way_back_time: '21:00',
  amount: '',
  notes: '',
  agent: AGENTS[0],
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isUrl(str) {
  if (!str) return false;
  return /^https?:\/\//i.test(str.trim());
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = parseInt(h, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m} ${ampm}`;
}

function minutesUntil(t, now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const [h, m] = t.split(':').map(Number);
  let mins = h * 60 + m - nowMin;
  if (mins < 0) mins += 24 * 60;
  return mins;
}

function sortKey(ride, now, today) {
  const legs = [];
  if (ride.to_work_time) {
    legs.push({ done: ride.to_work_completed_date === today, time: ride.to_work_time });
  }
  if (ride.way_back_enabled && ride.way_back_time) {
    legs.push({ done: ride.way_back_completed_date === today, time: ride.way_back_time });
  }
  const pending = legs.filter((l) => !l.done);
  if (pending.length === 0) return [1, Infinity];
  return [0, Math.min(...pending.map((l) => minutesUntil(l.time, now)))];
}

export default function HomePage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [rides, setRides] = useState([]);
  const [loadingRides, setLoadingRides] = useState(true);
  const [form, setForm] = useState({ ...emptyForm });
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const [filterAgent, setFilterAgent] = useState(AGENTS[0]);

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

  const loadRides = useCallback(async () => {
    setLoadingRides(true);
    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setRides(data || []);
    setLoadingRides(false);
  }, []);

  useEffect(() => {
    if (session) loadRides();
  }, [session, loadRides]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
  }

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function resetForm() {
    setForm({ ...emptyForm, agent: filterAgent });
    setEditingId(null);
  }

  function startEdit(ride) {
    setForm({
      name: ride.name || '',
      mobile_number: ride.mobile_number || '',
      building_number: ride.building_number || '',
      street_name: ride.street_name || '',
      to_work_pickup: ride.to_work_pickup || '',
      to_work_dest: ride.to_work_dest || '',
      to_work_time: ride.to_work_time || '15:00',
      way_back_enabled: ride.way_back_enabled !== false,
      way_back_pickup: ride.way_back_pickup || '',
      way_back_dest: ride.way_back_dest || '',
      way_back_time: ride.way_back_time || '21:00',
      amount: ride.amount ?? '',
      notes: ride.notes || '',
      agent: ride.agent || AGENTS[0],
    });
    setEditingId(ride.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) {
      setError('Add a customer name first.');
      return;
    }
    setSaving(true);

    const payload = {
      agent: form.agent,
      name: form.name.trim(),
      mobile_number: form.mobile_number.trim(),
      building_number: form.building_number.trim(),
      street_name: form.street_name.trim(),
      to_work_pickup: form.to_work_pickup.trim(),
      to_work_dest: form.to_work_dest.trim(),
      to_work_time: form.to_work_time,
      way_back_enabled: form.way_back_enabled,
      way_back_pickup: form.way_back_enabled ? form.way_back_pickup.trim() : '',
      way_back_dest: form.way_back_enabled ? form.way_back_dest.trim() : '',
      way_back_time: form.way_back_enabled ? form.way_back_time : '',
      amount: parseFloat(form.amount) || 0,
      notes: form.notes.trim(),
    };

    let saveError;
    if (editingId) {
      const { error } = await supabase.from('rides').update(payload).eq('id', editingId);
      saveError = error;
    } else {
      payload.user_id = session.user.id;
      const { error } = await supabase.from('rides').insert(payload);
      saveError = error;
    }

    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setFilterAgent(form.agent);
    resetForm();
    loadRides();
  }

  async function handleDelete(id) {
    if (!confirm('Delete this ride?')) return;
    const { error } = await supabase.from('rides').delete().eq('id', id);
    if (error) setError(error.message);
    else loadRides();
  }

  async function toggleComplete(ride, leg) {
    const field = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
    const isDone = ride[field] === todayStr();
    const { error } = await supabase
      .from('rides')
      .update({ [field]: isDone ? null : todayStr() })
      .eq('id', ride.id);
    if (error) setError(error.message);
    else loadRides();
  }

  async function copyNumber(ride) {
    if (!ride.mobile_number) return;
    try {
      await navigator.clipboard.writeText(ride.mobile_number);
      setCopiedId(ride.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      // Clipboard API unavailable — fail silently.
    }
  }

  function renderLocation(value) {
    if (!value) return null;
    if (isUrl(value)) {
      return (
        <a className="loc-link" href={value} target="_blank" rel="noopener noreferrer">
          Open location
        </a>
      );
    }
    return <span>{value}</span>;
  }

  if (session === undefined) {
    return <div className="center-screen"><div className="loading">Loading...</div></div>;
  }
  if (!session) return null;

  const today = todayStr();
  const now = new Date();
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const filteredRides = rides.filter((r) => r.agent === filterAgent);
  const sorted = [...filteredRides].sort((a, b) => {
    const [pa, ta] = sortKey(a, now, today);
    const [pb, tb] = sortKey(b, now, today);
    if (pa !== pb) return pa - pb;
    return ta - tb;
  });
  const total = filteredRides.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const firstPendingId = sorted.find((r) => sortKey(r, now, today)[0] === 0)?.id;

  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <div className="eyebrow">Ride Log</div>
          <div className="date-bar">{dateLabel}</div>
        </div>
        <button className="link" onClick={handleSignOut}>Sign out</button>
      </div>

      <h1 style={{ marginTop: 16 }}>{editingId ? 'Edit ride' : 'Add a ride'}</h1>
      <div className="sub" style={{ marginBottom: 16 }}>Fill it in, pick the agent last, hit save.</div>

      <form className="card" onSubmit={handleSave}>
        <label>Customer name</label>
        <input value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="e.g. Layla Hasan" />

        <label>Mobile number</label>
        <input value={form.mobile_number} onChange={(e) => updateField('mobile_number', e.target.value)} placeholder="07XXXXXXXX" inputMode="tel" />

        <div className="row2">
          <div>
            <label>Building number</label>
            <input value={form.building_number} onChange={(e) => updateField('building_number', e.target.value)} placeholder="12" />
          </div>
          <div>
            <label>Street name</label>
            <input value={form.street_name} onChange={(e) => updateField('street_name', e.target.value)} placeholder="Al Madina St." />
          </div>
        </div>

        <div className="trip-block to-work">
          <div className="section-label"><span className="dot green"></span> To work</div>
          <div className="row2">
            <div>
              <label>Pickup location (or link)</label>
              <input value={form.to_work_pickup} onChange={(e) => updateField('to_work_pickup', e.target.value)} placeholder="Home - Sweifieh or maps link" />
            </div>
            <div>
              <label>Destination (or link)</label>
              <input value={form.to_work_dest} onChange={(e) => updateField('to_work_dest', e.target.value)} placeholder="Job - Downtown or maps link" />
            </div>
          </div>
          <label>Pickup time</label>
          <input type="time" value={form.to_work_time} onChange={(e) => updateField('to_work_time', e.target.value)} />
        </div>

        <div className="toggle-row">
          <span>Include way back home</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={form.way_back_enabled}
              onChange={(e) => updateField('way_back_enabled', e.target.checked)}
            />
            <span className="track"></span>
          </label>
        </div>

        {form.way_back_enabled && (
          <div className="trip-block way-back">
            <div className="section-label"><span className="dot coral"></span> Way back home</div>
            <div className="row2">
              <div>
                <label>Pickup location (or link)</label>
                <input value={form.way_back_pickup} onChange={(e) => updateField('way_back_pickup', e.target.value)} placeholder="Job - Downtown or maps link" />
              </div>
              <div>
                <label>Destination (or link)</label>
                <input value={form.way_back_dest} onChange={(e) => updateField('way_back_dest', e.target.value)} placeholder="Home - Sweifieh or maps link" />
              </div>
            </div>
            <label>Pickup time</label>
            <input type="time" value={form.way_back_time} onChange={(e) => updateField('way_back_time', e.target.value)} />
          </div>
        )}

        <label>Amount paid</label>
        <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => updateField('amount', e.target.value)} placeholder="0.00" inputMode="decimal" />

        <label>Notes (optional)</label>
        <textarea rows={2} value={form.notes} onChange={(e) => updateField('notes', e.target.value)} placeholder="Anything worth remembering" />

        <label>Agent</label>
        <select value={form.agent} onChange={(e) => updateField('agent', e.target.value)}>
          {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>

        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving...' : editingId ? 'Update ride' : 'Save ride'}
        </button>
        {editingId && (
          <button type="button" className="link" style={{ marginTop: 10 }} onClick={resetForm}>
            Cancel edit
          </button>
        )}
        {error && <div className="error-msg">{error}</div>}
      </form>

      <div className="tabs">
        {AGENTS.map((a) => (
          <div
            key={a}
            className={`tab ${filterAgent === a ? 'active' : ''}`}
            onClick={() => setFilterAgent(a)}
          >
            {a}
          </div>
        ))}
      </div>

      <div className="list-header">
        <h2>{filterAgent}'s rides</h2>
        <div className="total-pill">${total.toFixed(2)}</div>
      </div>

      {loadingRides ? (
        <div className="loading">Loading...</div>
      ) : sorted.length === 0 ? (
        <div className="empty">No rides yet for {filterAgent}. Add one above.</div>
      ) : (
        sorted.map((r) => {
          const toWorkDone = r.to_work_completed_date === today;
          const wayBackDone = r.way_back_enabled && r.way_back_completed_date === today;
          const isNextUp = r.id === firstPendingId;
          return (
            <div className={`entry ${isNextUp ? 'next-up' : ''}`} key={r.id}>
              {isNextUp && (
                <div className="next-up-tag">
                  <span className="pulse-dot"></span> Up next
                </div>
              )}
              <div className="entry-top">
                <div className="entry-name">{r.name}</div>
                <div className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</div>
              </div>

              {(r.building_number || r.street_name) && (
                <div className="notes" style={{ fontStyle: 'normal' }}>
                  {[r.building_number, r.street_name].filter(Boolean).join(' - ')}
                </div>
              )}

              {r.mobile_number && (
                <div className="copy-row">
                  <span>{r.mobile_number}</span>
                  <button className="copy-btn" onClick={() => copyNumber(r)}>
                    {copiedId === r.id ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              )}

              {r.to_work_time && (
                <>
                  <div className="trip-line">
                    <span className="trip-tag to-work">To work</span>
                    <span className="trip-time">{fmtTime(r.to_work_time)}</span>
                    <span>{renderLocation(r.to_work_pickup)} → {renderLocation(r.to_work_dest)}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <button
                      className={`complete-btn ${toWorkDone ? 'done' : ''}`}
                      onClick={() => toggleComplete(r, 'to_work')}
                    >
                      {toWorkDone ? '✓ Completed' : 'Mark to-work complete'}
                    </button>
                  </div>
                </>
              )}

              {r.way_back_enabled && r.way_back_time && (
                <>
                  <div className="trip-line">
                    <span className="trip-tag way-back">Way back</span>
                    <span className="trip-time">{fmtTime(r.way_back_time)}</span>
                    <span>{renderLocation(r.way_back_pickup)} → {renderLocation(r.way_back_dest)}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <button
                      className={`complete-btn ${wayBackDone ? 'done' : ''}`}
                      onClick={() => toggleComplete(r, 'way_back')}
                    >
                      {wayBackDone ? '✓ Completed' : 'Mark way-back complete'}
                    </button>
                  </div>
                </>
              )}

              {r.notes && <div className="notes">{r.notes}</div>}

              <div className="entry-actions">
                <button onClick={() => startEdit(r)}>Edit</button>
                <button onClick={() => handleDelete(r.id)}>Delete</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
