const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const PORT = 3000;

// YOUR ATLAS CONNECTION
const uri = "mongodb+srv://shwet:saarthi123@chatgpt.lq5dqj9.mongodb.net/CitySaarthi?retryWrites=true&w=majority";
const client = new MongoClient(uri);

app.use(cors());
app.use(express.json());

// API for Passenger Hub to get live data from Atlas
app.get('/api/bus-location', async (req, res) => {
    try {
        const { bus_id } = req.query;
        if (!bus_id) return res.status(400).json({ error: 'Missing bus_id' });

        const database = client.db('CitySaarthi');
        const liveTracking = database.collection('live_tracking');
        
        // Find the record created by your Flutter Driver App
        const data = await liveTracking.findOne({ bus_id: bus_id });

        if (!data) return res.status(404).json({ error: 'Bus not found or offline' });

        res.json({
            bus_id: data.bus_id,
            route: data.route,
            lat: data.location.coordinates[1], // Latitude
            lng: data.location.coordinates[0], // Longitude
            speed: data.speed,
            last_ping: data.last_ping
        });
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.listen(PORT, async () => {
    await client.connect();
    console.log(`-----------------------------------------`);
    console.log(`🚀 SERVER: http://localhost:${PORT}`);
    console.log(`📦 DB: Connected to CitySaarthi Atlas`);
    console.log(`-----------------------------------------`);
});