require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3100);

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || 'CitySaarthi';
const LIVE_COLLECTION = process.env.MONGO_COLLECTION_LIVE || 'live_tracking';
const ROUTES_COLLECTION = process.env.MONGO_COLLECTION_ROUTES || 'routes';
const STOPS_COLLECTION = process.env.MONGO_COLLECTION_STOPS || 'stops';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!MONGO_URI) {
	console.error('MONGO_URI is missing. Create Server1/.env from Server1/.env.example');
	process.exit(1);
}

const mongoClient = new MongoClient(MONGO_URI);
const PASSENGER_ROOT = path.join(__dirname, '..', 'Passenger');

let mongoOnline = false;
let mongoError = null;
let cache = {
	expiresAt: 0,
	payload: null,
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
	return {
		route_id: toTitle(route.route_id || route._id),
		route_short_name: toTitle(route.route_short_name),
		route_long_name: toTitle(route.route_long_name),
		route_label: asRouteLabel(route),
	};
}

function normalizeStopDoc(stop) {
	return {
		stop_id: toTitle(stop.stop_id || stop._id),
		stop_name: toTitle(stop.stop_name),
		stop_lat: numberOrNull(stop.stop_lat),
		stop_lon: numberOrNull(stop.stop_lon),
		route_id: toTitle(stop.route_id),
	};
}

function normalizeLiveDoc(live) {
	const coordinates =
		live && live.location && Array.isArray(live.location.coordinates)
			? live.location.coordinates
			: [];

	const lng = numberOrNull(coordinates[0]);
	const lat = numberOrNull(coordinates[1]);

	return {
		bus_id: toTitle(live.bus_id),
		route: toTitle(live.route),
		route_id: toTitle(live.route_id),
		current_stop: toTitle(live.current_stop),
		next_stop: toTitle(live.next_stop),
		lat,
		lng,
		speed: numberOrNull(live.speed) || 0,
		last_ping: live.last_ping || null,
	};
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
	const now = Date.now();
	if (cache.payload && now < cache.expiresAt) {
		return cache.payload;
	}

	const routesRaw = await db()
		.collection(ROUTES_COLLECTION)
		.find({}, { projection: { _id: 0, route_id: 1, route_short_name: 1, route_long_name: 1 } })
		.limit(5000)
		.toArray();

	const stopsRaw = await db()
		.collection(STOPS_COLLECTION)
		.find({}, { projection: { _id: 0, stop_id: 1, stop_name: 1, stop_lat: 1, stop_lon: 1, route_id: 1 } })
		.limit(12000)
		.toArray();

	const busesRaw = await db()
		.collection(LIVE_COLLECTION)
		.aggregate([
			{ $match: { bus_id: { $type: 'string', $ne: '' } } },
			{ $sort: { last_ping: -1 } },
			{
				$group: {
					_id: '$bus_id',
					route: { $first: '$route' },
					route_id: { $first: '$route_id' },
					last_ping: { $first: '$last_ping' },
				},
			},
			{ $project: { _id: 0, bus_id: '$_id', route: 1, route_id: 1, last_ping: 1 } },
			{ $limit: 3000 },
		])
		.toArray();

	const routes = routesRaw.map(normalizeRouteDoc).sort((a, b) => a.route_label.localeCompare(b.route_label));
	const stops = stopsRaw
		.map(normalizeStopDoc)
		.filter((s) => s.stop_name)
		.sort((a, b) => a.stop_name.localeCompare(b.stop_name));
	const buses = busesRaw
		.map((b) => ({
			bus_id: toTitle(b.bus_id),
			route: toTitle(b.route),
			route_id: toTitle(b.route_id),
			last_ping: b.last_ping || null,
		}))
		.filter((b) => b.bus_id)
		.sort((a, b) => a.bus_id.localeCompare(b.bus_id));

	const payload = {
		routes,
		stops,
		buses,
		updated_at: new Date().toISOString(),
	};

	cache = {
		payload,
		expiresAt: now + 20_000,
	};

	return payload;
}

async function findBusLive(busId) {
	const raw = await db()
		.collection(LIVE_COLLECTION)
		.findOne({ bus_id: String(busId) }, { sort: { last_ping: -1 } });

	if (!raw) return null;
	const normalized = normalizeLiveDoc(raw);
	if (normalized.lat == null || normalized.lng == null) return null;
	return normalized;
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

	const send = async () => {
		try {
			const busLive = await findBusLive(busId);
			const packet = busLive
				? { ok: true, data: busLive, timestamp: new Date().toISOString() }
				: { ok: false, error: 'Bus location not found', timestamp: new Date().toISOString() };

			res.write(`data: ${JSON.stringify(packet)}\n\n`);
		} catch (error) {
			res.write(`data: ${JSON.stringify({ ok: false, error: 'Tracking fetch failed' })}\n\n`);
		}
	};

	await send();
	const timer = setInterval(send, 2000);

	req.on('close', () => {
		clearInterval(timer);
		res.end();
	});
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
