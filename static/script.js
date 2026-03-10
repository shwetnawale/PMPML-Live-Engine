// Google Maps Silver Theme
let map = L.map('map', {zoomControl: false}).setView([18.5204, 73.8567], 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);

const stopMapNode = document.getElementById('stop-map-data');
const STOP_NAME_TO_ID = stopMapNode ? JSON.parse(stopMapNode.textContent || '{}') : {};

let uLat, uLon, uMarker, walkDots = [], busLine, simInterval = null;

// GPS Location Tracking
map.locate({setView: true, maxZoom: 15, enableHighAccuracy: true});
map.on('locationfound', (e) => {
    uLat = e.latlng.lat; uLon = e.latlng.lng;
    if(uMarker) map.removeLayer(uMarker);
    uMarker = L.circleMarker(e.latlng, {radius: 7, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.9}).addTo(map);
});

function swapStops() {
    const startInput = document.getElementById('startInput');
    const destInput = document.getElementById('destInput');
    if(!startInput || !destInput) return;

    const temp = startInput.value;
    startInput.value = destInput.value;
    destInput.value = temp;
}

function triggerSearch() {
    const startVal = document.getElementById('startInput')?.value?.trim();
    const endVal = document.getElementById('destInput').value;
    const startIds = startVal ? STOP_NAME_TO_ID[startVal] : null;
    const endIds = STOP_NAME_TO_ID[endVal];
    if(!endIds || !endIds.length) return alert("Please select a valid destination stop.");
    if(startVal && (!startIds || !startIds.length)) return alert("Please select a valid start stop from suggestions.");
    if(!startIds && !uLat) return alert("Please allow GPS access or select a start stop.");

    const params = new URLSearchParams({ end_id: endIds.join(',') });
    if(startIds) {
        params.set('start_id', startIds.join(','));
    } else {
        params.set('u_lat', uLat);
        params.set('u_lon', uLon);
    }

    fetch(`/api/plan?${params.toString()}`)
    .then(res => res.json()).then(data => {
        const listPanel = document.getElementById('results-list');
        listPanel.innerHTML = "";

        if(!data.options || !data.options.length) {
            listPanel.innerHTML = '<div style="color:#5f6368; padding:10px 2px;">No direct buses found for this stop at current simulation time.</div>';
            walkDots.forEach(d => map.removeLayer(d));
            if(busLine) map.removeLayer(busLine);
            walkDots = [];
            busLine = null;
            return;
        }
        
        data.options.forEach(opt => {
            const card = document.createElement('div');
            card.className = "bus-card";
            card.innerHTML = `
                <div class="bus-left">
                    <div class="bus-badge">${opt.bus_no}</div>
                    <div>
                        <div style="font-weight:bold; font-size:15px">${opt.departure}</div>
                        <div style="font-size:12px; color:#5f6368">🚶 ${opt.walk_dist}m to ${opt.start_stop}</div>
                    </div>
                </div>
                <div class="eta-label">${opt.eta} min</div>
            `;
            card.onclick = () => renderTrip(opt);
            listPanel.appendChild(card);
        });
        if(data.options.length) renderTrip(data.options[0]);
    })
    .catch(() => {
        const listPanel = document.getElementById('results-list');
        listPanel.innerHTML = '<div style="color:#d93025; padding:10px 2px;">Unable to fetch route now. Please try again.</div>';
    });
}

function renderTrip(opt) {
    // Clear old route and walking dots
    walkDots.forEach(d => map.removeLayer(d));
    if(busLine) map.removeLayer(busLine);
    walkDots = [];

    // 1. Render Blue-Dot Walking Path (Circular Dots)
    if(typeof uLat === 'number' && typeof uLon === 'number') {
        const dotCount = 14;
        for(let i=0; i<=dotCount; i++) {
            let lat = uLat + (opt.start_coords[0] - uLat) * (i/dotCount);
            let lon = uLon + (opt.start_coords[1] - uLon) * (i/dotCount);
            let circle = L.circle([lat, lon], {radius: 2, color: '#4285F4', fillColor: '#4285F4', fillOpacity: 0.8}).addTo(map);
            walkDots.push(circle);
        }
    }

    // 2. Render Bus Segment Polyline
    busLine = L.polyline(opt.polyline, {color: '#1a73e8', weight: 5, opacity: 0.8}).addTo(map);
    map.fitBounds(busLine.getBounds(), {padding: [120, 120]});
}

function toggleSimulation() {
    const playBtn = document.getElementById('playBtn');
    if (simInterval) { clearInterval(simInterval); simInterval = null; playBtn.innerText = "▶ Play Sim"; }
    else {
        playBtn.innerText = "⏹ Stop Sim";
        simInterval = setInterval(() => {
            fetch('/api/tick', {method: 'POST'}).then(res => res.json()).then(data => {
                document.getElementById('clock-display').innerText = data.time;
                triggerSearch(); // Dynamically update ETAs every tick
            });
        }, 1000); // 1s real = 1m simulation
    }
}