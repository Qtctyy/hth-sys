'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabaseClient';

const emptyForm = {
  name: '',
  to_work_pickup: '',
  to_work_dest: '',
  to_work_time: '15:00',
  way_back_pickup: '',
  way_back_dest: '',
  way_back_time: '21:00',
  amount: '',
  notes: '',
};

function nextTripMinutes(ride, now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const times = [ride.to_work_time, ride.way_back_time].filter(Boolean);
  if (times.length === 0) return Infinity;
  const upcoming = times.map((t) => {
    const [h, m] = t.split(':').map(Number);
    let mins = h * 60 + m - nowMin;
    if (mins < 0) mins += 24 * 60;
    return mins;
  });
  return Math.min(...upcoming);
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = parseInt(h, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m} ${ampm}`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [rides, setRides] = useState([]);
  const [loadingRides, setLoadingRides] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
    if (error) {
      setError(error.message);
    } else {
      setRides(data || []);
    }
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
    setForm(emptyForm);
    setEditingId(null);
  }

  function startEdit(ride) {
    setForm({
      name: ride.name,
      to_work_pickup: ride.to_work_pickup || '',
      to_work_dest: ride.to_work_dest || '',
      to_work_time: ride.to_work_time || '15:00',
      way_back_pickup: ride.way_back_pickup || '',
      way_back_dest: ride.way_back_dest || '',
      way_back_time: ride.way_back_time || '21:00',
      amount: ride.amount ?? '',
      notes: ride.notes || '',
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
      name: form.name.trim(),
      to_work_pickup: form.to_work_pickup.trim(),
      to_work_dest: form.to_work_dest.trim(),
      to_work_time: form.to_work_time,
      way_back_pickup: form.way_back_pickup.trim(),
      way_back_dest: form.way_back_dest.trim(),
      way_back_time: form.way_back_time,
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
    resetForm();
    loadRides();
  }

  async function handleDelete(id) {
    if (!confirm('Delete this ride?')) return;
    const { error } = await supabase.from('rides').delete().eq('id', id);
    if (error) {
      setError(error.message);
      return;
    }
    loadRides();
  }

  if (session === undefined) {
    return <div className="center-screen"><div className="loading">Loading...</div></div>;
  }
  if (!session) return null; // redirecting

  const now = new Date();
  const sorted = [...rides].sort((a, b) => nextTripMinutes(a, now) - nextTripMinutes(b, now));
  const total = rides.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <div className="eyebrow">Ride Log</div>
          <div className="sub" style={{ marginTop: 0 }}>{session.user.email}</div>
        </div>
        <button className="link" onClick={handleSignOut}>Sign out</button>
      </div>

      <h1 style={{ marginTop: 12 }}>Add a ride</h1>
      <div className="sub" style={{ marginBottom: 16 }}>Fill it in, hit save. Everything below sorts itself.</div>

      <form className="card" onSubmit={handleSave}>
        <label>Customer name</label>
        <input value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="e.g. Layla Hasan" />

        <div className="trip-block to-work">
          <div className="section-label"><span className="dot green"></span> To work</div>
          <div className="row2">
            <div>
              <label>Pickup location</label>
              <input value={form.to_work_pickup} onChange={(e) => updateField('to_work_pickup', e.target.value)} placeholder="Home - Sweifieh" />
            </div>
            <div>
              <label>Destination</label>
              <input value={form.to_work_dest} onChange={(e) => updateField('to_work_dest', e.target.value)} placeholder="Job - Downtown" />
            </div>
          </div>
          <label>Pickup time</label>
          <input type="time" value={form.to_work_time} onChange={(e) => updateField('to_work_time', e.target.value)} />
        </div>

        <div className="trip-block way-back">
          <div className="section-label"><span className="dot coral"></span> Way back home</div>
          <div className="row2">
            <div>
              <label>Pickup location</label>
              <input value={form.way_back_pickup} onChange={(e) => updateField('way_back_pickup', e.target.value)} placeholder="Job - Downtown" />
            </div>
            <div>
              <label>Destination</label>
              <input value={form.way_back_dest} onChange={(e) => updateField('way_back_dest', e.target.value)} placeholder="Home - Sweifieh" />
            </div>
          </div>
          <label>Pickup time</label>
          <input type="time" value={form.way_back_time} onChange={(e) => updateField('way_back_time', e.target.value)} />
        </div>

        <label>Amount paid</label>
        <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => updateField('amount', e.target.value)} placeholder="0.00" />

        <label>Notes (optional)</label>
        <textarea rows={2} value={form.notes} onChange={(e) => updateField('notes', e.target.value)} placeholder="Anything worth remembering" />

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

      <div className="list-header">
        <h2>All rides</h2>
        <div className="total-pill">${total.toFixed(2)}</div>
      </div>

      {loadingRides ? (
        <div className="loading">Loading...</div>
      ) : sorted.length === 0 ? (
        <div className="empty">No rides yet. Add your first one above.</div>
      ) : (
        sorted.map((r) => (
          <div className="entry" key={r.id}>
            <div className="entry-top">
              <div className="entry-name">{r.name}</div>
              <div className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</div>
            </div>
            {(r.to_work_pickup || r.to_work_dest) && (
              <div className="trip-line">
                <span className="trip-tag to-work">To work</span>
                <span className="trip-time">{fmtTime(r.to_work_time)}</span>
                <span>{r.to_work_pickup} → {r.to_work_dest}</span>
              </div>
            )}
            {(r.way_back_pickup || r.way_back_dest) && (
              <div className="trip-line">
                <span className="trip-tag way-back">Way back</span>
                <span className="trip-time">{fmtTime(r.way_back_time)}</span>
                <span>{r.way_back_pickup} → {r.way_back_dest}</span>
              </div>
            )}
            {r.notes && <div className="notes">{r.notes}</div>}
            <div className="entry-actions">
              <button onClick={() => startEdit(r)}>Edit</button>
              <button onClick={() => handleDelete(r.id)}>Delete</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
