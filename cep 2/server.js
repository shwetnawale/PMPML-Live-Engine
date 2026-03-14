require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || 'CitySaarthi';
const COLLECTION_NAME = process.env.MONGO_COLLECTION_NAME || 'live_tracking';
const FALLBACK_ALLOWED = ['BUS-39'];

const rawAllowed = (process.env.ALLOWED_BUS_IDS || '')
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
const allowedBusIds = new Set(rawAllowed.length ? rawAllowed : FALLBACK_ALLOWED);

if (!MONGO_URI) {
    console.error('[BOOT] Missing MONGO_URI in environment.');
    process.exit(1);
}

const client = new MongoClient(MONGO_URI);

app.use(cors());
app.use(express.json());

function isValidBusId(busId) {
    const normalized = String(busId || '').trim().toUpperCase();
    if (!normalized) return false;
    if (!/^[A-Z0-9-]{2,24}$/.test(normalized)) return false;
    return allowedBusIds.has(normalized);
}

function parseTimestamp(value) {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.valueOf()) ? new Date() : date;
}

app.get('/api/health', async (_req, res) => {
    try {
        await client.db(DB_NAME).command({ ping: 1 });
        res.status(200).json({ status: 'ok', db: 'connected' });
    } catch (error) {
        res.status(500).json({ status: 'error', db: 'disconnected' });
    }
});

/**
 * LOGIC: The Broker Endpoint.
 * Converts MongoDB [lng, lat] into Leaflet [lat, lng] and sanitizes public payload.
 */
app.get('/api/bus-location', async (req, res) => {
    try {
        const requestedBusId = String(req.query.bus_id || '').trim().toUpperCase();
        if (!requestedBusId) {
            return res.status(400).json({ error: 'Missing Bus ID' });
        }

        if (!isValidBusId(requestedBusId)) {
            return res.status(403).json({ error: 'Bus ID not permitted' });
        }

        const database = client.db(DB_NAME);
        const liveTracking = database.collection(COLLECTION_NAME);

        const data = await liveTracking.findOne(
            { bus_id: requestedBusId },
            { sort: { last_ping: -1 } }
        );

        if (!data || !data.location || !Array.isArray(data.location.coordinates) || data.location.coordinates.length < 2) {
            return res.status(404).json({ error: 'Bus Offline' });
        }

        const lng = Number(data.location.coordinates[0]);
        const lat = Number(data.location.coordinates[1]);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(500).json({ error: 'Corrupt coordinate payload' });
        }

        const timestamp = parseTimestamp(data.last_ping).toISOString();
        const speed = Math.max(0, Math.round(Number(data.speed || 0)));

        res.status(200).json({
            bus_id: data.bus_id || requestedBusId,
            route: data.route || 'Route unavailable',
            lat,
            lng,
            speed,
            status: 'Live',
            timestamp,
        });

        console.log(`[SYNC] Dispatching ${requestedBusId} at ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    } catch (error) {
        console.error('[BROKER] Critical error:', error.message);
        res.status(500).json({ error: 'Internal Bridge Failure' });
    }
});

async function start() {
    try {
        await client.connect();
        app.listen(PORT, () => {
            console.log('-----------------------------------------');
            console.log(`CITYSAARTHI ENGINE: http://localhost:${PORT}`);
            console.log('ATLAS STATUS: Connected & Synced');
            console.log('-----------------------------------------');
        });
    } catch (error) {
        console.error('Infrastructure Refused Connection. Check hotspot/Atlas whitelist.');
        console.error(error.message);
        process.exit(1);
    }
}

start();
