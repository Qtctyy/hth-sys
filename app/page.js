'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabaseClient';

const AGENTS = ['Hamzah', 'Talal'];
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEWS = ['today', 'customers', 'paid', 'calendar', 'stats', 'history'];
const VIEW_LABELS = { today: 'Today', customers: 'Customers', paid: 'Paid', calendar: 'Calendar', stats: 'Earnings', history: 'History' };

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
  paid: false,
  active: true,
  is_one_time: false,
  one_time_date: '',
};

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function localDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// The business day only rolls over at RESET_HOUR local time, not at midnight —
// so a ride completed at 12:30am still counts as last night's ride until the
// reset. This uses local time components (not toISOString, which is UTC).
const RESET_HOUR = 1;

function businessDayStr(d) {
  const shifted = new Date(d);
  if (shifted.getHours() < RESET_HOUR) shifted.setDate(shifted.getDate() - 1);
  return localDateStr(shifted);
}
function businessWeekday(d) {
  const shifted = new Date(d);
  if (shifted.getHours() < RESET_HOUR) shifted.setDate(shifted.getDate() - 1);
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

// Maps a wall-clock time onto a continuous scale where the business day starts
// at RESET_HOUR — so 23:50 and 00:10 stay in the right order relative to each
// other, and a ride whose time has already passed today shows as genuinely
// overdue (negative) instead of wrapping around to "23 hours from now."
function businessMinutes(hours, minutes) {
  let total = hours * 60 + minutes;
  if (hours < RESET_HOUR) total += 24 * 60;
  return total;
}

function minutesUntil(t, now) {
  const [h, m] = t.split(':').map(Number);
  return businessMinutes(h, m) - businessMinutes(now.getHours(), now.getMinutes());
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

// A leg is "resolved" for today if it's either completed or skipped — either
// way, nothing left to do on it. Skipping doesn't log any money.
function isLegResolved(ride, leg, businessDay) {
  const doneField = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
  const skipField = leg === 'to_work' ? 'to_work_skipped_date' : 'way_back_skipped_date';
  return ride[doneField] === businessDay || ride[skipField] === businessDay;
}
function isResolvedToday(ride, businessDay) {
  const legs = activeLegs(ride);
  if (legs.length === 0) return false;
  return legs.every((leg) => isLegResolved(ride, leg, businessDay));
}
function hasAnySkipToday(ride, businessDay) {
  return activeLegs(ride).some((leg) => {
    const skipField = leg === 'to_work' ? 'to_work_skipped_date' : 'way_back_skipped_date';
    return ride[skipField] === businessDay;
  });
}

function sortKey(ride, now, businessDay) {
  const legs = activeLegs(ride).map((leg) => {
    const time = leg === 'to_work' ? ride.to_work_time : ride.way_back_time;
    return { done: isLegResolved(ride, leg, businessDay), time };
  });
  const pending = legs.filter((l) => !l.done);
  if (pending.length === 0) return [1, Infinity];
  return [0, Math.min(...pending.map((l) => minutesUntil(l.time, now)))];
}

function groupHistoryByDay(history) {
  const groups = {};
  history.forEach((h) => {
    const day = h.business_day;
    if (!groups[day]) groups[day] = [];
    groups[day].push(h);
  });
  return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
}

// Buckets an hour into the 3 requested shifts. Anything from 1am-6am (outside
// all three) falls into "other" so nothing silently gets dropped from stats.
function phaseForHour(hour) {
  if (hour >= 6 && hour < 14) return 'morning';
  if (hour >= 14 && hour < 20) return 'evening';
  if (hour >= 20 || hour < 1) return 'night';
  return 'other';
}

// Sums trip_history amounts without double-counting a round trip: each leg
// logs the full ride price (not split), so a customer with both legs
// completed the same day would otherwise count twice. This counts each
// ride, once per day, toward the total — regardless of how many legs.
function sumDistinctRideDay(entries) {
  const seen = new Set();
  let total = 0;
  entries.forEach((h) => {
    const key = `${h.ride_id}-${h.business_day}`;
    if (!seen.has(key)) {
      seen.add(key);
      total += parseFloat(h.amount) || 0;
    }
  });
  return total;
}

function formatHistoryDayLabel(dayStr, todayBusinessDay) {
  if (dayStr === todayBusinessDay) return 'Today';
  const [ty, tm, td] = todayBusinessDay.split('-').map(Number);
  const [y, m, d] = dayStr.split('-').map(Number);
  const todayDate = new Date(ty, tm - 1, td);
  const dayDate = new Date(y, m - 1, d);
  const diffDays = Math.round((todayDate - dayDate) / 86400000);
  if (diffDays === 1) return 'Yesterday';
  return dayDate.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    year: y !== ty ? 'numeric' : undefined,
  });
}

