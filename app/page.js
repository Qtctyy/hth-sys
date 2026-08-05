'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabaseClient';

const AGENTS = ['Hamzah', 'Hemam', 'Talal'];
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEWS = ['today', 'customers', 'quicklist', 'calendar', 'history'];
const VIEW_LABELS = { today: 'Today', customers: 'Customers', quicklist: 'Quick list', calendar: 'Calendar', history: 'History' };

const emptyForm = {
  name: '',
  mobile_number: '',
  building_number: '',
  street_name: '',
  to_work_enabled: true,
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
  days_of_week: [0, 1, 2, 3, 4, 5, 6],
};

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function localDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// The "business day" only rolls over at 3am local time, not at midnight — so a ride
// completed at 1am still counts as last night's ride until 3am. This uses local time
// components (not toISOString, which is UTC and was the source of the earlier bug).
function businessDayStr(d) {
  const shifted = new Date(d);
  if (shifted.getHours() < 3) shifted.setDate(shifted.getDate() - 1);
  return localDateStr(shifted);
}
function businessWeekday(d) {
  const shifted = new Date(d);
  if (shifted.getHours() < 3) shifted.setDate(shifted.getDate() - 1);
  return shifted.getDay();
}

function isUrl(str) {
  if (!str) return false;
  return /^https?:\/\//i.test(str.trim());
}

function extractCoordsFromUrl(url) {
  if (!url) return null;
  let m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
  m = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
  return null;
}

