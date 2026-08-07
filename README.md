# hth-sys — Ride Log

A mobile-first dashboard for tracking customer pickups/drop-offs across a small
team of agents. Built with Next.js and Supabase (auth + database).

## Setup

1. **Create a Supabase project** at supabase.com (free tier is fine).
2. In the Supabase dashboard, go to **SQL Editor → New query**, paste the
   contents of `supabase-setup.sql`, and run it. This creates the `rides` and
   `trip_history` tables with row-level security so each signed-in user only
   ever sees their own data. It's safe to re-run if you add columns later.
3. Copy `.env.local.example` to `.env.local` and fill in your project's URL
   and anon key (Supabase dashboard → Project Settings → API).
4. Install and run:
   ```bash
   npm install
   npm run dev
   ```
5. Open the app, sign up with an email/password, and start adding rides.

## What it does

- **Today** — add a customer, set a to-work leg and/or a way-back leg (pickup,
  destination, time), pick which agent they belong to and which days of the
  week the ride repeats. Mark each leg complete as it happens; overdue legs
  are flagged automatically, and a progress bar shows how much of the day is done.
- **Skip today** — need to skip one customer for just today (they're on vacation,
  called it off, whatever) without touching their recurring schedule? Open the
  ride and hit "Skip today". It stays off today's list and out of today's total,
  and reappears completely normally starting tomorrow — nothing about
  `days_of_week` is touched.
- **Overview** — a single screen with every agent's total for today, how many
  are still pending, and how many customers they carry overall — so you don't
  have to flip through each agent's tab just to see how the day's going.
- **Customers** — every customer for the selected agent, searchable by name or
  mobile number, with one-tap WhatsApp/copy-number and a driver-message
  template.
- **Quick list** — the fastest way to jump straight into editing a customer.
- **Calendar** — which customers are scheduled on which day of the week.
- **History** — a log of every completed leg, exportable to CSV.
- **Payments** — this week's and this month's totals, an "unsettled cash"
  running balance built from completed trips, and a one-tap "mark as settled"
  button for when an agent hands off their collected cash. A ride with both
  legs enabled has its amount split evenly across the two legs so the totals
  here always add up to what the ride is actually worth per day.
- Locations can be typed as plain text or pasted as a Google/Apple Maps link;
  when both legs of a trip have a resolvable location, an **Open in Uber**
  deep link is generated automatically.

## Notes

- Agents are currently hardcoded in `app/page.js` (`const AGENTS = [...]`).
  Add or rename agents there if your team changes.
- The "business day" rolls over at 3am, not midnight, so a ride finished at
  1am still counts toward the previous day until 3am. Overdue detection and
  the payments "this week"/"this month" totals both respect this.
- Deleting a ride keeps its earnings history intact (the `trip_history` row
  just loses its link back to the deleted ride) — past income never
  disappears just because a customer was removed later.
