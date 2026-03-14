require('dotenv').config({ override: true });
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_NAME = process.env.MONGO_DB_NAME || 'CitySaarthi';
const LIVE_COLLECTION = process.env.MONGO_COLLECTION_NAME || 'live_tracking';

let stopsCache = {
    expiresAt: 0,
    value: null,
};

if (!process.env.MONGO_URI) {
    console.error('Missing MONGO_URI in .env');
    process.exit(1);
}

const client = new MongoClient(process.env.MONGO_URI);

app.use(cors());
app.use(express.json());

app.get('/api/bus-location', async (req, res) => {
    try {
        const { bus_id } = req.query;
        if (!bus_id) {
            return res.status(400).json({ error: 'bus_id required' });
        }

        const database = client.db(DB_NAME);
        const liveTracking = database.collection(LIVE_COLLECTION);

        // Find the most recent record for this bus.
        const data = await liveTracking.findOne(
            { bus_id: String(bus_id) },
            { sort: { last_ping: -1 } }
        );

        if (!data || !data.location || !Array.isArray(data.location.coordinates)) {
            return res.status(404).json({ error: 'Bus not broadcasting' });
        }

        // Convert GeoJSON [lng, lat] from Atlas into map-friendly [lat, lng].
        res.json({
            bus_id: data.bus_id,
            route: data.route,
            lat: data.location.coordinates[1],
            lng: data.location.coordinates[0],
            speed: data.speed || 0,
            last_ping: data.last_ping || null
        });

        console.log(`[SYNC] Update sent for ${bus_id} at ${new Date().toLocaleTimeString()}`);
    } catch (e) {
        console.error('API Error:', e);
        res.status(500).json({ error: 'Internal Engine Error' });
    }
});

function makeSyntheticStopId(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown-stop';
}

async function buildStopsSnapshot() {
    const database = client.db(DB_NAME);
    const stopsCollection = database.collection('stops');
    const liveCollection = database.collection(LIVE_COLLECTION);

    // 1) Preferred source: dedicated stops collection
    const rawStops = await stopsCollection
        .find(
            { stop_name: { $type: 'string', $ne: '' } },
            { projection: { _id: 0, stop_id: 1, stop_name: 1, stop_lat: 1, stop_lon: 1 } }
        )
        .limit(8000)
        .toArray();

    const stopNameToIds = {};
    const stopRecords = [];

    if (rawStops.length) {
        for (const stop of rawStops) {
            const name = String(stop.stop_name || '').trim();
            if (!name) continue;
            const id = String(stop.stop_id || makeSyntheticStopId(name));
            if (!stopNameToIds[name]) stopNameToIds[name] = [];
            if (!stopNameToIds[name].includes(id)) stopNameToIds[name].push(id);

            const lat = Number(stop.stop_lat);
            const lon = Number(stop.stop_lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                stopRecords.push({
                    stop_id: id,
                    stop_name: name,
                    stop_lat: lat,
                    stop_lon: lon,
                });
            }
        }
    } else {
        // 2) Fallback source: infer stop names from live tracking fields
        const docs = await liveCollection
            .find(
                {},
                { projection: { _id: 0, route: 1, current_stop: 1, next_stop: 1, start_stop: 1, end_stop: 1 } }
            )
            .limit(3000)
            .toArray();

        const names = new Set();
        for (const doc of docs) {
            [doc.current_stop, doc.next_stop, doc.start_stop, doc.end_stop].forEach((value) => {
                const text = String(value || '').trim();
                if (text) names.add(text);
            });
        }

        for (const name of names) {
            const id = makeSyntheticStopId(name);
            stopNameToIds[name] = [id];
        }
    }

    const stopNames = Object.keys(stopNameToIds).sort((a, b) => a.localeCompare(b));
    return { stop_names: stopNames, stop_name_to_ids: stopNameToIds, stop_records: stopRecords };
}

async function getStopsSnapshot() {
    const now = Date.now();
    if (stopsCache.value && now < stopsCache.expiresAt) {
        return stopsCache.value;
    }

    const snapshot = await buildStopsSnapshot();
    stopsCache = {
        value: snapshot,
        expiresAt: now + 30_000,
    };
    return snapshot;
}

app.get('/api/stops', async (_req, res) => {
    try {
        const data = await getStopsSnapshot();
        res.status(200).json({
            stop_names: data.stop_names,
            stop_name_to_ids: data.stop_name_to_ids,
        });
    } catch (e) {
        console.error('Stops API Error:', e);
        res.status(500).json({ error: 'Unable to load stop suggestions' });
    }
});

app.get('/api/nearest-stop', async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lon = Number(req.query.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return res.status(400).json({ error: 'lat and lon are required' });
        }

        const snapshot = await getStopsSnapshot();
        if (!snapshot.stop_records.length) {
            return res.status(200).json({
                stop_name: 'Nearby Stop',
                stop_ids: ['nearby-stop'],
                stop_id: 'nearby-stop',
                stop_lat: lat,
                stop_lon: lon,
                distance_m: 0,
            });
        }

        let nearest = null;
        let nearestDistSq = Number.POSITIVE_INFINITY;
        for (const stop of snapshot.stop_records) {
            const dLat = stop.stop_lat - lat;
            const dLon = stop.stop_lon - lon;
            const distSq = (dLat * dLat) + (dLon * dLon);
            if (distSq < nearestDistSq) {
                nearestDistSq = distSq;
                nearest = stop;
            }
        }

        const distanceM = Math.round(Math.sqrt(nearestDistSq) * 111000);
        res.status(200).json({
            stop_name: nearest.stop_name,
            stop_ids: [nearest.stop_id],
            stop_id: nearest.stop_id,
            stop_lat: nearest.stop_lat,
            stop_lon: nearest.stop_lon,
            distance_m: distanceM,
        });
    } catch (e) {
        console.error('Nearest Stop API Error:', e);
        res.status(500).json({ error: 'Unable to find nearest stop' });
    }
});

app.get('/api/bus-suggestions', async (_req, res) => {
    try {
        const database = client.db(DB_NAME);
        const liveTracking = database.collection(LIVE_COLLECTION);

        const buses = await liveTracking.distinct('bus_id', { bus_id: { $type: 'string', $ne: '' } });
        const routes = await liveTracking.distinct('route', { route: { $type: 'string', $ne: '' } });

        res.status(200).json({
            bus_ids: buses.map((v) => String(v).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)),
            routes: routes.map((v) => String(v).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)),
        });
    } catch (e) {
        console.error('Bus Suggestions API Error:', e);
        res.status(500).json({ error: 'Unable to load bus suggestions' });
    }
});

app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'pmpml-live-engine' });
});

app.listen(PORT, async () => {
    try {
        await client.connect();
        console.log('-----------------------------------------');
        console.log(`ENGINE ACTIVE: http://localhost:${PORT}`);
        console.log('ATLAS CONNECTED: Keys loaded via .env');
        console.log('-----------------------------------------');
    } catch (err) {
        console.error('Connection Failed. Are you on a Hotspot?');
        console.error(err);
        process.exit(1);
    }
});
