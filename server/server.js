require('dotenv').config({ override: true });
const express = require('express');
const fs = require('fs');
const path = require('path');
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

let mongoReady = false;
let mongoStartupError = null;

const GTFS_STOPS_PATH = path.join(__dirname, '..', 'gtfs_data', 'stops.txt');

if (!process.env.MONGO_URI) {
    console.error('Missing MONGO_URI in .env');
    process.exit(1);
}

const client = new MongoClient(process.env.MONGO_URI);

app.use(cors());
app.use(express.json());

function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const nextChar = line[index + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            values.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    values.push(current);
    return values;
}

function buildLocalStopsSnapshot() {
    try {
        const raw = fs.readFileSync(GTFS_STOPS_PATH, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        if (lines.length <= 1) {
            return { stop_names: [], stop_name_to_ids: {}, stop_records: [] };
        }

        const headers = parseCsvLine(lines[0]);
        const stopIdIndex = headers.indexOf('stop_id');
        const stopNameIndex = headers.indexOf('stop_name');
        const stopLatIndex = headers.indexOf('stop_lat');
        const stopLonIndex = headers.indexOf('stop_lon');

        const stopNameToIds = {};
        const stopRecords = [];

        for (const line of lines.slice(1)) {
            const cols = parseCsvLine(line);
            const stopName = String(cols[stopNameIndex] || '').trim();
            const stopId = String(cols[stopIdIndex] || '').trim();
            const stopLat = Number(cols[stopLatIndex]);
            const stopLon = Number(cols[stopLonIndex]);
            if (!stopName || !stopId || !Number.isFinite(stopLat) || !Number.isFinite(stopLon)) {
                continue;
            }

            if (!stopNameToIds[stopName]) {
                stopNameToIds[stopName] = [];
            }
            if (!stopNameToIds[stopName].includes(stopId)) {
                stopNameToIds[stopName].push(stopId);
            }

            stopRecords.push({
                stop_id: stopId,
                stop_name: stopName,
                stop_lat: stopLat,
                stop_lon: stopLon,
            });
        }

        return {
            stop_names: Object.keys(stopNameToIds).sort((a, b) => a.localeCompare(b)),
            stop_name_to_ids: stopNameToIds,
            stop_records: stopRecords,
        };
    } catch (error) {
        console.error('GTFS fallback load failed:', error);
        return { stop_names: [], stop_name_to_ids: {}, stop_records: [] };
    }
}

function getLiveTrackingCollection() {
    if (!mongoReady) {
        return null;
    }

    const database = client.db(DB_NAME);
    return database.collection(LIVE_COLLECTION);
}

app.get('/api/bus-location', async (req, res) => {
    try {
        if (!mongoReady) {
            return res.status(503).json({
                error: 'Live tracking is unavailable while MongoDB is offline',
                degraded: true,
            });
        }

        const { bus_id } = req.query;
        if (!bus_id) {
            return res.status(400).json({ error: 'bus_id required' });
        }

        const liveTracking = getLiveTrackingCollection();

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
    if (!mongoReady) {
        return buildLocalStopsSnapshot();
    }

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

    if (!Object.keys(stopNameToIds).length) {
        return buildLocalStopsSnapshot();
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

function parseCsvParam(value) {
    return String(value || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
}

function toNameByIdMap(stopNameToIds) {
    const byId = {};
    Object.entries(stopNameToIds || {}).forEach(([name, ids]) => {
        (ids || []).forEach((id) => {
            byId[String(id)] = name;
        });
    });
    return byId;
}

function hhmmssFromDate(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.valueOf())) return '--:--:--';
    return date.toTimeString().split(' ')[0] || '--:--:--';
}

function findStopRecordByName(snapshot, stopName) {
    if (!snapshot || !Array.isArray(snapshot.stop_records)) return null;
    const needle = String(stopName || '').trim().toLowerCase();
    if (!needle) return null;
    return snapshot.stop_records.find((s) => String(s.stop_name || '').trim().toLowerCase() === needle) || null;
}

function approxDistanceM(lat1, lon1, lat2, lon2) {
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    return Math.round(Math.sqrt((dLat * dLat) + (dLon * dLon)) * 111000);
}

function buildPolyline(snapshot, doc, startStopName) {
    const points = [];

    const startRecord = findStopRecordByName(snapshot, startStopName);
    if (startRecord) {
        points.push([startRecord.stop_lat, startRecord.stop_lon]);
    }

    const coordinates = doc && doc.location && Array.isArray(doc.location.coordinates)
        ? doc.location.coordinates
        : null;
    if (coordinates && coordinates.length >= 2) {
        const lng = Number(coordinates[0]);
        const lat = Number(coordinates[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            points.push([lat, lng]);
        }
    }

    const nextRecord = findStopRecordByName(snapshot, doc.next_stop);
    if (nextRecord) {
        points.push([nextRecord.stop_lat, nextRecord.stop_lon]);
    }

    const endRecord = findStopRecordByName(snapshot, doc.end_stop);
    if (endRecord) {
        points.push([endRecord.stop_lat, endRecord.stop_lon]);
    }

    // Remove duplicates to keep polyline stable for map fit.
    const deduped = [];
    for (const pt of points) {
        const last = deduped[deduped.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
            deduped.push(pt);
        }
    }

    return deduped;
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

app.get('/api/plan', async (req, res) => {
    try {
        const snapshot = await getStopsSnapshot();
        const liveTracking = getLiveTrackingCollection();

        const endIds = parseCsvParam(req.query.end_id);
        const startIds = parseCsvParam(req.query.start_id);
        const userLat = Number(req.query.u_lat);
        const userLon = Number(req.query.u_lon);

        const stopNameById = toNameByIdMap(snapshot.stop_name_to_ids);
        const targetEndNames = new Set(endIds.map((id) => stopNameById[id]).filter(Boolean));

        let startStopName = null;
        if (startIds.length) {
            startStopName = stopNameById[startIds[0]] || null;
        }
        if (!startStopName && Number.isFinite(userLat) && Number.isFinite(userLon)) {
            if (snapshot.stop_records && snapshot.stop_records.length) {
                let nearest = null;
                let nearestDistSq = Number.POSITIVE_INFINITY;
                for (const stop of snapshot.stop_records) {
                    const dLat = Number(stop.stop_lat) - userLat;
                    const dLon = Number(stop.stop_lon) - userLon;
                    const distSq = (dLat * dLat) + (dLon * dLon);
                    if (distSq < nearestDistSq) {
                        nearestDistSq = distSq;
                        nearest = stop;
                    }
                }
                startStopName = nearest ? nearest.stop_name : null;
            }
        }

        if (!liveTracking) {
            return res.status(200).json({ options: [], degraded: true });
        }

        const docs = await liveTracking
            .find({ bus_id: { $type: 'string', $ne: '' } })
            .sort({ last_ping: -1 })
            .limit(300)
            .toArray();

        const latestByBus = new Map();
        for (const doc of docs) {
            const busKey = String(doc.bus_id || '').trim();
            if (!busKey || latestByBus.has(busKey)) continue;
            latestByBus.set(busKey, doc);
        }

        const matchedOptions = [];
        const fallbackOptions = [];
        for (const doc of latestByBus.values()) {
            const endStop = String(doc.end_stop || doc.next_stop || '').trim();
            const nextStop = String(doc.next_stop || endStop || 'Next Stop').trim();
            const currentStop = String(doc.current_stop || '').trim();

            let isDestinationMatch = true;
            if (targetEndNames.size) {
                const searchable = [endStop, nextStop, currentStop].map((v) => v.toLowerCase());
                isDestinationMatch = Array.from(targetEndNames)
                    .some((name) => searchable.includes(String(name).toLowerCase()));
            }

            const polyline = buildPolyline(snapshot, doc, startStopName || doc.start_stop || currentStop);
            const firstPoint = polyline[0] || [18.5204, 73.8567];
            const routeStops = [doc.start_stop, currentStop, nextStop, endStop]
                .map((v) => String(v || '').trim())
                .filter(Boolean)
                .filter((v, i, arr) => arr.indexOf(v) === i);

            const startName = String(startStopName || doc.start_stop || currentStop || 'Nearby Stop').trim();
            const startRecord = findStopRecordByName(snapshot, startName);
            const walkDist = (Number.isFinite(userLat) && Number.isFinite(userLon) && startRecord)
                ? approxDistanceM(userLat, userLon, Number(startRecord.stop_lat), Number(startRecord.stop_lon))
                : 0;

            const etaBase = Number(doc.speed) > 0 ? Math.max(4, Math.round(35 / Number(doc.speed))) : 12;

            const option = {
                bus_no: String(doc.bus_id).toUpperCase(),
                route: String(doc.route || 'Direct Route'),
                departure: hhmmssFromDate(doc.last_ping),
                eta: etaBase,
                walk_dist: walkDist,
                start_stop: startName,
                end_stop: endStop || Array.from(targetEndNames)[0] || 'Destination',
                start_coords: firstPoint,
                polyline,
                stops: routeStops,
                fare_inr: Math.max(20, 20 + Math.round((polyline.length || 1) * 2.5)),
                distance_km: Math.max(1.2, Number((polyline.length * 1.1).toFixed(1))),
                is_transfer: false,
            };

            if (isDestinationMatch) {
                matchedOptions.push(option);
            } else {
                fallbackOptions.push(option);
            }
        }

        const sourceOptions = matchedOptions.length ? matchedOptions : fallbackOptions;
        const options = sourceOptions
            .sort((a, b) => Number(a.eta) - Number(b.eta))
            .slice(0, 20);

        res.status(200).json({ options });
    } catch (e) {
        console.error('Plan API Error:', e);
        res.status(500).json({ error: 'Unable to compute route plan', options: [] });
    }
});

app.get('/api/bus-suggestions', async (_req, res) => {
    try {
        const liveTracking = getLiveTrackingCollection();

        if (!liveTracking) {
            return res.status(200).json({
                bus_ids: [],
                routes: [],
                degraded: true,
            });
        }

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
    res.json({
        ok: true,
        service: 'pmpml-live-engine',
        mongo: mongoReady ? 'connected' : 'degraded',
        startupError: mongoStartupError,
    });
});

app.listen(PORT, async () => {
    try {
        await client.connect();
        mongoReady = true;
        mongoStartupError = null;
        console.log('-----------------------------------------');
        console.log(`ENGINE ACTIVE: http://localhost:${PORT}`);
        console.log('ATLAS CONNECTED: Keys loaded via .env');
        console.log('-----------------------------------------');
    } catch (err) {
        mongoReady = false;
        mongoStartupError = err && err.message ? err.message : 'MongoDB connection failed';
        console.error('MongoDB unavailable. Starting in degraded mode with local GTFS data.');
        console.error(err);
        console.log('-----------------------------------------');
        console.log(`ENGINE ACTIVE: http://localhost:${PORT}`);
        console.log('ATLAS STATUS: offline, local fallback enabled');
        console.log('-----------------------------------------');
    }
});
