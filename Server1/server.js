require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3100);

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || 'CitySaarthi';
const LIVE_COLLECTION = process.env.MONGO_COLLECTION_LIVE || 'live_tracking';
const ROUTES_COLLECTION = process.env.MONGO_COLLECTION_ROUTES || 'routes';
const STOPS_COLLECTION = process.env.MONGO_COLLECTION_STOPS || 'stops';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const GTFS_STOPS_PATH = path.join(__dirname, '..', 'gtfs_data', 'stops.txt');
const GTFS_ROUTES_PATH = path.join(__dirname, '..', 'gtfs_data', 'routes.txt');
const GTFS_TRIPS_PATH = path.join(__dirname, '..', 'gtfs_data', 'trips.txt');
const GTFS_STOP_TIMES_PATH = path.join(__dirname, '..', 'gtfs_data', 'stop_times.txt');

if (!MONGO_URI) {
	console.error('MONGO_URI is missing. Create Server1/.env from Server1/.env.example');
	process.exit(1);
}

const mongoClient = new MongoClient(MONGO_URI);
const PASSENGER_ROOT = path.join(__dirname, '..', 'Passenger');

let mongoOnline = false;
let mongoError = null;
let routePathCache = {
	expiresAt: 0,
	index: null,
};

app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN }));
app.use(express.json());
app.use(express.static(PASSENGER_ROOT));

function toTitle(value) {
	return String(value || '').trim();
}

