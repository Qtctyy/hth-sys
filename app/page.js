'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabaseClient';

const AGENTS = ['Hamzah', 'Hemam', 'Talal'];
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEWS = ['today', 'overview', 'customers', 'quicklist', 'calendar', 'history', 'payments'];
const VIEW_LABELS = { today: 'Today', overview: 'Overview', customers: 'Customers', quicklist: 'Quick list', calendar: 'Calendar', history: 'History', payments: 'Payments' };

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

// How many minutes ago a scheduled leg time passed, respecting the same 3am
// business-day rollover as businessDayStr — a 9pm ride is still "today" and can
// still go overdue at 1am, it doesn't silently reset just because the calendar date ticked over.
function minutesOverdue(t, now) {
  const [h, m] = t.split(':').map(Number);
  const scheduled = new Date(now);
  if (scheduled.getHours() < 3) scheduled.setDate(scheduled.getDate() - 1);
  scheduled.setHours(h, m, 0, 0);
  return (now - scheduled) / 60000;
}
function isOverdue(t, now) {
  if (!t) return false;
  return minutesOverdue(t, now) > 10;
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

// A ride skipped for today doesn't touch days_of_week at all — it's a one-day-only
// flag that stops mattering by itself once the business day moves on, since it's
// compared against today's date string rather than being cleared by any cleanup job.
function isSkippedToday(ride, businessDay) {
  return ride.skipped_date === businessDay;
}

function anyLegDoneToday(ride, businessDay) {
  return (
    ride.to_work_completed_date === businessDay ||
    ride.way_back_completed_date === businessDay
  );
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

// Converts a locally-written number (e.g. 07XXXXXXXX) into the international
// digits-only format WhatsApp's click-to-chat links require.
function toWhatsappNumber(mobile) {
  if (!mobile) return null;
  let digits = mobile.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('962')) return digits;
  if (digits.startsWith('0')) return '962' + digits.slice(1);
  return '962' + digits;
}
function waLink(mobile) {
  const num = toWhatsappNumber(mobile);
  return num ? `https://wa.me/${num}` : null;
}

function formatCountdown(mins) {
  if (mins == null || !isFinite(mins)) return '';
  if (mins < 1) return 'now';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function startOfMonth(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(1);
  return x;
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
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [driverMsgCopiedId, setDriverMsgCopiedId] = useState(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [payments, setPayments] = useState([]);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [toast, setToast] = useState('');

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

  const loadPayments = useCallback(async () => {
    if (!session) return;
    setLoadingPayments(true);
    const { data, error } = await supabase
      .from('trip_history')
      .select('*')
      .eq('agent', filterAgent)
      .order('completed_at', { ascending: false })
      .limit(1000);
    if (error) setError(error.message);
    else setPayments(data || []);
    setLoadingPayments(false);
  }, [session, filterAgent]);

  useEffect(() => {
    if (session && view === 'payments') loadPayments();
  }, [session, view, filterAgent, loadPayments]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? '' : t)), 2200);
  }

  async function markAllSettled(unsettledIds, totalAmount) {
    if (unsettledIds.length === 0) return;
    const { error } = await supabase.from('trip_history').update({ settled: true }).in('id', unsettledIds);
    if (error) {
      setError(error.message);
      return;
    }
    showToast(`Marked $${totalAmount.toFixed(2)} as settled`);
    loadPayments();
  }

  async function toggleSkipToday(ride) {
    const bDay = businessDayStr(new Date());
    const isSkipped = ride.skipped_date === bDay;
    const { error } = await supabase
      .from('rides')
      .update({ skipped_date: isSkipped ? null : bDay })
      .eq('id', ride.id);
    if (error) {
      setError(error.message);
      return;
    }
    showToast(isSkipped ? `${ride.name} is back on schedule` : `${ride.name} skipped for today only`);
    loadRides();
  }

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
    showToast(editingId ? 'Ride updated' : 'Ride saved');
    setFilterAgent(form.agent);
    resetForm();
    loadRides();
  }

  async function handleDelete(id) {
    if (!confirm('Delete this ride?')) return;
    const { error } = await supabase.from('rides').delete().eq('id', id);
    if (error) setError(error.message);
    else {
      showToast('Ride deleted');
      loadRides();
    }
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
      // Split the ride's daily amount evenly across its active legs so history/payments
      // totals add up to the ride's actual daily amount instead of double-counting it
      // when both to-work and way-back are completed on the same day.
      const legCount = activeLegs(ride).length || 1;
      const legAmount = Math.round(((parseFloat(ride.amount) || 0) / legCount) * 100) / 100;
      await supabase.from('trip_history').insert({
        user_id: session.user.id,
        ride_id: ride.id,
        agent: ride.agent,
        customer_name: ride.name,
        leg,
        amount: legAmount,
        business_day: bDay,
      });
    }
    loadRides();
    if (view === 'history') loadHistory();
    if (view === 'payments') loadPayments();
  }

  async function copyToAgent(ride, targetAgent) {
    const {
      id, user_id, created_at, to_work_completed_date, way_back_completed_date, skipped_date,
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
      showToast(`Copied to ${targetAgent}`);
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

  async function followShortMapLink(url) {
    try {
      const res = await fetch(url);
      const finalUrl = res.url;
      return extractCoordsFromUrl(finalUrl);
    } catch (e) {
      return null;
    }
  }

  async function resolveCoord(text) {
    if (!text) return null;
    if (isUrl(text)) {
      // First try extracting coords directly (for full links with @lat,lng)
      const direct = extractCoordsFromUrl(text);
      if (direct) return direct;
      // If no direct coords found, it's likely a short link — follow the redirect
      return followShortMapLink(text);
    }
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

  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyDriverMessage(ride) {
    const msg = `الطلب ب اسم ${ride.name}\n\nهي الرقم ${ride.mobile_number || ''}`;
    try {
      await navigator.clipboard.writeText(msg);
      setDriverMsgCopiedId(ride.id);
      setTimeout(() => setDriverMsgCopiedId(null), 1500);
    } catch (e) {
      // Clipboard API unavailable — fail silently.
    }
  }

  function exportHistoryCsv() {
    const rows = [['Customer', 'Leg', 'Amount', 'Completed at']];
    history.forEach((h) => {
      rows.push([
        h.customer_name,
        h.leg === 'to_work' ? 'To work' : 'Way back',
        (parseFloat(h.amount) || 0).toFixed(2),
        new Date(h.completed_at).toLocaleString(),
      ]);
    });
    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filterAgent}-history-${businessDayStr(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
  const skippedToday = todaysRides.filter((r) => isSkippedToday(r, businessDay));
  const activeTodayRides = todaysRides.filter((r) => !isSkippedToday(r, businessDay));
  const pendingToday = activeTodayRides.filter((r) => !isFullyComplete(r, businessDay));
  const completedToday = activeTodayRides.filter((r) => isFullyComplete(r, businessDay));

  const sortedPending = [...pendingToday].sort((a, b) => {
    const [pa, ta] = sortKey(a, now, businessDay);
    const [pb, tb] = sortKey(b, now, businessDay);
    if (pa !== pb) return pa - pb;
    return ta - tb;
  });
  const total = activeTodayRides.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const toWorkCountToday = activeTodayRides.filter((r) => activeLegs(r).includes('to_work')).length;
  const wayBackCountToday = activeTodayRides.filter((r) => activeLegs(r).includes('way_back')).length;
  const firstPendingId = sortedPending[0]?.id;
  const nextUpMinutes = sortedPending.length > 0 ? sortKey(sortedPending[0], now, businessDay)[1] : null;

  // Legs done vs total, for the progress bar — only counts rides actually active today.
  let totalLegsToday = 0;
  let doneLegsToday = 0;
  activeTodayRides.forEach((r) => {
    activeLegs(r).forEach((leg) => {
      totalLegsToday++;
      const field = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
      if (r[field] === businessDay) doneLegsToday++;
    });
  });
  const progressPct = totalLegsToday === 0 ? 0 : Math.round((doneLegsToday / totalLegsToday) * 100);

  const quickList = [...agentRides].sort((a, b) => a.name.localeCompare(b.name));

  const searchedAgentRides = customerSearch.trim()
    ? agentRides.filter((r) => {
        const q = customerSearch.trim().toLowerCase();
        return r.name.toLowerCase().includes(q) || (r.mobile_number || '').includes(q);
      })
    : agentRides;

  // All-agents snapshot for the Overview tab — so you don't have to flip through
  // each agent's tab just to see how the whole team's day is going.
  const overviewStats = AGENTS.map((a) => {
    const aRides = rides.filter((r) => r.agent === a);
    const aToday = ridesScheduledOnWeekday(aRides, todayWeekday).filter((r) => !isSkippedToday(r, businessDay));
    const aPending = aToday.filter((r) => !isFullyComplete(r, businessDay));
    const aTotal = aToday.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    return {
      agent: a,
      customerCount: aRides.length,
      todayCount: aToday.length,
      pendingCount: aPending.length,
      totalToday: aTotal,
    };
  });
  const grandTotalToday = overviewStats.reduce((s, o) => s + o.totalToday, 0);
  const grandPendingToday = overviewStats.reduce((s, o) => s + o.pendingCount, 0);

  // Payments tab aggregates, computed client-side from the loaded history rows.
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const weekTotal = payments
    .filter((p) => new Date(p.completed_at) >= weekStart)
    .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const monthTotal = payments
    .filter((p) => new Date(p.completed_at) >= monthStart)
    .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const unsettledPayments = payments.filter((p) => !p.settled);
  const unsettledTotal = unsettledPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

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
    const isExpanded = expandedIds.has(r.id);
    const wa = waLink(r.mobile_number);
    return (
      <div className={`entry ${isNextUp ? 'next-up' : ''} ${opts.dimmed ? 'entry-dimmed' : ''}`} key={r.id}>
        {isNextUp && (
          <div className="next-up-tag">
            <span className="pulse-dot"></span> Up next
            {opts.nextUpMinutes != null && ` · in ${formatCountdown(opts.nextUpMinutes)}`}
          </div>
        )}
        <div className="entry-top entry-top-clickable" onClick={() => toggleExpand(r.id)}>
          <div className="entry-name">{r.name}</div>
          <div className="entry-top-right">
            <div className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</div>
            <span className={`chevron ${isExpanded ? 'open' : ''}`}>▾</span>
          </div>
        </div>

        {!isExpanded && (
          <div className="collapsed-summary">
            {['to_work', 'way_back'].map((leg) => {
              const info = legInfo(r, leg);
              if (!info.enabled || !info.time) return null;
              const overdue = !opts.dimmed && !info.done && isOverdue(info.time, now);
              return (
                <span key={leg} className={`mini-time ${leg === 'to_work' ? 'to-work' : 'way-back'} ${info.done ? 'done' : ''} ${overdue ? 'overdue' : ''}`}>
                  {leg === 'to_work' ? '🏢' : '🏠'} {fmtTime(info.time)}{info.done ? ' ✓' : overdue ? ' ⚠' : ''}
                </span>
              );
            })}
            {r.mobile_number && (
              <button
                className="mini-copy-btn"
                onClick={(e) => { e.stopPropagation(); copyNumber(r); }}
              >
                {copiedId === r.id ? 'Copied!' : '📋 ' + r.mobile_number}
              </button>
            )}
          </div>
        )}

        {isExpanded && (
          <>
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
                {wa && (
                  <a className="wa-btn" href={wa} target="_blank" rel="noopener noreferrer">
                    WhatsApp
                  </a>
                )}
              </div>
            )}

            {['to_work', 'way_back'].map((leg) => {
              const info = legInfo(r, leg);
              if (!info.enabled || !info.time) return null;
              const tagClass = leg === 'to_work' ? 'to-work' : 'way-back';
              const tagLabel = leg === 'to_work' ? 'To work' : 'Way back';
              const overdue = !opts.dimmed && !info.done && isOverdue(info.time, now);
              return (
                <div key={leg}>
                  <div className="trip-line">
                    <span className={`trip-tag ${tagClass}`}>{tagLabel}</span>
                    <span className={`trip-time ${overdue ? 'overdue' : ''}`}>{fmtTime(info.time)}</span>
                    <span>{renderLocation(info.pickup)} → {renderLocation(info.dest)}</span>
                    {overdue && <span className="overdue-tag">Overdue</span>}
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
              <button onClick={() => copyDriverMessage(r)}>
                {driverMsgCopiedId === r.id ? 'Copied!' : 'Driver message'}
              </button>
              {!opts.dimmed && !anyLegDoneToday(r, businessDay) && (
                <button onClick={() => toggleSkipToday(r)}>Skip today</button>
              )}
            </div>

            {copyOpenId === r.id && (
              <div className="copy-picker">
                {AGENTS.filter((a) => a !== r.agent).map((a) => (
                  <button key={a} onClick={() => copyToAgent(r, a)}>{a}</button>
                ))}
              </div>
            )}
          </>
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
          <div key={a} className={`tab ${filterAgent === a ? 'active' : ''}`} onClick={() => { setFilterAgent(a); setCustomerSearch(''); }}>
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
          <div className="stats-row">
            <span className="stat-pill">🏢 {toWorkCountToday} to-work</span>
            <span className="stat-pill">🏠 {wayBackCountToday} way-back</span>
            {skippedToday.length > 0 && (
              <span className="stat-pill">⏭ {skippedToday.length} skipped</span>
            )}
          </div>

          {totalLegsToday > 0 && (
            <div className="progress-wrap">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progressPct}%` }}></div>
              </div>
              <div className="progress-label">
                {progressPct === 100 ? `🎉 All ${totalLegsToday} legs done for today` : `${doneLegsToday}/${totalLegsToday} legs done · ${progressPct}%`}
              </div>
            </div>
          )}

          {loadingRides ? (
            <div className="loading">Loading...</div>
          ) : sortedPending.length === 0 ? (
            <div className="empty">Nothing left today for {filterAgent}.</div>
          ) : (
            sortedPending.map((r) => renderRideCard(r, {
              isNextUp: r.id === firstPendingId,
              nextUpMinutes: r.id === firstPendingId ? nextUpMinutes : null,
            }))
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

          {skippedToday.length > 0 && (
            <>
              <div className="list-header">
                <h2>Skipped today</h2>
                <div className="total-pill">{skippedToday.length}</div>
              </div>
              {skippedToday.map((r) => (
                <div className="entry entry-skipped" key={r.id}>
                  <div className="entry-top">
                    <div className="entry-name">{r.name}</div>
                    <div className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</div>
                  </div>
                  <div className="sub" style={{ marginTop: 4 }}>Skipped for today only — schedule is unaffected.</div>
                  <div className="entry-actions">
                    <button onClick={() => toggleSkipToday(r)}>Unskip</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {view === 'overview' && (
        <>
          <div className="list-header">
            <h2>Whole team, today</h2>
            <div className="total-pill">${grandTotalToday.toFixed(2)}</div>
          </div>
          <div className="stats-row">
            <span className="stat-pill">🕐 {grandPendingToday} pending</span>
            <span className="stat-pill">👥 {overviewStats.reduce((s, o) => s + o.customerCount, 0)} customers</span>
          </div>
          {overviewStats.map((o) => (
            <div
              className="overview-card"
              key={o.agent}
              onClick={() => { setFilterAgent(o.agent); setView('today'); }}
            >
              <div className="overview-card-top">
                <span className="overview-agent">{o.agent}</span>
                <span className="entry-amount">${o.totalToday.toFixed(2)}</span>
              </div>
              <div className="overview-card-sub">
                {o.todayCount === 0
                  ? 'Nothing scheduled today'
                  : o.pendingCount === 0
                    ? `All ${o.todayCount} done for today ✓`
                    : `${o.pendingCount} of ${o.todayCount} still pending`}
                {' · '}{o.customerCount} total customers
              </div>
            </div>
          ))}
        </>
      )}

      {view === 'customers' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s customers</h2>
            <div className="total-pill">{searchedAgentRides.length}</div>
          </div>
          <input
            className="search-input"
            placeholder="Search by name or mobile number"
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
          />
          {agentRides.length === 0 ? (
            <div className="empty">No customers yet for {filterAgent}.</div>
          ) : searchedAgentRides.length === 0 ? (
            <div className="empty">No customers match "{customerSearch}".</div>
          ) : (
            searchedAgentRides.map((r) => {
              const isExpanded = expandedIds.has(r.id);
              const wa = waLink(r.mobile_number);
              return (
                <div className="entry" key={r.id}>
                  <div className="entry-top entry-top-clickable" onClick={() => toggleExpand(r.id)}>
                    <div className="entry-name">{r.name}</div>
                    <div className="entry-top-right">
                      <div className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</div>
                      <span className={`chevron ${isExpanded ? 'open' : ''}`}>▾</span>
                    </div>
                  </div>

                  {!isExpanded && (
                    <div className="collapsed-summary">
                      {['to_work', 'way_back'].map((leg) => {
                        const info = legInfo(r, leg);
                        if (!info.enabled || !info.time) return null;
                        return (
                          <span key={leg} className={`mini-time ${leg === 'to_work' ? 'to-work' : 'way-back'}`}>
                            {leg === 'to_work' ? '🏢' : '🏠'} {fmtTime(info.time)}
                          </span>
                        );
                      })}
                      {r.mobile_number && (
                        <button
                          className="mini-copy-btn"
                          onClick={(e) => { e.stopPropagation(); copyNumber(r); }}
                        >
                          {copiedId === r.id ? 'Copied!' : '📋 ' + r.mobile_number}
                        </button>
                      )}
                    </div>
                  )}

                  {isExpanded && (
                    <>
                      <div className="day-chips" style={{ marginTop: 10 }}>
                        {DAY_LABELS.map((label, idx) => (
                          <div key={idx} className={`day-chip mini ${(!r.days_of_week || r.days_of_week.length === 0 || r.days_of_week.includes(idx)) ? 'active' : ''}`}>
                            {label}
                          </div>
                        ))}
                      </div>

                      {r.mobile_number && (
                        <div className="copy-row">
                          <span>{r.mobile_number}</span>
                          <button className="copy-btn" onClick={() => copyNumber(r)}>
                            {copiedId === r.id ? 'Copied!' : 'Copy'}
                          </button>
                          {wa && (
                            <a className="wa-btn" href={wa} target="_blank" rel="noopener noreferrer">
                              WhatsApp
                            </a>
                          )}
                        </div>
                      )}

                      <div className="entry-actions">
                        <button onClick={() => startEdit(r)}>Edit</button>
                        <button onClick={() => handleDelete(r.id)}>Delete</button>
                        <button onClick={() => setCopyOpenId(copyOpenId === r.id ? null : r.id)}>Copy to...</button>
                        <button onClick={() => copyDriverMessage(r)}>
                          {driverMsgCopiedId === r.id ? 'Copied!' : 'Driver message'}
                        </button>
                      </div>
                      {copyOpenId === r.id && (
                        <div className="copy-picker">
                          {AGENTS.filter((a) => a !== r.agent).map((a) => (
                            <button key={a} onClick={() => copyToAgent(r, a)}>{a}</button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })
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
            {history.length > 0 && (
              <button className="link" onClick={exportHistoryCsv}>Export CSV</button>
            )}
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

      {view === 'payments' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s payments</h2>
          </div>
          <div className="stats-row">
            <span className="stat-pill">This week ${weekTotal.toFixed(2)}</span>
            <span className="stat-pill">This month ${monthTotal.toFixed(2)}</span>
          </div>

          <div className="card payments-summary">
            <div className="overview-card-top">
              <span>Unsettled cash</span>
              <span className="entry-amount">${unsettledTotal.toFixed(2)}</span>
            </div>
            <div className="overview-card-sub">
              {unsettledPayments.length === 0
                ? 'Everything collected so far has been settled.'
                : `${unsettledPayments.length} completed trip${unsettledPayments.length === 1 ? '' : 's'} not yet settled up.`}
            </div>
            {unsettledPayments.length > 0 && (
              <button
                className="primary"
                style={{ marginTop: 12 }}
                onClick={() => markAllSettled(unsettledPayments.map((p) => p.id), unsettledTotal)}
              >
                Mark ${unsettledTotal.toFixed(2)} as settled
              </button>
            )}
          </div>

          <div className="list-header">
            <h2>Recent trips</h2>
          </div>
          {loadingPayments ? (
            <div className="loading">Loading...</div>
          ) : payments.length === 0 ? (
            <div className="empty">No completed trips logged yet.</div>
          ) : (
            payments.slice(0, 50).map((p) => (
              <div className="history-row" key={p.id}>
                <div>
                  <div className="entry-name">{p.customer_name}</div>
                  <div className="sub" style={{ marginTop: 2 }}>
                    {p.leg === 'to_work' ? 'To work' : 'Way back'} · {new Date(p.completed_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="entry-amount">${(parseFloat(p.amount) || 0).toFixed(2)}</div>
                  {!p.settled && <span className="unsettled-dot" title="Not settled yet"></span>}
                </div>
              </div>
            ))
          )}
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
