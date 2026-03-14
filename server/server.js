require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

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

        const database = client.db('CitySaarthi');
        const liveTracking = database.collection('live_tracking');

        // Find the most recent record for this bus.
        const data = await liveTracking.findOne({ bus_id: String(bus_id) });

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