function canUber(text) {
  if (!text) return false;
  if (isUrl(text)) return !!extractCoordsFromUrl(text);
  return true;
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

function activeLegs(ride) {
  const legs = [];
  if (ride.to_work_enabled !== false && ride.to_work_time) legs.push('to_work');
  if (ride.way_back_enabled !== false && ride.way_back_time) legs.push('way_back');
  return legs;
}

function isFullyComplete(ride, businessDay) {
  const legs = activeLegs(ride);
  if (legs.length === 0) return false;
  return legs.every((leg) => {
    const field = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
    return ride[field] === businessDay;
  });
}

function sortKey(ride, now, businessDay) {
  const legs = activeLegs(ride).map((leg) => {
    const field = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
    const time = leg === 'to_work' ? ride.to_work_time : ride.way_back_time;
    return { done: ride[field] === businessDay, time };
  });
  const pending = legs.filter((l) => !l.done);
  if (pending.length === 0) return [1, Infinity];
  return [0, Math.min(...pending.map((l) => minutesUntil(l.time, now)))];
}

function ridesScheduledOnWeekday(rides, weekdayIdx) {
  return rides.filter((r) => {
    if (activeLegs(r).length === 0) return false;
    if (!r.days_of_week || r.days_of_week.length === 0) return true;
    return r.days_of_week.includes(weekdayIdx);
  });
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
  const [view, setView] = useState('today');
  const [tick, setTick] = useState(0);
  const [geoCache, setGeoCache] = useState({});
  const [uberUrls, setUberUrls] = useState({});
  const resolvingUberRef = useRef(new Set());
  const [copyOpenId, setCopyOpenId] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
  });
  const [selectedWeekday, setSelectedWeekday] = useState(null);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

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

  // Pre-resolves every visible leg's Uber link in the background the moment rides
  // load or change, so buttons are already real, tappable links by the time you see them.
  useEffect(() => {
    const relevant = rides.filter((r) => r.agent === filterAgent);
    relevant.forEach((r) => {
      ['to_work', 'way_back'].forEach((leg) => {
        const enabled = leg === 'to_work' ? r.to_work_enabled !== false : r.way_back_enabled !== false;
        const time = leg === 'to_work' ? r.to_work_time : r.way_back_time;
        const pickup = leg === 'to_work' ? r.to_work_pickup : r.way_back_pickup;
        const dest = leg === 'to_work' ? r.to_work_dest : r.way_back_dest;
        if (!enabled || !time) return;
        if (canUber(pickup) && canUber(dest)) resolveUberUrl(r, leg);
      });
    });
  }, [rides, filterAgent]);

  const loadHistory = useCallback(async () => {
    if (!session) return;
    setLoadingHistory(true);
    const { data, error } = await supabase
      .from('trip_history')
      .select('*')
      .eq('agent', filterAgent)
      .order('completed_at', { ascending: false })
      .limit(200);
    if (error) setError(error.message);
    else setHistory(data || []);
    setLoadingHistory(false);
  }, [session, filterAgent]);

  useEffect(() => {
    if (session && view === 'history') loadHistory();
  }, [session, view, filterAgent, loadHistory]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
  }

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleDay(idx) {
    setForm((f) => {
      const has = f.days_of_week.includes(idx);
      if (has && f.days_of_week.length === 1) return f;
      const days = has ? f.days_of_week.filter((d) => d !== idx) : [...f.days_of_week, idx];
      return { ...f, days_of_week: days };
    });
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
      to_work_enabled: ride.to_work_enabled !== false,
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
      days_of_week: ride.days_of_week && ride.days_of_week.length ? ride.days_of_week : [0, 1, 2, 3, 4, 5, 6],
    });
    setEditingId(ride.id);
    setView('today');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) {
      setError('Add a customer name first.');
      return;
    }
    if (!form.to_work_enabled && !form.way_back_enabled) {
      setError('Turn on at least one trip — to-work or way-back.');
      return;
    }
    setSaving(true);

    const payload = {
      agent: form.agent,
      name: form.name.trim(),
      mobile_number: form.mobile_number.trim(),
      building_number: form.building_number.trim(),
      street_name: form.street_name.trim(),
      to_work_enabled: form.to_work_enabled,
      to_work_pickup: form.to_work_enabled ? form.to_work_pickup.trim() : '',
      to_work_dest: form.to_work_enabled ? form.to_work_dest.trim() : '',
      to_work_time: form.to_work_enabled ? form.to_work_time : '',
      way_back_enabled: form.way_back_enabled,
      way_back_pickup: form.way_back_enabled ? form.way_back_pickup.trim() : '',
      way_back_dest: form.way_back_enabled ? form.way_back_dest.trim() : '',
      way_back_time: form.way_back_enabled ? form.way_back_time : '',
      amount: parseFloat(form.amount) || 0,
      notes: form.notes.trim(),
      days_of_week: form.days_of_week,
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
    const bDay = businessDayStr(new Date());
    const isDone = ride[field] === bDay;

    const { error } = await supabase
      .from('rides')
      .update({ [field]: isDone ? null : bDay })
      .eq('id', ride.id);
    if (error) {
      setError(error.message);
      return;
    }

    if (isDone) {
      await supabase.from('trip_history').delete()
        .eq('ride_id', ride.id).eq('leg', leg).eq('business_day', bDay);
    } else {
      await supabase.from('trip_history').insert({
        user_id: session.user.id,
        ride_id: ride.id,
        agent: ride.agent,
        customer_name: ride.name,
        leg,
        amount: ride.amount || 0,
        business_day: bDay,
      });
    }
    loadRides();
    if (view === 'history') loadHistory();
  }

  async function copyToAgent(ride, targetAgent) {
    const {
      id, user_id, created_at, to_work_completed_date, way_back_completed_date,
      ...rest
    } = ride;
    const payload = {
      ...rest,
      agent: targetAgent,
      user_id: session.user.id,
      to_work_completed_date: null,
      way_back_completed_date: null,
    };
    const { error } = await supabase.from('rides').insert(payload);
    if (error) setError(error.message);
    else {
      setCopyOpenId(null);
      loadRides();
    }
  }

  async function geocodeAddress(address) {
    const key = address.trim().toLowerCase();
    if (geoCache[key] !== undefined) return geoCache[key];
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`
      );
      const data = await res.json();
      const coord = data && data.length > 0
        ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
        : null;
      setGeoCache((c) => ({ ...c, [key]: coord }));
      return coord;
    } catch (e) {
      return null;
    }
  }

  async function resolveCoord(text) {
    if (!text) return null;
    if (isUrl(text)) return extractCoordsFromUrl(text);
    return geocodeAddress(text);
  }

  // Resolves a leg's Uber link in the background, well before the button is tapped.
  // This is the fix: iOS will only open the Uber app (instead of falling back to the
  // website) when the link is a real <a href> tapped directly — any lookup done
  // *after* the tap breaks that trust and Safari loads the web page instead.
  async function resolveUberUrl(ride, leg) {
    const key = `${ride.id}-${leg}`;
    if (resolvingUberRef.current.has(key) || uberUrls[key] !== undefined) return;
    resolvingUberRef.current.add(key);

    const pickupText = leg === 'to_work' ? ride.to_work_pickup : ride.way_back_pickup;
    const destText = leg === 'to_work' ? ride.to_work_dest : ride.way_back_dest;
    const [pickupCoord, destCoord] = await Promise.all([
      resolveCoord(pickupText),
      resolveCoord(destText),
    ]);

    let url = null;
    if (pickupCoord && destCoord) {
      url =
        `https://m.uber.com/ul/?action=setPickup` +
        `&pickup[latitude]=${pickupCoord.lat}&pickup[longitude]=${pickupCoord.lon}&pickup[nickname]=${encodeURIComponent(pickupText)}` +
        `&dropoff[latitude]=${destCoord.lat}&dropoff[longitude]=${destCoord.lon}&dropoff[nickname]=${encodeURIComponent(destText)}`;
    }
    setUberUrls((u) => ({ ...u, [key]: url }));
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

  const now = new Date();
  const businessDay = businessDayStr(now);
  const todayWeekday = businessWeekday(now);
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const agentRides = rides.filter((r) => r.agent === filterAgent);
  const todaysRides = ridesScheduledOnWeekday(agentRides, todayWeekday);
  const pendingToday = todaysRides.filter((r) => !isFullyComplete(r, businessDay));
  const completedToday = todaysRides.filter((r) => isFullyComplete(r, businessDay));

  const sortedPending = [...pendingToday].sort((a, b) => {
    const [pa, ta] = sortKey(a, now, businessDay);
    const [pb, tb] = sortKey(b, now, businessDay);
    if (pa !== pb) return pa - pb;
    return ta - tb;
  });
  const total = todaysRides.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const firstPendingId = sortedPending[0]?.id;

  const quickList = [...agentRides].sort((a, b) => a.name.localeCompare(b.name));

  const daysInCalMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const firstWeekday = calendarMonth.getDay();

  function legInfo(ride, leg) {
    const enabled = leg === 'to_work' ? ride.to_work_enabled !== false : ride.way_back_enabled !== false;
    const time = leg === 'to_work' ? ride.to_work_time : ride.way_back_time;
    const pickup = leg === 'to_work' ? ride.to_work_pickup : ride.way_back_pickup;
    const dest = leg === 'to_work' ? ride.to_work_dest : ride.way_back_dest;
    const doneField = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
    return { enabled, time, pickup, dest, done: ride[doneField] === businessDay };
  }

  function renderRideCard(r, opts = {}) {
    const isNextUp = opts.isNextUp;
    return (
      <div className={`entry ${isNextUp ? 'next-up' : ''} ${opts.dimmed ? 'entry-dimmed' : ''}`} key={r.id}>
        {isNextUp && (
          <div className="next-up-tag"><span className="pulse-dot"></span> Up next</div>
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

        {['to_work', 'way_back'].map((leg) => {
          const info = legInfo(r, leg);
          if (!info.enabled || !info.time) return null;
          const tagClass = leg === 'to_work' ? 'to-work' : 'way-back';
          const tagLabel = leg === 'to_work' ? 'To work' : 'Way back';
          return (
            <div key={leg}>
              <div className="trip-line">
                <span className={`trip-tag ${tagClass}`}>{tagLabel}</span>
                <span className="trip-time">{fmtTime(info.time)}</span>
                <span>{renderLocation(info.pickup)} → {renderLocation(info.dest)}</span>
              </div>
              {!opts.dimmed && (
                <div className="trip-actions">
                  <button
                    className={`complete-btn ${info.done ? 'done' : ''}`}
                    onClick={() => toggleComplete(r, leg)}
                  >
                    {info.done ? '✓ Completed' : `Mark ${leg === 'to_work' ? 'to-work' : 'way-back'} complete`}
                  </button>
                  {canUber(info.pickup) && canUber(info.dest) && (() => {
                    const uKey = `${r.id}-${leg}`;
                    const url = uberUrls[uKey];
                    if (url) {
                      return <a className="uber-btn" href={url}>🚕 Open in Uber</a>;
                    }
                    if (url === null) {
                      return <span className="uber-btn uber-btn-disabled">Address not found</span>;
                    }
                    return <span className="uber-btn uber-btn-disabled">Locating...</span>;
                  })()}
                </div>
              )}
            </div>
          );
        })}

        {opts.dimmed && (
          <div className="trip-actions">
            {['to_work', 'way_back'].map((leg) => {
              const info = legInfo(r, leg);
              if (!info.enabled || !info.time) return null;
              return (
                <button
                  key={leg}
                  className="complete-btn done"
                  onClick={() => toggleComplete(r, leg)}
                >
                  ✓ {leg === 'to_work' ? 'To-work' : 'Way-back'} done — undo
                </button>
              );
            })}
          </div>
        )}

        {r.notes && <div className="notes">{r.notes}</div>}

        <div className="entry-actions">
          <button onClick={() => startEdit(r)}>Edit</button>
          <button onClick={() => handleDelete(r.id)}>Delete</button>
          <button onClick={() => setCopyOpenId(copyOpenId === r.id ? null : r.id)}>Copy to...</button>
        </div>

        {copyOpenId === r.id && (
          <div className="copy-picker">
            {AGENTS.filter((a) => a !== r.agent).map((a) => (
              <button key={a} onClick={() => copyToAgent(r, a)}>{a}</button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <div className="eyebrow">Ride Log</div>
          <div className="date-bar">{dateLabel}</div>
        </div>
        <button className="link" onClick={handleSignOut}>Sign out</button>
      </div>

      {view === 'today' && (
        <>
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

            <div className="toggle-row">
              <span>Include to-work ride</span>
              <label className="switch">
                <input type="checkbox" checked={form.to_work_enabled} onChange={(e) => updateField('to_work_enabled', e.target.checked)} />
                <span className="track"></span>
              </label>
            </div>
            {form.to_work_enabled && (
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
            )}

            <div className="toggle-row">
              <span>Include way back home</span>
              <label className="switch">
                <input type="checkbox" checked={form.way_back_enabled} onChange={(e) => updateField('way_back_enabled', e.target.checked)} />
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

            <label>Which days does this ride happen?</label>
            <div className="day-chips">
              {DAY_LABELS.map((label, idx) => (
                <div key={idx} className={`day-chip ${form.days_of_week.includes(idx) ? 'active' : ''}`} onClick={() => toggleDay(idx)}>
                  {label}
                </div>
              ))}
            </div>

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
        </>
      )}

      <div className="tabs">
        {AGENTS.map((a) => (
          <div key={a} className={`tab ${filterAgent === a ? 'active' : ''}`} onClick={() => setFilterAgent(a)}>
            {a}
          </div>
        ))}
      </div>

      <div className="subtabs">
        {VIEWS.map((v) => (
          <div key={v} className={`subtab ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
            {VIEW_LABELS[v]}
          </div>
        ))}
      </div>

      {view === 'today' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s rides today</h2>
            <div className="total-pill">${total.toFixed(2)}</div>
          </div>

          {loadingRides ? (
            <div className="loading">Loading...</div>
          ) : sortedPending.length === 0 ? (
            <div className="empty">Nothing left today for {filterAgent}.</div>
          ) : (
            sortedPending.map((r) => renderRideCard(r, { isNextUp: r.id === firstPendingId }))
          )}

          {completedToday.length > 0 && (
            <>
              <div className="list-header">
                <h2>Completed today</h2>
                <div className="total-pill">{completedToday.length}</div>
              </div>
              {completedToday.map((r) => renderRideCard(r, { dimmed: true }))}
            </>
          )}
        </>
      )}

      {view === 'customers' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s customers</h2>
            <div className="total-pill">{agentRides.length}</div>
          </div>
          {agentRides.length === 0 ? (
            <div className="empty">No customers yet for {filterAgent}.</div>
          ) : (
            agentRides.map((r) => (
              <div className="entry" key={r.id}>
                <div className="entry-top">
                  <div className="entry-name">{r.name}</div>
                  <div className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</div>
                </div>
                <div className="day-chips" style={{ marginTop: 10 }}>
                  {DAY_LABELS.map((label, idx) => (
                    <div key={idx} className={`day-chip mini ${(!r.days_of_week || r.days_of_week.length === 0 || r.days_of_week.includes(idx)) ? 'active' : ''}`}>
                      {label}
                    </div>
                  ))}
                </div>
                <div className="entry-actions">
                  <button onClick={() => startEdit(r)}>Edit</button>
                  <button onClick={() => handleDelete(r.id)}>Delete</button>
                  <button onClick={() => setCopyOpenId(copyOpenId === r.id ? null : r.id)}>Copy to...</button>
                </div>
                {copyOpenId === r.id && (
                  <div className="copy-picker">
                    {AGENTS.filter((a) => a !== r.agent).map((a) => (
                      <button key={a} onClick={() => copyToAgent(r, a)}>{a}</button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}

      {view === 'quicklist' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s quick list</h2>
            <div className="total-pill">{quickList.length}</div>
          </div>
          {quickList.length === 0 ? (
            <div className="empty">No customers yet for {filterAgent}.</div>
          ) : (
            quickList.map((r) => (
              <div className="quicklist-row" key={r.id} onClick={() => startEdit(r)}>
                <span>{r.name}</span>
                <span className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</span>
              </div>
            ))
          )}
        </>
      )}

      {view === 'calendar' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s calendar</h2>
          </div>
          <div className="cal-nav">
            <button onClick={() => { const d = new Date(calendarMonth); d.setMonth(d.getMonth() - 1); setCalendarMonth(d); setSelectedWeekday(null); }}>‹</button>
            <span>{calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <button onClick={() => { const d = new Date(calendarMonth); d.setMonth(d.getMonth() + 1); setCalendarMonth(d); setSelectedWeekday(null); }}>›</button>
          </div>
          <div className="cal-grid">
            {DAY_LABELS.map((l, i) => <div key={`h${i}`} className="cal-head">{l}</div>)}
            {Array.from({ length: firstWeekday }).map((_, i) => <div key={`b${i}`} className="cal-cell empty-cell"></div>)}
            {Array.from({ length: daysInCalMonth }).map((_, i) => {
              const dayNum = i + 1;
              const cellDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), dayNum);
              const weekday = cellDate.getDay();
              const count = ridesScheduledOnWeekday(agentRides, weekday).length;
              const isToday = localDateStr(cellDate) === businessDay;
              return (
                <div
                  key={dayNum}
                  className={`cal-cell ${isToday ? 'today' : ''} ${selectedWeekday === weekday ? 'selected' : ''}`}
                  onClick={() => setSelectedWeekday(weekday)}
                >
                  <span className="cal-daynum">{dayNum}</span>
                  {count > 0 && <span className="cal-count">{count}</span>}
                </div>
              );
            })}
          </div>
          {selectedWeekday !== null && (
            <>
              <div className="list-header">
                <h2>{WEEKDAY_NAMES[selectedWeekday]}s</h2>
              </div>
              {ridesScheduledOnWeekday(agentRides, selectedWeekday).length === 0 ? (
                <div className="empty">No customers scheduled.</div>
              ) : (
                ridesScheduledOnWeekday(agentRides, selectedWeekday).map((r) => (
                  <div className="quicklist-row" key={r.id} onClick={() => startEdit(r)}>
                    <span>{r.name}</span>
                    <span className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</span>
                  </div>
                ))
              )}
            </>
          )}
        </>
      )}

      {view === 'history' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s history</h2>
          </div>
          {loadingHistory ? (
            <div className="loading">Loading...</div>
          ) : history.length === 0 ? (
            <div className="empty">No completed trips logged yet.</div>
          ) : (
            history.map((h) => (
              <div className="history-row" key={h.id}>
                <div>
                  <div className="entry-name">{h.customer_name}</div>
                  <div className="sub" style={{ marginTop: 2 }}>
                    {h.leg === 'to_work' ? 'To work' : 'Way back'} · {new Date(h.completed_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
                <div className="entry-amount">${(parseFloat(h.amount) || 0).toFixed(2)}</div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
