// Resolves a pickup/destination field (plain text address, full maps link, or
// short maps link) into coordinates. This runs server-side on purpose:
//
// 1. Short links (maps.app.goo.gl/...) can't be followed from the browser —
//    Google's redirect target doesn't send CORS headers, so a client-side
//    fetch always fails silently. A server-to-server request has no such
//    restriction.
// 2. Nominatim's usage policy requires a real User-Agent identifying the
//    app, but browsers don't let JavaScript set that header. A server can.

function extractCoordsFromUrl(url) {
  if (!url) return null;
  let m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
  m = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
  return null;
}

function isUrl(str) {
  return /^https?:\/\//i.test((str || '').trim());
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const text = searchParams.get('text');

  if (!text) {
    return Response.json({ coords: null, error: 'missing text' }, { status: 400 });
  }

  try {
    if (isUrl(text)) {
      // Already has coordinates in it — no request needed.
      const direct = extractCoordsFromUrl(text);
      if (direct) return Response.json({ coords: direct });

      // Short link — follow the redirect server-side to find the real URL.
      const res = await fetch(text, { redirect: 'follow' });
      const finalUrl = res.url;
      const coords = extractCoordsFromUrl(finalUrl);
      return Response.json({ coords });
    }

    // Plain text address — geocode it.
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(text)}`,
      { headers: { 'User-Agent': 'RideLogApp/1.0 (personal ride-scheduling tool)' } }
    );
    const data = await geoRes.json();
    const coords = data && data.length > 0
      ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
      : null;
    return Response.json({ coords });
  } catch (e) {
    return Response.json({ coords: null, error: String(e) });
  }
}