function ridesScheduledOnWeekday(rides, weekdayIdx, dateStr) {
  return rides.filter((r) => {
    if (r.active === false) return false;
    if (activeLegs(r).length === 0) return false;
    if (r.one_time_date) return dateStr != null && r.one_time_date === dateStr;
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
function callLink(mobile) {
  const num = toWhatsappNumber(mobile);
  return num ? `tel:+${num}` : null;
}

function formatCountdown(mins) {
  if (mins == null || !isFinite(mins)) return '';
  if (mins < 0) {
    const overdue = Math.abs(mins);
    const h = Math.floor(overdue / 60);
    const m = Math.round(overdue % 60);
    return h > 0 ? `overdue ${h}h ${m}m` : `overdue ${m} min`;
  }
  if (mins < 1) return 'now';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

function tagCountdownText(mins) {
  if (mins == null) return '';
  const formatted = formatCountdown(mins);
  return mins < 0 ? ` · ${formatted.replace('overdue', 'by')}` : ` · in ${formatted}`;
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
  const [uberUrls, setUberUrls] = useState({});
  const resolvingUberRef = useRef(new Set());
  const togglingRef = useRef(new Set());
  const textCoordCache = useRef({});
  const [copyOpenId, setCopyOpenId] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [statsRange, setStatsRange] = useState('week');
  const [statsData, setStatsData] = useState([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
  });
  const [selectedWeekday, setSelectedWeekday] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [driverMsgCopiedId, setDriverMsgCopiedId] = useState(null);
  const [completingKey, setCompletingKey] = useState(null);
  const [completionInputs, setCompletionInputs] = useState({ ride_cost: '', tip: '', money_out: '', cost: '' });
  const [editingHistoryId, setEditingHistoryId] = useState(null);
  const [historyEditInputs, setHistoryEditInputs] = useState({ ride_cost: '', tip: '', money_out: '', cost: '' });
  const [historyFilterRide, setHistoryFilterRide] = useState(null);
  const [selectedHistoryDay, setSelectedHistoryDay] = useState(null);
  const [teamStats, setTeamStats] = useState([]);
  const [loadingTeamStats, setLoadingTeamStats] = useState(false);
  const [cliqPayments, setCliqPayments] = useState([]);
  const [loadingCliq, setLoadingCliq] = useState(false);
  const [cliqForm, setCliqForm] = useState({ customerChoice: '', customName: '', tripType: 'round_trip', amount: '' });
  const [cliqTeamTotal, setCliqTeamTotal] = useState(0);
  const [todaysHistory, setTodaysHistory] = useState([]);

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

  // Pre-resolves Uber links for today's scheduled rides only (not the whole
  // customer roster — Customers/Quick list/Calendar resolve lazily on expand
  // instead, see toggleExpand). Keeps this from firing dozens of unnecessary
  // lookups every time you switch agents.
  useEffect(() => {
    const bWeekday = businessWeekday(new Date());
    const bDayStr = businessDayStr(new Date());
    const relevant = ridesScheduledOnWeekday(rides.filter((r) => r.agent === filterAgent), bWeekday, bDayStr);
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

  const loadTodaysHistory = useCallback(async () => {
    if (!session) return;
    const bDay = businessDayStr(new Date());
    const { data, error } = await supabase
      .from('trip_history')
      .select('*')
      .eq('agent', filterAgent)
      .eq('business_day', bDay);
    if (!error) setTodaysHistory(data || []);
  }, [session, filterAgent]);

  useEffect(() => {
    if (session && view === 'today' && filterAgent !== 'Team') loadTodaysHistory();
  }, [session, view, filterAgent, loadTodaysHistory]);

  const loadHistory = useCallback(async () => {
    if (!session) return;
    setLoadingHistory(true);
    let query = supabase
      .from('trip_history')
      .select('*')
      .eq('agent', filterAgent)
      .order('completed_at', { ascending: false })
      .limit(200);
    if (historyFilterRide) query = query.eq('ride_id', historyFilterRide.id);
    const { data, error } = await query;
    if (error) setError(error.message);
    else setHistory(data || []);
    setLoadingHistory(false);
  }, [session, filterAgent, historyFilterRide]);

  useEffect(() => {
    setSelectedHistoryDay(null);
  }, [filterAgent]);

  useEffect(() => {
    if (session && view === 'history') loadHistory();
  }, [session, view, filterAgent, historyFilterRide, loadHistory]);

  const loadStats = useCallback(async () => {
    if (!session) return;
    setLoadingStats(true);
    const bDay = businessDayStr(new Date());
    const daysBack = statsRange === 'today' ? 0 : statsRange === 'week' ? 6 : 29;
    const [y, m, d] = bDay.split('-').map(Number);
    const fromDate = new Date(y, m - 1, d);
    fromDate.setDate(fromDate.getDate() - daysBack);
    const fromStr = localDateStr(fromDate);

    const { data, error } = await supabase
      .from('trip_history')
      .select('amount, leg, business_day')
      .eq('agent', filterAgent)
      .gte('business_day', fromStr);
    if (error) setError(error.message);
    else setStatsData(data || []);
    setLoadingStats(false);
  }, [session, filterAgent, statsRange]);

  useEffect(() => {
    if (session && view === 'stats') loadStats();
  }, [session, view, filterAgent, statsRange, loadStats]);

  const loadTeamStats = useCallback(async () => {
    if (!session) return;
    setLoadingTeamStats(true);
    const bDay = businessDayStr(new Date());
    const { data, error } = await supabase
      .from('trip_history')
      .select('amount, leg, completed_at')
      .in('agent', AGENTS)
      .eq('business_day', bDay);
    if (error) setError(error.message);
    else setTeamStats(data || []);
    setLoadingTeamStats(false);
  }, [session]);

  useEffect(() => {
    if (session && filterAgent === 'Team') loadTeamStats();
  }, [session, filterAgent, loadTeamStats]);

  // Cliq payments are combined across everyone — not tied to a single agent —
  // so this loads regardless of which agent tab you're on.
  const loadCliqPayments = useCallback(async () => {
    if (!session) return;
    setLoadingCliq(true);
    const { data, error } = await supabase
      .from('cliq_payments')
      .select('*')
      .order('paid_at', { ascending: false })
      .limit(100);
    if (error) setError(error.message);
    else setCliqPayments(data || []);
    setLoadingCliq(false);
  }, [session]);

  useEffect(() => {
    if (session && view === 'paid') loadCliqPayments();
  }, [session, view, loadCliqPayments]);

  const loadCliqTeamTotal = useCallback(async () => {
    if (!session) return;
    const bDay = businessDayStr(new Date());
    const { data, error } = await supabase
      .from('cliq_payments')
      .select('amount')
      .eq('business_day', bDay);
    if (!error) setCliqTeamTotal((data || []).reduce((s, c) => s + (parseFloat(c.amount) || 0), 0));
  }, [session]);

  useEffect(() => {
    if (session && filterAgent === 'Team') loadCliqTeamTotal();
  }, [session, filterAgent, loadCliqTeamTotal]);

  async function saveCliqPayment() {
    const name = cliqForm.customerChoice === '__other__' ? cliqForm.customName.trim() : cliqForm.customerChoice;
    if (!name) {
      setError('Pick a customer or type a name for the Cliq payment.');
      return;
    }
    const amount = parseFloat(cliqForm.amount) || 0;
    const bDay = businessDayStr(new Date());
    const { error } = await supabase.from('cliq_payments').insert({
      user_id: session.user.id,
      customer_name: name,
      trip_type: cliqForm.tripType,
      amount,
      business_day: bDay,
    });
    if (error) setError(error.message);
    else {
      setCliqForm({ customerChoice: '', customName: '', tripType: 'round_trip', amount: '' });
      loadCliqPayments();
    }
  }

  async function deleteCliqPayment(id) {
    if (!confirm('Delete this Cliq payment?')) return;
    const { error } = await supabase.from('cliq_payments').delete().eq('id', id);
    if (error) setError(error.message);
    else loadCliqPayments();
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
      paid: !!ride.paid,
      active: ride.active !== false,
      is_one_time: !!ride.one_time_date,
      one_time_date: ride.one_time_date || '',
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
    if (form.is_one_time && !form.one_time_date) {
      setError('Pick a date for the one-time ride.');
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
      paid: form.paid,
      active: form.active,
      one_time_date: form.is_one_time ? form.one_time_date : null,
    };

    // If an address changed, its cached coordinates are now wrong — clear them so
    // it gets re-resolved instead of quietly sending Uber to the old location.
    const original = editingId ? rides.find((r) => r.id === editingId) : null;
    ['to_work', 'way_back'].forEach((leg) => {
      const pickupField = `${leg}_pickup`;
      const destField = `${leg}_dest`;
      const pickupChanged = !original || original[pickupField] !== payload[pickupField];
      const destChanged = !original || original[destField] !== payload[destField];
      if (pickupChanged) { payload[`${pickupField}_lat`] = null; payload[`${pickupField}_lon`] = null; }
      if (destChanged) { payload[`${destField}_lat`] = null; payload[`${destField}_lon`] = null; }
    });

    let saveError;
    if (editingId) {
      const { error } = await supabase.from('rides').update(payload).eq('id', editingId);
      saveError = error;
      if (!error) {
        // Drop any in-memory resolved link for this ride so the (possibly new)
        // address gets looked up fresh instead of reusing a stale result.
        resolvingUberRef.current.delete(`${editingId}-to_work`);
        resolvingUberRef.current.delete(`${editingId}-way_back`);
        setUberUrls((u) => {
          const next = { ...u };
          delete next[`${editingId}-to_work`];
          delete next[`${editingId}-way_back`];
          return next;
        });
      }
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

  // Opens the inline ride-cost/tip form on a leg instead of completing it instantly.
  function startCompleting(ride, leg) {
    setCompletingKey(`${ride.id}-${leg}`);
    setCompletionInputs({ ride_cost: '', tip: '', money_out: '', cost: '' });
  }

  function cancelCompleting() {
    setCompletingKey(null);
  }

  // Confirms completion with whatever ride cost/tip were entered. Money out and
  // cost are left blank here on purpose — those get filled in later (e.g. by
  // Hamzah) from the History tab, via editHistoryEntry.
  async function confirmComplete(ride, leg) {
    const flightKey = `${ride.id}-${leg}`;
    if (togglingRef.current.has(flightKey)) return;
    togglingRef.current.add(flightKey);

    try {
      const field = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
      const bDay = businessDayStr(new Date());

      const { error } = await supabase
        .from('rides')
        .update({ [field]: bDay })
        .eq('id', ride.id);
      if (error) {
        setError(error.message);
        return;
      }

      const toNumOrNull = (v) => (v === '' ? null : parseFloat(v) || 0);
      // The price shown on each completed leg is the full ride price (not split)
      // — but wherever totals are summed (History, Earnings, Team), they're
      // deduped per ride-per-day via sumDistinctRideDay() so a round-trip
      // customer's price doesn't get counted twice just because both legs
      // were completed.
      const fullAmount = parseFloat(ride.amount) || 0;

      await supabase.from('trip_history').insert({
        user_id: session.user.id,
        ride_id: ride.id,
        agent: ride.agent,
        customer_name: ride.name,
        leg,
        amount: fullAmount,
        ride_cost: toNumOrNull(completionInputs.ride_cost),
        tip: toNumOrNull(completionInputs.tip),
        money_out: toNumOrNull(completionInputs.money_out),
        cost: toNumOrNull(completionInputs.cost),
        business_day: bDay,
      });

      setCompletingKey(null);
      loadRides();
      loadTodaysHistory();
      if (view === 'history') loadHistory();
    } finally {
      togglingRef.current.delete(flightKey);
    }
  }

  // Undoing a completion doesn't need the cost/tip form — just reverses it.
  async function uncompleteLeg(ride, leg) {
    const flightKey = `${ride.id}-${leg}`;
    if (togglingRef.current.has(flightKey)) return;
    togglingRef.current.add(flightKey);

    try {
      const field = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
      const bDay = businessDayStr(new Date());

      const { error } = await supabase
        .from('rides')
        .update({ [field]: null })
        .eq('id', ride.id);
      if (error) {
        setError(error.message);
        return;
      }

      await supabase.from('trip_history').delete()
        .eq('ride_id', ride.id).eq('leg', leg).eq('business_day', bDay);

      loadRides();
      loadTodaysHistory();
      if (view === 'history') loadHistory();
    } finally {
      togglingRef.current.delete(flightKey);
    }
  }

  async function skipLeg(ride, leg) {
    const skipField = leg === 'to_work' ? 'to_work_skipped_date' : 'way_back_skipped_date';
    const bDay = businessDayStr(new Date());
    const { error } = await supabase.from('rides').update({ [skipField]: bDay }).eq('id', ride.id);
    if (error) setError(error.message);
    else loadRides();
  }

  async function unskipLeg(ride, leg) {
    const skipField = leg === 'to_work' ? 'to_work_skipped_date' : 'way_back_skipped_date';
    const { error } = await supabase.from('rides').update({ [skipField]: null }).eq('id', ride.id);
    if (error) setError(error.message);
    else loadRides();
  }

  function viewCustomerHistory(ride) {
    setHistoryFilterRide(ride);
    setSelectedHistoryDay(null);
    setView('history');
  }

  function clearHistoryFilter() {
    setHistoryFilterRide(null);
    setSelectedHistoryDay(null);
  }

  function startEditingHistory(entry) {
    setEditingHistoryId(entry.id);
    setHistoryEditInputs({
      ride_cost: entry.ride_cost ?? '',
      tip: entry.tip ?? '',
      money_out: entry.money_out ?? '',
      cost: entry.cost ?? '',
    });
  }

  function cancelEditingHistory() {
    setEditingHistoryId(null);
  }

  async function saveHistoryEdit(entryId) {
    const toNumOrNull = (v) => (v === '' ? null : parseFloat(v) || 0);
    const { error } = await supabase.from('trip_history').update({
      ride_cost: toNumOrNull(historyEditInputs.ride_cost),
      tip: toNumOrNull(historyEditInputs.tip),
      money_out: toNumOrNull(historyEditInputs.money_out),
      cost: toNumOrNull(historyEditInputs.cost),
    }).eq('id', entryId);
    if (error) setError(error.message);
    else {
      setEditingHistoryId(null);
      loadHistory();
      loadTodaysHistory();
    }
  }

  async function deleteHistoryEntry(entryId) {
    if (!confirm('Delete this history entry?')) return;
    const { error } = await supabase.from('trip_history').delete().eq('id', entryId);
    if (error) setError(error.message);
    else {
      loadHistory();
      loadTodaysHistory();
    }
  }

  async function togglePaid(ride) {
    const { error } = await supabase.from('rides').update({ paid: !ride.paid }).eq('id', ride.id);
    if (error) setError(error.message);
    else loadRides();
  }

  async function toggleActive(ride) {
    const { error } = await supabase.from('rides').update({ active: ride.active === false }).eq('id', ride.id);
    if (error) setError(error.message);
    else loadRides();
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

  // Resolves plain addresses or maps links to coordinates. Full links with
  // @lat,lng resolve instantly with no network call. Everything else goes
  // through our own /api/resolve-location route (see that file for why this
  // has to happen server-side rather than in the browser).
  async function resolveCoord(text) {
    if (!text) return null;
    if (isUrl(text)) {
      const direct = extractCoordsFromUrl(text);
      if (direct) return direct;
    }
    const key = text.trim().toLowerCase();
    if (textCoordCache.current[key] !== undefined) return textCoordCache.current[key];
    let coord = null;
    try {
      const res = await fetch(`/api/resolve-location?text=${encodeURIComponent(text)}`);
      const data = await res.json();
      coord = data.coords || null;
    } catch (e) {
      coord = null;
    }
    textCoordCache.current[key] = coord;
    return coord;
  }

  // Resolves a leg's Uber link in the background, well before the button is tapped.
  // This is the fix: iOS will only open the Uber app (instead of falling back to the
  // website) when the link is a real <a href> tapped directly — any lookup done
  // *after* the tap breaks that trust and Safari loads the web page instead.
  //
  // Coordinates are cached permanently on the ride itself (see migration 5) —
  // once an address is resolved, it's never looked up again on any device,
  // unless the address text changes (handleSave clears the cache for legs
  // whose text was edited).
  async function resolveUberUrl(ride, leg) {
    const key = `${ride.id}-${leg}`;
    if (resolvingUberRef.current.has(key) || uberUrls[key] !== undefined) return;
    resolvingUberRef.current.add(key);

    const pickupText = leg === 'to_work' ? ride.to_work_pickup : ride.way_back_pickup;
    const destText = leg === 'to_work' ? ride.to_work_dest : ride.way_back_dest;
    const pickupLatField = `${leg}_pickup_lat`;
    const pickupLonField = `${leg}_pickup_lon`;
    const destLatField = `${leg}_dest_lat`;
    const destLonField = `${leg}_dest_lon`;

    const cachedPickup = ride[pickupLatField] != null && ride[pickupLonField] != null
      ? { lat: ride[pickupLatField], lon: ride[pickupLonField] }
      : null;
    const cachedDest = ride[destLatField] != null && ride[destLonField] != null
      ? { lat: ride[destLatField], lon: ride[destLonField] }
      : null;

    const [pickupCoord, destCoord] = await Promise.all([
      cachedPickup || resolveCoord(pickupText),
      cachedDest || resolveCoord(destText),
    ]);

    let url = null;
    if (pickupCoord && destCoord) {
      url =
        `https://m.uber.com/ul/?action=setPickup` +
        `&pickup[latitude]=${pickupCoord.lat}&pickup[longitude]=${pickupCoord.lon}&pickup[nickname]=${encodeURIComponent(pickupText)}` +
        `&dropoff[latitude]=${destCoord.lat}&dropoff[longitude]=${destCoord.lon}&dropoff[nickname]=${encodeURIComponent(destText)}`;

      // Persist newly-resolved coordinates so this address is never geocoded again.
      const updates = {};
      if (!cachedPickup) { updates[pickupLatField] = pickupCoord.lat; updates[pickupLonField] = pickupCoord.lon; }
      if (!cachedDest) { updates[destLatField] = destCoord.lat; updates[destLonField] = destCoord.lon; }
      if (Object.keys(updates).length > 0) {
        supabase.from('rides').update(updates).eq('id', ride.id).then(() => {});
      }
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
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Lazily resolve this ride's Uber links only now that it's actually
        // being looked at — Customers/Quick list aren't pre-resolved eagerly.
        const ride = rides.find((r) => r.id === id);
        if (ride) {
          ['to_work', 'way_back'].forEach((leg) => {
            const enabled = leg === 'to_work' ? ride.to_work_enabled !== false : ride.way_back_enabled !== false;
            const time = leg === 'to_work' ? ride.to_work_time : ride.way_back_time;
            const pickup = leg === 'to_work' ? ride.to_work_pickup : ride.way_back_pickup;
            const dest = leg === 'to_work' ? ride.to_work_dest : ride.way_back_dest;
            if (enabled && time && canUber(pickup) && canUber(dest)) resolveUberUrl(ride, leg);
          });
        }
      }
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
  const allCustomerNames = [...new Set(rides.filter((r) => AGENTS.includes(r.agent)).map((r) => r.name))].sort((a, b) => a.localeCompare(b));
  const searchedRides = searchQuery.trim()
    ? agentRides.filter((r) => r.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : agentRides;
  const todaysRides = ridesScheduledOnWeekday(agentRides, todayWeekday, businessDay);
  const pendingToday = todaysRides.filter((r) => !isResolvedToday(r, businessDay));
  const completedToday = todaysRides.filter((r) => isFullyComplete(r, businessDay));
  const skippedToday = todaysRides.filter((r) => isResolvedToday(r, businessDay) && !isFullyComplete(r, businessDay));

  const sortedPending = [...pendingToday].sort((a, b) => {
    const [pa, ta] = sortKey(a, now, businessDay);
    const [pb, tb] = sortKey(b, now, businessDay);
    if (pa !== pb) return pa - pb;
    return ta - tb;
  });
  const total = todaysRides.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const toWorkCountToday = todaysRides.filter((r) => activeLegs(r).includes('to_work')).length;
  const wayBackCountToday = todaysRides.filter((r) => activeLegs(r).includes('way_back')).length;
  const firstPendingId = sortedPending[0]?.id;
  const nextUpMinutes = sortedPending.length > 0 ? sortKey(sortedPending[0], now, businessDay)[1] : null;

  const statsTotal = sumDistinctRideDay(statsData);
  const statsToWorkCount = statsData.filter((h) => h.leg === 'to_work').length;
  const statsWayBackCount = statsData.filter((h) => h.leg === 'way_back').length;

  const daysInCalMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const firstWeekday = calendarMonth.getDay();

  function legInfo(ride, leg) {
    const enabled = leg === 'to_work' ? ride.to_work_enabled !== false : ride.way_back_enabled !== false;
    const time = leg === 'to_work' ? ride.to_work_time : ride.way_back_time;
    const pickup = leg === 'to_work' ? ride.to_work_pickup : ride.way_back_pickup;
    const dest = leg === 'to_work' ? ride.to_work_dest : ride.way_back_dest;
    const doneField = leg === 'to_work' ? 'to_work_completed_date' : 'way_back_completed_date';
    const skipField = leg === 'to_work' ? 'to_work_skipped_date' : 'way_back_skipped_date';
    return {
      enabled, time, pickup, dest,
      done: ride[doneField] === businessDay,
      skipped: ride[skipField] === businessDay,
    };
  }

  function renderHistoryEntry(h) {
    const needsAmounts = h.money_out == null || h.cost == null;
    return (
      <div className="history-row-wrap" key={h.id}>
        <div className="history-row">
          <div>
            <div className="entry-name">{h.customer_name || 'Unknown'}</div>
            <div className="sub" style={{ marginTop: 2 }}>
              {formatHistoryDayLabel(h.business_day, businessDay)} · {h.leg === 'to_work' ? 'To work' : 'Way back'} · {new Date(h.completed_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </div>
          </div>
          <div className="entry-amount">${(parseFloat(h.amount) || 0).toFixed(2)}</div>
        </div>

        {editingHistoryId === h.id ? (
          <div className="complete-form">
            <input type="number" step="0.01" inputMode="decimal" placeholder="Ride cost"
              value={historyEditInputs.ride_cost}
              onChange={(e) => setHistoryEditInputs((c) => ({ ...c, ride_cost: e.target.value }))} />
            <input type="number" step="0.01" inputMode="decimal" placeholder="Tip"
              value={historyEditInputs.tip}
              onChange={(e) => setHistoryEditInputs((c) => ({ ...c, tip: e.target.value }))} />
            <input type="number" step="0.01" inputMode="decimal" placeholder="Money out"
              value={historyEditInputs.money_out}
              onChange={(e) => setHistoryEditInputs((c) => ({ ...c, money_out: e.target.value }))} />
            <input type="number" step="0.01" inputMode="decimal" placeholder="Cost"
              value={historyEditInputs.cost}
              onChange={(e) => setHistoryEditInputs((c) => ({ ...c, cost: e.target.value }))} />
            <div className="complete-form-actions">
              <button className="complete-form-confirm" onClick={() => saveHistoryEdit(h.id)}>Save</button>
              <button className="complete-form-cancel" onClick={cancelEditingHistory}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="history-amounts">
            <span>Ride cost: {h.ride_cost != null ? `$${parseFloat(h.ride_cost).toFixed(2)}` : '—'}</span>
            <span>Tip: {h.tip != null ? `$${parseFloat(h.tip).toFixed(2)}` : '—'}</span>
            <span>Money out: {h.money_out != null ? `$${parseFloat(h.money_out).toFixed(2)}` : '—'}</span>
            <span>Cost: {h.cost != null ? `$${parseFloat(h.cost).toFixed(2)}` : '—'}</span>
            <button className={needsAmounts ? 'needs-amounts' : ''} onClick={() => startEditingHistory(h)}>
              {needsAmounts ? 'Add amounts' : 'Edit amounts'}
            </button>
            <button onClick={() => deleteHistoryEntry(h.id)}>Delete</button>
          </div>
        )}
      </div>
    );
  }

  function renderRideCard(r, opts = {}) {
    const isNextUp = opts.isNextUp;
    const isExpanded = expandedIds.has(r.id);
    const wa = waLink(r.mobile_number);
    const call = callLink(r.mobile_number);
    const isOverdue = isNextUp && opts.nextUpMinutes != null && opts.nextUpMinutes < 0;
    return (
      <div className={`entry ${isNextUp ? 'next-up' : ''} ${isOverdue ? 'overdue' : ''} ${(opts.dimmed || opts.skippedSection) ? 'entry-dimmed' : ''}`} key={r.id}>
        {isNextUp && (
          <div className={`next-up-tag ${isOverdue ? 'overdue' : ''}`}>
            <span className="pulse-dot"></span>
            {isOverdue ? '⚠️ Overdue' : 'Up next'}
            {tagCountdownText(opts.nextUpMinutes)}
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
              return (
                <span key={leg} className={`mini-time ${leg === 'to_work' ? 'to-work' : 'way-back'} ${info.done ? 'done' : ''}`}>
                  {leg === 'to_work' ? '🏢' : '🏠'} {fmtTime(info.time)}{info.done ? ' ✓' : ''}
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
                {call && (
                  <a className="call-btn" href={call}>
                    Call
                  </a>
                )}
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
              const legKey = `${r.id}-${leg}`;
              const isCompleting = completingKey === legKey;
              return (
                <div key={leg}>
                  <div className={`trip-line trip-line-${tagClass}`}>
                    <span className={`trip-tag ${tagClass}`}>{tagLabel}</span>
                    <span className="trip-time">{fmtTime(info.time)}</span>
                    <span className="trip-route">{renderLocation(info.pickup)} <span className="trip-arrow">→</span> {renderLocation(info.dest)}</span>
                  </div>
                  {!opts.dimmed && isCompleting && (
                    <div className="complete-form">
                      <input
                        type="number" step="0.01" inputMode="decimal" placeholder="Ride cost"
                        value={completionInputs.ride_cost}
                        onChange={(e) => setCompletionInputs((c) => ({ ...c, ride_cost: e.target.value }))}
                      />
                      <input
                        type="number" step="0.01" inputMode="decimal" placeholder="Tip"
                        value={completionInputs.tip}
                        onChange={(e) => setCompletionInputs((c) => ({ ...c, tip: e.target.value }))}
                      />
                      <input
                        type="number" step="0.01" inputMode="decimal" placeholder="Money out"
                        value={completionInputs.money_out}
                        onChange={(e) => setCompletionInputs((c) => ({ ...c, money_out: e.target.value }))}
                      />
                      <input
                        type="number" step="0.01" inputMode="decimal" placeholder="Cost"
                        value={completionInputs.cost}
                        onChange={(e) => setCompletionInputs((c) => ({ ...c, cost: e.target.value }))}
                      />
                      <div className="sub" style={{ width: '100%', marginTop: -4 }}>
                        Leave any of these blank if you don't know them yet — fill them in later from here or History.
                      </div>
                      <div className="complete-form-actions">
                        <button className="complete-form-confirm" onClick={() => confirmComplete(r, leg)}>
                          Confirm complete
                        </button>
                        <button className="complete-form-cancel" onClick={cancelCompleting}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {!opts.dimmed && !isCompleting && (
                    <div className="trip-actions">
                      {info.skipped ? (
                        <button className="complete-btn skipped" onClick={() => unskipLeg(r, leg)}>
                          ⏭ Skipped — undo
                        </button>
                      ) : (
                        <>
                          <button
                            className={`complete-btn ${info.done ? 'done' : ''}`}
                            onClick={() => info.done ? uncompleteLeg(r, leg) : startCompleting(r, leg)}
                          >
                            {info.done ? '✓ Completed' : `Mark ${leg === 'to_work' ? 'to-work' : 'way-back'} complete`}
                          </button>
                          {!info.done && (
                            <button className="skip-btn" onClick={() => skipLeg(r, leg)}>Skip today</button>
                          )}
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
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {opts.dimmed && (
              <div className="dimmed-legs">
                {['to_work', 'way_back'].map((leg) => {
                  const info = legInfo(r, leg);
                  if (!info.enabled || !info.time) return null;
                  const entry = todaysHistory.find((h) => h.ride_id === r.id && h.leg === leg);
                  return (
                    <div key={leg} className="dimmed-leg-block">
                      <button className="complete-btn done" onClick={() => uncompleteLeg(r, leg)}>
                        ✓ {leg === 'to_work' ? 'To-work' : 'Way-back'} done — undo
                      </button>
                      {entry && (
                        editingHistoryId === entry.id ? (
                          <div className="complete-form">
                            <input type="number" step="0.01" inputMode="decimal" placeholder="Ride cost"
                              value={historyEditInputs.ride_cost}
                              onChange={(e) => setHistoryEditInputs((c) => ({ ...c, ride_cost: e.target.value }))} />
                            <input type="number" step="0.01" inputMode="decimal" placeholder="Tip"
                              value={historyEditInputs.tip}
                              onChange={(e) => setHistoryEditInputs((c) => ({ ...c, tip: e.target.value }))} />
                            <input type="number" step="0.01" inputMode="decimal" placeholder="Money out"
                              value={historyEditInputs.money_out}
                              onChange={(e) => setHistoryEditInputs((c) => ({ ...c, money_out: e.target.value }))} />
                            <input type="number" step="0.01" inputMode="decimal" placeholder="Cost"
                              value={historyEditInputs.cost}
                              onChange={(e) => setHistoryEditInputs((c) => ({ ...c, cost: e.target.value }))} />
                            <div className="complete-form-actions">
                              <button className="complete-form-confirm" onClick={() => saveHistoryEdit(entry.id)}>Save</button>
                              <button className="complete-form-cancel" onClick={cancelEditingHistory}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="history-amounts">
                            <span>Ride cost: {entry.ride_cost != null ? `$${parseFloat(entry.ride_cost).toFixed(2)}` : '—'}</span>
                            <span>Tip: {entry.tip != null ? `$${parseFloat(entry.tip).toFixed(2)}` : '—'}</span>
                            <span>Money out: {entry.money_out != null ? `$${parseFloat(entry.money_out).toFixed(2)}` : '—'}</span>
                            <span>Cost: {entry.cost != null ? `$${parseFloat(entry.cost).toFixed(2)}` : '—'}</span>
                            <button onClick={() => startEditingHistory(entry)}>Edit amounts</button>
                            <button onClick={() => deleteHistoryEntry(entry.id)}>Delete</button>
                          </div>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {opts.skippedSection && (
              <div className="dimmed-legs">
                {['to_work', 'way_back'].map((leg) => {
                  const info = legInfo(r, leg);
                  if (!info.enabled || !info.time) return null;
                  if (info.skipped) {
                    return (
                      <div key={leg} className="dimmed-leg-block">
                        <button className="complete-btn skipped" onClick={() => unskipLeg(r, leg)}>
                          ⏭ {leg === 'to_work' ? 'To-work' : 'Way-back'} skipped — undo
                        </button>
                      </div>
                    );
                  }
                  if (info.done) {
                    const entry = todaysHistory.find((h) => h.ride_id === r.id && h.leg === leg);
                    return (
                      <div key={leg} className="dimmed-leg-block">
                        <button className="complete-btn done" onClick={() => uncompleteLeg(r, leg)}>
                          ✓ {leg === 'to_work' ? 'To-work' : 'Way-back'} done — undo
                        </button>
                        {entry && (
                          <div className="history-amounts">
                            <span>Ride cost: {entry.ride_cost != null ? `$${parseFloat(entry.ride_cost).toFixed(2)}` : '—'}</span>
                            <span>Tip: {entry.tip != null ? `$${parseFloat(entry.tip).toFixed(2)}` : '—'}</span>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return null;
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

      {view === 'today' && filterAgent !== 'Team' && (
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

            <div className="toggle-row">
              <span>One-time ride</span>
              <label className="switch">
                <input type="checkbox" checked={form.is_one_time} onChange={(e) => updateField('is_one_time', e.target.checked)} />
                <span className="track"></span>
              </label>
            </div>

            {form.is_one_time ? (
              <>
                <label>Which date?</label>
                <input type="date" value={form.one_time_date} onChange={(e) => updateField('one_time_date', e.target.value)} />
                <div className="sub" style={{ marginTop: 6, marginBottom: 4 }}>
                  Only shows up on this one date — not recurring.
                </div>
              </>
            ) : (
              <>
                <label>Which days does this ride happen?</label>
                <div className="day-chips">
                  {DAY_LABELS.map((label, idx) => (
                    <div key={idx} className={`day-chip ${form.days_of_week.includes(idx) ? 'active' : ''}`} onClick={() => toggleDay(idx)}>
                      {label}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="toggle-row">
              <span>Paid</span>
              <label className="switch">
                <input type="checkbox" checked={form.paid} onChange={(e) => updateField('paid', e.target.checked)} />
                <span className="track"></span>
              </label>
            </div>

            <div className="toggle-row">
              <span>Active on schedule</span>
              <label className="switch">
                <input type="checkbox" checked={form.active} onChange={(e) => updateField('active', e.target.checked)} />
                <span className="track"></span>
              </label>
            </div>
            {!form.active && (
              <div className="sub" style={{ marginTop: -6, marginBottom: 10 }}>
                Kept in Customers, hidden from Today and the calendar.
              </div>
            )}

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
        {[...AGENTS, 'Team'].map((a) => (
          <div key={a} className={`tab ${filterAgent === a ? 'active' : ''} ${a === 'Team' ? 'team-tab' : ''}`} onClick={() => setFilterAgent(a)}>
            {a}
          </div>
        ))}
      </div>

      {filterAgent !== 'Team' && (
        <div className="subtabs">
          {VIEWS.map((v) => (
            <div key={v} className={`subtab ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
              {VIEW_LABELS[v]}
            </div>
          ))}
        </div>
      )}

      {filterAgent !== 'Team' && (
        <>
      {view === 'today' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s rides today</h2>
            <div className="total-pill">${total.toFixed(2)}</div>
          </div>
          <div className="stats-row">
            <span className="stat-pill">🏢 {toWorkCountToday} to-work</span>
            <span className="stat-pill">🏠 {wayBackCountToday} way-back</span>
          </div>

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
              {skippedToday.map((r) => renderRideCard(r, { skippedSection: true }))}
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
          <input
            className="search-box"
            placeholder="Search by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchedRides.length === 0 ? (
            <div className="empty">{searchQuery ? 'No matches.' : `No customers yet for ${filterAgent}.`}</div>
          ) : (
            searchedRides.map((r) => {
              const isExpanded = expandedIds.has(r.id);
              const wa = waLink(r.mobile_number);
              const call = callLink(r.mobile_number);
              return (
                <div className={`entry ${r.active === false ? 'entry-dimmed' : ''}`} key={r.id}>
                  <div className="entry-top entry-top-clickable" onClick={() => toggleExpand(r.id)}>
                    <div className="entry-name">
                      {r.name}
                      {r.active === false && <span className="paused-tag">Paused</span>}
                    </div>
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
                      {r.one_time_date ? (
                        <div className="one-time-tag" style={{ marginTop: 10 }}>
                          📅 One-time — {new Date(r.one_time_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </div>
                      ) : (
                        <div className="day-chips" style={{ marginTop: 10 }}>
                          {DAY_LABELS.map((label, idx) => (
                            <div key={idx} className={`day-chip mini ${(!r.days_of_week || r.days_of_week.length === 0 || r.days_of_week.includes(idx)) ? 'active' : ''}`}>
                              {label}
                            </div>
                          ))}
                        </div>
                      )}

                      {r.mobile_number && (
                        <div className="copy-row">
                          <span>{r.mobile_number}</span>
                          <button className="copy-btn" onClick={() => copyNumber(r)}>
                            {copiedId === r.id ? 'Copied!' : 'Copy'}
                          </button>
                          {call && (
                            <a className="call-btn" href={call}>
                              Call
                            </a>
                          )}
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
                        <button className={r.paid ? 'paid-toggle-on' : ''} onClick={() => togglePaid(r)}>
                          {r.paid ? '✓ Paid' : 'Mark paid'}
                        </button>
                        <button onClick={() => toggleActive(r)}>
                          {r.active === false ? 'Reactivate' : 'Pause'}
                        </button>
                        <button onClick={() => viewCustomerHistory(r)}>History</button>
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

      {view === 'paid' && (
        <>
          <div className="list-header">
            <h2>Cliq payments <span className="history-count">(everyone)</span></h2>
          </div>
          <div className="complete-form">
            <select
              value={cliqForm.customerChoice}
              onChange={(e) => setCliqForm((c) => ({ ...c, customerChoice: e.target.value }))}
            >
              <option value="">Pick a customer...</option>
              {allCustomerNames.map((n) => <option key={n} value={n}>{n}</option>)}
              <option value="__other__">Other — type a name</option>
            </select>
            {cliqForm.customerChoice === '__other__' && (
              <input
                placeholder="Customer name"
                value={cliqForm.customName}
                onChange={(e) => setCliqForm((c) => ({ ...c, customName: e.target.value }))}
              />
            )}
            <select
              value={cliqForm.tripType}
              onChange={(e) => setCliqForm((c) => ({ ...c, tripType: e.target.value }))}
            >
              <option value="one_way">One way</option>
              <option value="round_trip">Round trip (2 ways)</option>
            </select>
            <input
              type="number" step="0.01" inputMode="decimal" placeholder="Amount"
              value={cliqForm.amount}
              onChange={(e) => setCliqForm((c) => ({ ...c, amount: e.target.value }))}
            />
            <div className="complete-form-actions">
              <button className="complete-form-confirm" onClick={saveCliqPayment}>Log Cliq payment</button>
            </div>
          </div>

          {loadingCliq ? (
            <div className="loading">Loading...</div>
          ) : cliqPayments.length === 0 ? (
            <div className="empty">No Cliq payments logged yet.</div>
          ) : (
            cliqPayments.map((c) => (
              <div className="history-row" key={c.id}>
                <div>
                  <div className="entry-name">{c.customer_name}</div>
                  <div className="sub" style={{ marginTop: 2 }}>
                    {c.trip_type === 'one_way' ? 'One way' : 'Round trip'} · {new Date(c.paid_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="entry-amount">${(parseFloat(c.amount) || 0).toFixed(2)}</div>
                  <button onClick={() => deleteCliqPayment(c.id)}>Delete</button>
                </div>
              </div>
            ))
          )}

          <div className="list-header">
            <h2>{filterAgent}'s paid customers</h2>
            <div className="total-pill">{agentRides.filter((r) => r.paid).length}</div>
          </div>
          {agentRides.filter((r) => r.paid).length === 0 ? (
            <div className="empty">No customers marked paid yet.</div>
          ) : (
            agentRides.filter((r) => r.paid).map((r) => (
              <div className="entry" key={r.id}>
                <div className="entry-top">
                  <div className="entry-name">{r.name}</div>
                  <div className="entry-amount">${(parseFloat(r.amount) || 0).toFixed(2)}</div>
                </div>
                <div className="entry-actions">
                  <button onClick={() => startEdit(r)}>Edit</button>
                  <button onClick={() => togglePaid(r)}>Mark unpaid</button>
                  <button onClick={() => handleDelete(r.id)}>Delete</button>
                </div>
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
              const count = ridesScheduledOnWeekday(agentRides, weekday, localDateStr(cellDate)).length;
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

      {view === 'stats' && (
        <>
          <div className="list-header">
            <h2>{filterAgent}'s earnings</h2>
          </div>
          <div className="subtabs">
            {['today', 'week', 'month'].map((r) => (
              <div key={r} className={`subtab ${statsRange === r ? 'active' : ''}`} onClick={() => setStatsRange(r)}>
                {r === 'today' ? 'Today' : r === 'week' ? 'Last 7 days' : 'Last 30 days'}
              </div>
            ))}
          </div>

          {loadingStats ? (
            <div className="loading">Loading...</div>
          ) : (
            <>
              <div className="earnings-total">${statsTotal.toFixed(2)}</div>
              <div className="stats-row">
                <span className="stat-pill">🏢 {statsToWorkCount} to-work</span>
                <span className="stat-pill">🏠 {statsWayBackCount} way-back</span>
                <span className="stat-pill">✓ {statsData.length} total legs</span>
              </div>
            </>
          )}
        </>
      )}

      {view === 'history' && (
        <>
          <div className="list-header">
            <h2>
              {historyFilterRide ? `${historyFilterRide.name}'s history`
                : selectedHistoryDay ? formatHistoryDayLabel(selectedHistoryDay, businessDay)
                : `${filterAgent}'s history`}
            </h2>
          </div>
          {historyFilterRide && (
            <div className="filter-banner">
              <span>Showing only {historyFilterRide.name}</span>
              <button onClick={clearHistoryFilter}>Show everyone</button>
            </div>
          )}
          {!historyFilterRide && selectedHistoryDay && (
            <div className="filter-banner">
              <span>{formatHistoryDayLabel(selectedHistoryDay, businessDay)}</span>
              <button onClick={() => setSelectedHistoryDay(null)}>← All dates</button>
            </div>
          )}

          {loadingHistory ? (
            <div className="loading">Loading...</div>
          ) : history.length === 0 ? (
            <div className="empty">No completed trips logged yet.</div>
          ) : historyFilterRide ? (
            // Already filtered to one specific ride's history (from a customer's "History" button).
            history.map((h) => renderHistoryEntry(h))
          ) : selectedHistoryDay ? (
            // Drilled into one date from the grid below.
            history.filter((h) => h.business_day === selectedHistoryDay).map((h) => renderHistoryEntry(h))
          ) : (
            // Overview: one compact box per day, most recent first —
            // tap a box to drill in, instead of one long scrolling list.
            <div className="customer-grid">
              {groupHistoryByDay(history).map(([day, entries]) => {
                const total = sumDistinctRideDay(entries);
                return (
                  <div key={day} className="customer-box" onClick={() => setSelectedHistoryDay(day)}>
                    <div className="customer-box-name">{formatHistoryDayLabel(day, businessDay)}</div>
                    <div className="customer-box-total">${total.toFixed(2)}</div>
                    <div className="customer-box-count">{entries.length} trip{entries.length === 1 ? '' : 's'}</div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
        </>
      )}

      {filterAgent === 'Team' && (
        <>
          <div className="list-header">
            <h2>Team overview — today</h2>
          </div>

          <div className="stats-row">
            <span className="stat-pill">👥 {rides.filter((r) => AGENTS.includes(r.agent) && r.active !== false).length} active customers</span>
            <span className="stat-pill">✓ {teamStats.length} legs completed today</span>
            <span className="stat-pill">💳 ${cliqTeamTotal.toFixed(2)} via Cliq today</span>
          </div>

          {loadingTeamStats ? (
            <div className="loading">Loading...</div>
          ) : (
            [
              { key: 'morning', label: 'Morning · 6am–2pm' },
              { key: 'evening', label: 'Evening · 2pm–8pm' },
              { key: 'night', label: 'Night · 8pm–1am' },
              { key: 'other', label: 'Other hours (1am–6am)' },
            ].map(({ key, label }) => {
              const bucket = teamStats.filter((h) => phaseForHour(new Date(h.completed_at).getHours()) === key);
              if (key === 'other' && bucket.length === 0) return null;
              const total = sumDistinctRideDay(bucket);
              return (
                <div key={key} className="phase-card">
                  <div className="phase-header">
                    <span>{label}</span>
                    <span className="total-pill">{bucket.length} legs</span>
                  </div>
                  <div className="stats-row">
                    <span className="stat-pill">💵 ${total.toFixed(2)} collected</span>
                  </div>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}


