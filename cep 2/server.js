const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// In-memory store for bus locations
const busLocations = {};

// POST endpoint for drivers to send location
app.post('/api/bus-location', (req, res) => {
    const { bus_id, latitude, longitude, timestamp } = req.body;
    
    if (!bus_id || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Update location
    busLocations[bus_id] = {
        bus_id,
        latitude,
        longitude,
        timestamp: timestamp || new Date().toISOString(),
        lastUpdated: Date.now()
    };

    console.log(`[Location Update] Bus: ${bus_id} | Lat: ${latitude} | Lng: ${longitude}`);
    res.status(200).json({ success: true });
});

// GET endpoint for passengers to retrieve location
app.get('/api/bus-location', (req, res) => {
    const { bus_id } = req.query;

    if (!bus_id) {
        return res.status(400).json({ error: 'Missing bus_id parameter' });
    }

    const location = busLocations[bus_id];

    if (!location) {
        return res.status(404).json({ error: 'Bus location not found' });
    }

    // Optionally check if data is stale (e.g., driver app stopped sending)
    const isStale = Date.now() - location.lastUpdated > 30000; // 30 seconds

    res.status(200).json({
        bus_id: location.bus_id,
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: location.timestamp,
        isStale
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
