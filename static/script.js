let map = L.map('map').setView([18.5204, 73.8567], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

const busIcon = L.icon({iconUrl: 'https://cdn-icons-png.flaticon.com/512/3448/3448339.png', iconSize:[35,35]});
let routeLine, busMarker, userMarker, walkingLine, simInterval = null;
let isManualMode = false;

// --- 1. LOCATION LOGIC ---

function toggleLocationMode() {
    isManualMode = !isManualMode;
    const btn = document.getElementById('locModeBtn');
    if (isManualMode) {
        btn.innerText = "🖱 Mode: Manual (Click Map)";
        btn.style.background = "#fd7e14";
        map.off('locationfound'); // Stop GPS auto-updates
    } else {
        btn.innerText = "📍 Mode: GPS";
        btn.style.background = "#ffc107";
        map.locate({setView: true, maxZoom: 15, enableHighAccuracy: true});
    }
}

// Manual Click Trigger
map.on('click', function(e) {
    if (isManualMode) {
        processUserLocation(e.latlng.lat, e.latlng.lng, "Test Point");
    }
});

// GPS Trigger
map.on('locationfound', (e) => {
    if (!isManualMode) {
        processUserLocation(e.latlng.lat, e.latlng.lng, "Your Location");
    }
});

function processUserLocation(lat, lon, label) {
    // Clear old user marker and walking line
    if (userMarker) map.removeLayer(userMarker);
    if (walkingLine) map.removeLayer(walkingLine);

    userMarker = L.circleMarker([lat, lon], {radius: 8, color: 'red', fillOpacity: 1}).addTo(map).bindPopup(label).openPopup();

    fetch('/api/nearby', {
        method:'POST', 
        headers:{'Content-Type':'application/json'}, 
        body:JSON.stringify({lat: lat, lon: lon})
    })
    .then(res => res.json()).then(data => {
        // Update Dashboard
        document.getElementById('dash-title').innerText = data.stop_name;
        document.getElementById('walk-dist').innerText = `🚶 Walk: ${data.distance} meters`;
        document.getElementById('results').innerHTML = data.buses.map(b => 
            `<div style="padding:5px; border-bottom:1px solid #eee">🚌 ${b.route_short_name}: <b>${b.arrival_time}</b></div>`
        ).join('');
        document.getElementById('dash').style.display = 'block';

        // DRAW DOTTED WALKING ROUTE
        walkingLine = L.polyline([[lat, lon], data.stop_coords], {
            color: '#555',
            weight: 3,
            dashArray: '10, 10', // THIS MAKES IT DOTTED
            opacity: 0.8
        }).addTo(map);
    });
}

// --- 2. SIMULATION & TRACKING ---

function toggleSim() {
    const btn = document.getElementById('playBtn');
    if (simInterval) { 
        clearInterval(simInterval); simInterval = null; 
        btn.innerText = "▶ Play"; btn.style.background = "#28a745";
    } else {
        btn.innerText = "⏹ Stop"; btn.style.background = "#dc3545";
        simInterval = setInterval(() => {
            fetch('/api/tick', {method: 'POST'}).then(res => res.json()).then(data => {
                document.getElementById('clock-val').innerText = data.time;
                if(document.getElementById('rSearch').value) updateBus();
            });
        }, 1000);
    }
}

function updateBus() {
    let id = document.getElementById('rSearch').value;
    fetch('/api/track/' + id).then(res => res.json()).then(data => {
        if(routeLine) map.removeLayer(routeLine);
        if(busMarker) map.removeLayer(busMarker);
        routeLine = L.polyline(data.polyline, {color:'#007bff', weight:5}).addTo(map);
        busMarker = L.marker(data.bus_loc, {icon:busIcon}).addTo(map).bindPopup(data.stop).openPopup();
    });
}

// Initial GPS call
map.locate({setView: true, maxZoom: 15, enableHighAccuracy: true});