function numberOrNull(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function asRouteLabel(route) {
	const shortName = toTitle(route.route_short_name || route.route_id);
	const longName = toTitle(route.route_long_name);
	if (shortName && longName) return `${shortName} | ${longName}`;
	if (shortName) return shortName;
	return longName || 'Unknown Route';
}

function normalizeRouteDoc(route) {
	const routeId = toTitle(route.route_id || route.routeId || route.code || route.route_no || route._id);
	const shortName = toTitle(route.route_short_name || route.routeShortName || route.short_name || route.shortName || route.route_name || route.routeName || route.name || routeId);
	const longName = toTitle(route.route_long_name || route.routeLongName || route.long_name || route.longName || route.description || '');

	return {
		route_id: routeId,
		route_short_name: shortName,
		route_long_name: longName,
		route_label: asRouteLabel({ route_id: routeId, route_short_name: shortName, route_long_name: longName }),
	};
}

function normalizeStopDoc(stop) {
	return {
		stop_id: toTitle(stop.stop_id || stop.stopId || stop.id || stop._id),
		stop_name: toTitle(stop.stop_name || stop.stopName || stop.name),
		stop_lat: numberOrNull(stop.stop_lat ?? stop.stopLat ?? stop.lat ?? stop.latitude),
		stop_lon: numberOrNull(stop.stop_lon ?? stop.stopLon ?? stop.lon ?? stop.lng ?? stop.longitude),
		route_id: toTitle(stop.route_id || stop.routeId || stop.route),
	};
}

function normalizeLiveDoc(live) {
	// Strategy 1: GeoJSON location.coordinates [lng, lat]
	let lat = null;
	let lng = null;

	if (live && live.location && Array.isArray(live.location.coordinates) && live.location.coordinates.length >= 2) {
		lng = numberOrNull(live.location.coordinates[0]);
		lat = numberOrNull(live.location.coordinates[1]);
	}

	// Strategy 2: top-level lat/lng or latitude/longitude fields
	if (lat == null || lng == null) {
		const rawLat = live.lat ?? live.latitude ?? live.Lat ?? null;
		const rawLng = live.lng ?? live.lon ?? live.longitude ?? live.Lng ?? null;
		if (rawLat != null && rawLng != null) {
			lat = numberOrNull(rawLat);
			lng = numberOrNull(rawLng);
		}
	}

	// Normalize timestamp: try last_ping, timestamp, updatedAt, updated_at
	const lastPing = live.last_ping ?? live.timestamp ?? live.updatedAt ?? live.updated_at ?? null;

	// Normalize speed: try speed, Speed, velocity
	const speed = numberOrNull(live.speed ?? live.Speed ?? live.velocity) || 0;

	return {
		bus_id: toTitle(live.bus_id || live.busId || live.bus_no || live.busNo || live.vehicle_no || live.vehicleNo || live.bus || live.id),
		route: toTitle(live.route || live.route_name || live.routeName || live.line || live.line_name),
		route_id: toTitle(live.route_id || live.routeId || live.route || live.route_name || live.routeName),
		current_stop: toTitle(live.current_stop),
		next_stop: toTitle(live.next_stop),
		lat,
		lng,
		speed,
		last_ping: lastPing,
	};
}

function parseCsvLine(line) {
	const values = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		const next = line[i + 1];

		if (ch === '"') {
			if (inQuotes && next === '"') {
				current += '"';
				i += 1;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}

		if (ch === ',' && !inQuotes) {
			values.push(current);
			current = '';
			continue;
		}

		current += ch;
	}

	values.push(current);
	return values;
}

function normalizeKey(value) {
	return String(value || '')
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ');
}

function extractRouteShortName(value) {
	const raw = toTitle(value);
	if (!raw) return '';
	if (!raw.includes('|')) return raw;
	return raw.split('|')[0].trim();
}

function loadGtfsRoutesFallback() {
	try {
		const raw = fs.readFileSync(GTFS_ROUTES_PATH, 'utf8');
		const lines = raw.split(/\r?\n/).filter(Boolean);
		if (lines.length <= 1) return [];

		const headers = parseCsvLine(lines[0]);
		const routeIdIdx = headers.indexOf('route_id');
		const shortIdx = headers.indexOf('route_short_name');
		const longIdx = headers.indexOf('route_long_name');

		const seen = new Set();
		const routes = [];

		for (const line of lines.slice(1)) {
			const cols = parseCsvLine(line);
			const routeId = toTitle(cols[routeIdIdx]);
			const shortName = toTitle(cols[shortIdx]);
			const longName = toTitle(cols[longIdx]);
			const key = `${shortName}__${longName}`;
			if (!shortName || seen.has(key)) continue;
			seen.add(key);

			routes.push({
				route_id: routeId || shortName,
				route_short_name: shortName,
				route_long_name: longName,
				route_label: longName ? `${shortName} | ${longName}` : shortName,
			});
		}

		return routes.sort((a, b) => a.route_label.localeCompare(b.route_label));
	} catch (_err) {
		return [];
	}
}

function loadGtfsStopsFallback() {
	try {
		const raw = fs.readFileSync(GTFS_STOPS_PATH, 'utf8');
		const lines = raw.split(/\r?\n/).filter(Boolean);
		if (lines.length <= 1) return [];

		const headers = parseCsvLine(lines[0]);
		const idIdx = headers.indexOf('stop_id');
		const nameIdx = headers.indexOf('stop_name');
		const latIdx = headers.indexOf('stop_lat');
		const lonIdx = headers.indexOf('stop_lon');

		return lines
			.slice(1)
			.map((line) => {
				const cols = parseCsvLine(line);
				return {
					stop_id: toTitle(cols[idIdx]),
					stop_name: toTitle(cols[nameIdx]),
					stop_lat: numberOrNull(cols[latIdx]),
					stop_lon: numberOrNull(cols[lonIdx]),
					route_id: '',
				};
			})
			.filter((s) => s.stop_id && s.stop_name)
			.sort((a, b) => a.stop_name.localeCompare(b.stop_name));
	} catch (_err) {
		return [];
	}
}

function buildGtfsRoutePathIndex() {
	try {
		const routesRaw = fs.readFileSync(GTFS_ROUTES_PATH, 'utf8');
		const tripsRaw = fs.readFileSync(GTFS_TRIPS_PATH, 'utf8');
		const stopTimesRaw = fs.readFileSync(GTFS_STOP_TIMES_PATH, 'utf8');
		const stopsRaw = fs.readFileSync(GTFS_STOPS_PATH, 'utf8');

		const routeLines = routesRaw.split(/\r?\n/).filter(Boolean);
		const tripLines = tripsRaw.split(/\r?\n/).filter(Boolean);
		const stopTimeLines = stopTimesRaw.split(/\r?\n/).filter(Boolean);
		const stopLines = stopsRaw.split(/\r?\n/).filter(Boolean);

		if (routeLines.length <= 1 || tripLines.length <= 1 || stopTimeLines.length <= 1 || stopLines.length <= 1) {
			return new Map();
		}

		const routeHeaders = parseCsvLine(routeLines[0]);
		const routeIdIdx = routeHeaders.indexOf('route_id');
		const routeShortIdx = routeHeaders.indexOf('route_short_name');
		const routeLongIdx = routeHeaders.indexOf('route_long_name');

		const routesById = new Map();
		for (const line of routeLines.slice(1)) {
			const cols = parseCsvLine(line);
			const routeId = toTitle(cols[routeIdIdx]);
			if (!routeId) continue;
			routesById.set(routeId, {
				route_id: routeId,
				route_short_name: toTitle(cols[routeShortIdx]),
				route_long_name: toTitle(cols[routeLongIdx]),
			});
		}

		const stopHeaders = parseCsvLine(stopLines[0]);
		const stopIdIdx = stopHeaders.indexOf('stop_id');
		const stopNameIdx = stopHeaders.indexOf('stop_name');
		const stopLatIdx = stopHeaders.indexOf('stop_lat');
		const stopLonIdx = stopHeaders.indexOf('stop_lon');

		const stopsById = new Map();
		for (const line of stopLines.slice(1)) {
			const cols = parseCsvLine(line);
			const stopId = toTitle(cols[stopIdIdx]);
			if (!stopId) continue;
			const lat = numberOrNull(cols[stopLatIdx]);
			const lng = numberOrNull(cols[stopLonIdx]);
			if (lat == null || lng == null) continue;
			stopsById.set(stopId, {
				stop_id: stopId,
				stop_name: toTitle(cols[stopNameIdx]),
				lat,
				lng,
			});
		}

		const tripHeaders = parseCsvLine(tripLines[0]);
		const tripIdIdx = tripHeaders.indexOf('trip_id');
		const tripRouteIdIdx = tripHeaders.indexOf('route_id');

		const tripsByRouteId = new Map();
		for (const line of tripLines.slice(1)) {
			const cols = parseCsvLine(line);
			const routeId = toTitle(cols[tripRouteIdIdx]);
			const tripId = toTitle(cols[tripIdIdx]);
			if (!routeId || !tripId) continue;
			if (!tripsByRouteId.has(routeId)) tripsByRouteId.set(routeId, []);
			tripsByRouteId.get(routeId).push(tripId);
		}

		const stopTimeHeaders = parseCsvLine(stopTimeLines[0]);
		const stopTimeTripIdIdx = stopTimeHeaders.indexOf('trip_id');
		const stopTimeStopIdIdx = stopTimeHeaders.indexOf('stop_id');
		const stopSeqIdx = stopTimeHeaders.indexOf('stop_sequence');

		const pointsByTripId = new Map();
		for (const line of stopTimeLines.slice(1)) {
			const cols = parseCsvLine(line);
			const tripId = toTitle(cols[stopTimeTripIdIdx]);
			const stopId = toTitle(cols[stopTimeStopIdIdx]);
			const seq = Number(cols[stopSeqIdx]);
			if (!tripId || !stopId || !Number.isFinite(seq)) continue;
			const stop = stopsById.get(stopId);
			if (!stop) continue;
			if (!pointsByTripId.has(tripId)) pointsByTripId.set(tripId, []);
			pointsByTripId.get(tripId).push({
				seq,
				lat: stop.lat,
				lng: stop.lng,
				stop_id: stop.stop_id,
				stop_name: stop.stop_name,
			});
		}

		const index = new Map();
		for (const [routeId, tripIds] of tripsByRouteId.entries()) {
			let best = [];
			for (const tripId of tripIds) {
				const points = pointsByTripId.get(tripId) || [];
				if (points.length > best.length) best = points;
			}
			if (best.length < 2) continue;

			const ordered = [...best].sort((a, b) => a.seq - b.seq);
			const routeMeta = routesById.get(routeId) || { route_id: routeId, route_short_name: '', route_long_name: '' };
			const label = asRouteLabel(routeMeta);

			const payload = {
				route_id: routeMeta.route_id,
				route_short_name: routeMeta.route_short_name,
				route_long_name: routeMeta.route_long_name,
				route_label: label,
				points: ordered,
			};

			index.set(normalizeKey(routeMeta.route_id), payload);
			if (routeMeta.route_short_name) index.set(normalizeKey(routeMeta.route_short_name), payload);
			if (label) index.set(normalizeKey(label), payload);
		}

		return index;
	} catch (_err) {
		return new Map();
	}
}

function getRoutePathIndex() {
	const now = Date.now();
	if (routePathCache.index && now < routePathCache.expiresAt) {
		return routePathCache.index;
	}

	const index = buildGtfsRoutePathIndex();
	routePathCache = {
		index,
		expiresAt: now + 10 * 60 * 1000,
	};

	return index;
}

function resolveRoutePath(index, routeInput) {
	const exact = index.get(normalizeKey(routeInput));
	if (exact) return exact;

	const shortName = extractRouteShortName(routeInput);
	const normalizedShort = normalizeKey(shortName);
	const normalizedInput = normalizeKey(routeInput);
	const longPart = routeInput.includes('|') ? normalizeKey(routeInput.split('|').slice(1).join('|')) : '';

	const uniqueByRouteId = new Map();
	for (const value of index.values()) {
		if (value && value.route_id && !uniqueByRouteId.has(value.route_id)) {
			uniqueByRouteId.set(value.route_id, value);
		}
	}

	const candidates = Array.from(uniqueByRouteId.values()).filter((item) => {
		const short = normalizeKey(item.route_short_name);
		const label = normalizeKey(item.route_label);
		const routeId = normalizeKey(item.route_id);
		return short === normalizedShort || label.includes(normalizedShort) || routeId === normalizedShort;
	});

	if (!candidates.length) return null;
	if (!longPart) return candidates[0];

	let best = candidates[0];
	let bestScore = -1;
	const wantedTokens = longPart.split(' ').filter(Boolean);

	for (const item of candidates) {
		const label = normalizeKey(item.route_label);
		let score = 0;
		if (label === normalizedInput) score += 100;
		if (label.includes(longPart)) score += 50;
		for (const token of wantedTokens) {
			if (label.includes(token)) score += 1;
		}
		if (score > bestScore) {
			bestScore = score;
			best = item;
		}
	}

	return best;
}

function uniqueRoutePathEntries(index) {
	const byRouteId = new Map();
	for (const value of index.values()) {
		if (!value || !value.route_id) continue;
		if (!byRouteId.has(value.route_id)) {
			byRouteId.set(value.route_id, value);
		}
	}
	return Array.from(byRouteId.values());
}

async function connectMongo() {
	try {
		await mongoClient.connect();
		mongoOnline = true;
		mongoError = null;
		console.log(`MongoDB connected: ${DB_NAME}`);
	} catch (error) {
		mongoOnline = false;
		mongoError = error;
		console.error('MongoDB connection failed:', error.message);
	}
}

function db() {
	return mongoClient.db(DB_NAME);
}

async function getSelectorData() {
	const routesRaw = await db()
		.collection(ROUTES_COLLECTION)
		.find({}, { projection: { _id: 0 } })
		.limit(5000)
		.toArray();

	const stopsRaw = await db()
		.collection(STOPS_COLLECTION)
		.find({}, { projection: { _id: 0 } })
		.limit(12000)
		.toArray();

	const liveRaw = await db()
		.collection(LIVE_COLLECTION)
		.find({}, { projection: { _id: 0 } })
		.sort({ _id: -1 })
		.limit(8000)
		.toArray();

	const routes = routesRaw.map(normalizeRouteDoc).sort((a, b) => a.route_label.localeCompare(b.route_label));
	let stops = stopsRaw
		.map(normalizeStopDoc)
		.filter((s) => s.stop_name)
		.sort((a, b) => a.stop_name.localeCompare(b.stop_name));
	let resolvedRoutes = routes;

	const busesById = new Map();
	for (const raw of liveRaw) {
		const normalized = normalizeLiveDoc(raw);
		if (!normalized.bus_id) continue;
		if (!busesById.has(normalized.bus_id)) {
			busesById.set(normalized.bus_id, {
				bus_id: normalized.bus_id,
				route: normalized.route,
				route_id: normalized.route_id || normalized.route,
				last_ping: normalized.last_ping || null,
			});
		}
	}

	const buses = Array.from(busesById.values()).sort((a, b) => a.bus_id.localeCompare(b.bus_id));

	if (!resolvedRoutes.length) {
		const liveRoutes = buses
			.filter((b) => b.route)
			.map((b) => ({
				route_id: b.route_id || b.route,
				route_short_name: b.route,
				route_long_name: '',
				route_label: b.route,
			}));

		const dedup = new Map();
		for (const route of liveRoutes) {
			dedup.set(route.route_label, route);
		}
		resolvedRoutes = Array.from(dedup.values()).sort((a, b) => a.route_label.localeCompare(b.route_label));
	}

	if (!resolvedRoutes.length) {
		resolvedRoutes = loadGtfsRoutesFallback();
	}

	if (!stops.length) {
		stops = loadGtfsStopsFallback();
	}

	const payload = {
		routes: resolvedRoutes,
		stops,
		buses,
		updated_at: new Date().toISOString(),
	};

	return payload;
}

async function findBusLive(busId) {
	// Try sort by last_ping desc; also try _id desc as fallback for newer inserts
	const candidates = await db()
		.collection(LIVE_COLLECTION)
		.find({ bus_id: String(busId) })
		.sort({ _id: -1 })
		.limit(3)
		.toArray();

	if (!candidates.length) return null;

	for (const raw of candidates) {
		const normalized = normalizeLiveDoc(raw);
		if (normalized.lat != null && normalized.lng != null) return normalized;
	}

	return null;
}

app.get('/health', (_req, res) => {
	res.status(200).json({
		service: 'Server1 Passenger Tracker',
		status: mongoOnline ? 'ok' : 'degraded',
		mongo: mongoOnline ? 'connected' : 'offline',
		error: mongoError ? mongoError.message : null,
		timestamp: new Date().toISOString(),
	});
});

app.get('/api/selector-data', async (_req, res) => {
	try {
		if (!mongoOnline) {
			return res.status(503).json({ error: 'MongoDB is offline', routes: [], stops: [], buses: [] });
		}
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
		const payload = await getSelectorData();
		return res.status(200).json(payload);
	} catch (error) {
		console.error('selector-data error:', error);
		return res.status(500).json({ error: 'Unable to load selector data', routes: [], stops: [], buses: [] });
	}
});

app.get('/api/track', async (req, res) => {
	try {
		if (!mongoOnline) {
			return res.status(503).json({ error: 'MongoDB is offline' });
		}

		const busId = String(req.query.bus_id || '').trim();
		if (!busId) {
			return res.status(400).json({ error: 'bus_id is required' });
		}

		const busLive = await findBusLive(busId);
		if (!busLive) {
			return res.status(404).json({ error: 'Bus location not found' });
		}

		return res.status(200).json(busLive);
	} catch (error) {
		console.error('track error:', error);
		return res.status(500).json({ error: 'Unable to fetch bus tracking data' });
	}
});

app.get('/api/track/stream', async (req, res) => {
	if (!mongoOnline) {
		return res.status(503).json({ error: 'MongoDB is offline' });
	}

	const busId = String(req.query.bus_id || '').trim();
	if (!busId) {
		return res.status(400).json({ error: 'bus_id is required' });
	}

	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');

	const writePacket = (busLive) => {
		const packet = busLive
			? { ok: true, data: busLive, timestamp: new Date().toISOString() }
			: { ok: false, error: 'Bus location not found', timestamp: new Date().toISOString() };
		try { res.write(`data: ${JSON.stringify(packet)}\n\n`); } catch (_err) {}
	};

	const poll = async () => {
		try {
			const busLive = await findBusLive(busId);
			writePacket(busLive);
		} catch (_err) {
			try { res.write(`data: ${JSON.stringify({ ok: false, error: 'Tracking fetch failed' })}\n\n`); } catch (_e) {}
		}
	};

	// Always send initial state immediately
	await poll();

	// Try MongoDB Change Stream for instant push on every driver write
	let changeStream = null;
	let pollTimer = null;

	try {
		const pipeline = [{ $match: { 'fullDocument.bus_id': busId } }];
		changeStream = db().collection(LIVE_COLLECTION).watch(pipeline, { fullDocument: 'updateLookup' });

		changeStream.on('change', (change) => {
			const doc = change.fullDocument;
			if (!doc) return;
			const normalized = normalizeLiveDoc(doc);
			if (normalized.lat != null) writePacket(normalized);
		});

		changeStream.on('error', () => {
			// Change stream failed - fall back to polling
			if (changeStream) { try { changeStream.close(); } catch (_e) {} changeStream = null; }
			if (!pollTimer) pollTimer = setInterval(poll, 2000);
		});
	} catch (_err) {
		// Change stream unavailable - use polling only
		pollTimer = setInterval(poll, 2000);
	}

	// Also always poll every 2s as safety net alongside change stream
	pollTimer = setInterval(poll, 2000);

	req.on('close', () => {
		if (changeStream) { try { changeStream.close(); } catch (_e) {} }
		if (pollTimer) clearInterval(pollTimer);
		res.end();
	});
});

app.get('/api/route-path', (req, res) => {
	try {
		const routeInput = toTitle(req.query.route || req.query.route_id);
		if (!routeInput) {
			return res.status(400).json({ error: 'route is required' });
		}

		const index = getRoutePathIndex();
		if (!index.size) {
			return res.status(404).json({ error: 'Route path data unavailable' });
		}

		const resolved = resolveRoutePath(index, routeInput);

		if (!resolved) {
			return res.status(404).json({ error: 'Route path not found' });
		}

		return res.status(200).json({
			route: routeInput,
			route_id: resolved.route_id,
			route_label: resolved.route_label,
			points: resolved.points,
			updated_at: new Date().toISOString(),
		});
	} catch (error) {
		console.error('route-path error:', error);
		return res.status(500).json({ error: 'Unable to load route path' });
	}
});

app.get('/api/stop-routes', async (req, res) => {
	try {
		const stopIdInput = toTitle(req.query.stop_id);
		const stopNameInput = toTitle(req.query.stop_name);
		if (!stopIdInput && !stopNameInput) {
			return res.status(400).json({ error: 'stop_id or stop_name is required' });
		}

		const targetStopId = normalizeKey(stopIdInput);
		const targetStopName = normalizeKey(stopNameInput);

		const index = getRoutePathIndex();
		const uniqueRoutes = uniqueRoutePathEntries(index);
		const matchedRoutes = [];

		for (const route of uniqueRoutes) {
			const points = Array.isArray(route.points) ? route.points : [];
			const hit = points.find((p) => {
				const pid = normalizeKey(p.stop_id);
				const pname = normalizeKey(p.stop_name);
				const idMatch = targetStopId && pid && targetStopId === pid;
				const nameMatch = targetStopName && pname && (targetStopName === pname || pname.includes(targetStopName));
				return idMatch || nameMatch;
			});
			if (hit) {
				matchedRoutes.push({
					route_id: route.route_id,
					route_label: route.route_label || route.route_id,
					route_short_name: route.route_short_name || '',
					route_long_name: route.route_long_name || '',
					matched_stop_id: hit.stop_id || '',
					matched_stop_name: hit.stop_name || '',
				});
			}
		}

		const routeKeys = new Set(matchedRoutes.map((r) => normalizeKey(r.route_id || r.route_label)).filter(Boolean));
		let buses = [];

		if (mongoOnline && routeKeys.size) {
			const liveRaw = await db()
				.collection(LIVE_COLLECTION)
				.find({}, { projection: { _id: 0 } })
				.sort({ _id: -1 })
				.limit(8000)
				.toArray();

			const busesById = new Map();
			for (const raw of liveRaw) {
				const normalized = normalizeLiveDoc(raw);
				if (!normalized.bus_id) continue;
				const liveRouteKey = normalizeKey(normalized.route_id || normalized.route);
				if (!liveRouteKey || !Array.from(routeKeys).some((rk) => rk === liveRouteKey || rk.includes(liveRouteKey) || liveRouteKey.includes(rk))) continue;
				if (!busesById.has(normalized.bus_id)) {
					busesById.set(normalized.bus_id, {
						bus_id: normalized.bus_id,
						route: normalized.route,
						route_id: normalized.route_id || normalized.route,
						last_ping: normalized.last_ping || null,
					});
				}
			}
			buses = Array.from(busesById.values()).sort((a, b) => a.bus_id.localeCompare(b.bus_id));
		}

		return res.status(200).json({
			stop_id: stopIdInput || null,
			stop_name: stopNameInput || null,
			routes: matchedRoutes,
			buses,
			updated_at: new Date().toISOString(),
		});
	} catch (error) {
		console.error('stop-routes error:', error);
		return res.status(500).json({ error: 'Unable to resolve routes for selected stop', routes: [], buses: [] });
	}
});

app.post('/api/bus-location', async (req, res) => {
	try {
		if (!mongoOnline) {
			return res.status(503).json({ error: 'MongoDB is offline' });
		}
		const { bus_id, latitude, longitude, timestamp } = req.body || {};
		if (!bus_id || latitude == null || longitude == null) {
			return res.status(400).json({ error: 'bus_id, latitude, and longitude are required' });
		}
		const lat = parseFloat(latitude);
		const lng = parseFloat(longitude);
		if (isNaN(lat) || isNaN(lng)) {
			return res.status(400).json({ error: 'Invalid latitude or longitude' });
		}
		const liveCol = db.collection(LIVE_COLLECTION);
		await liveCol.updateOne(
			{ bus_id: String(bus_id) },
			{
				$set: {
					bus_id: String(bus_id),
					lat,
					lng,
					timestamp: timestamp || new Date().toISOString(),
					updatedAt: new Date(),
				},
			},
			{ upsert: true }
		);
		return res.status(200).json({ ok: true });
	} catch (error) {
		console.error('POST bus-location error:', error);
		return res.status(500).json({ error: 'Unable to update bus location' });
	}
});

app.get('/', (_req, res) => {
	res.sendFile(path.join(PASSENGER_ROOT, 'home.html'));
});

process.on('SIGINT', async () => {
	try {
		await mongoClient.close();
	} finally {
		process.exit(0);
	}
});

app.listen(PORT, async () => {
	await connectMongo();
	console.log(`Server1 listening on http://localhost:${PORT}`);
});
