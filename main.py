from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
import pandas as pd
import os
import math
from datetime import datetime, timedelta

app = FastAPI()

# --- UNIVERSAL CLOCK LOGIC ---
class UniversalClock:
    def __init__(self):
        self.current_time = datetime.strptime("10:15:00", "%H:%M:%S")
        self.is_manual = True

    def set_time(self, time_str):
        if len(time_str) == 5: time_str += ":00"
        self.current_time = datetime.strptime(time_str, "%H:%M:%S")

    def tick(self, minutes=1):
        self.current_time += timedelta(minutes=minutes)
        return self.get_time()

    def get_time(self):
        return self.current_time.strftime("%H:%M:%S")

clock = UniversalClock()

# --- GEOLOCATION MATH ---
def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371  # Earth radius in KM
    dlat, dlon = math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * (2 * math.atan2(math.sqrt(a), math.sqrt(1-a)))

# --- DATA ENGINE ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

def load_gtfs():
    path = os.path.join(BASE_DIR, "gtfs_data")
    r = pd.read_csv(os.path.join(path, "routes.txt"))
    s = pd.read_csv(os.path.join(path, "stops.txt"))
    t = pd.read_csv(os.path.join(path, "trips.txt"))
    st = pd.read_csv(os.path.join(path, "stop_times.txt"))
    r['display'] = r['route_short_name'].astype(str) + " (" + r['route_long_name'] + ")"
    return r, s, t, st

ROUTES, STOPS, TRIPS, STOP_TIMES = load_gtfs()

@app.get("/")
def home(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request, 
        "routes": ROUTES[['route_id', 'display']].to_dict('records'),
        "stops": STOPS[['stop_id', 'stop_name']].drop_duplicates('stop_name').to_dict('records'),
        "current_time": clock.get_time()
    })

@app.post("/api/tick")
async def clock_tick():
    return {"time": clock.tick(1)}

@app.post("/api/set-time")
async def set_manual_time(data: dict):
    clock.set_time(data['time'])
    return {"status": "Updated", "time": clock.get_time()}

@app.post("/api/nearby")
async def find_nearby(data: dict):
    u_lat, u_lon, curr_time = data['lat'], data['lon'], clock.get_time()
    stops_copy = STOPS.drop_duplicates('stop_name').copy()
    stops_copy['dist'] = stops_copy.apply(lambda x: calculate_distance(u_lat, u_lon, x['stop_lat'], x['stop_lon']), axis=1)
    closest = stops_copy.sort_values('dist').iloc[0]
    
    arrivals = STOP_TIMES[STOP_TIMES['stop_id'] == closest['stop_id']]
    merged = pd.merge(pd.merge(arrivals, TRIPS, on='trip_id'), ROUTES, on='route_id')
    upcoming = merged[merged['arrival_time'] >= curr_time].sort_values('arrival_time').head(5)
    
    return {
        "stop_name": closest['stop_name'],
        "stop_coords": [closest['stop_lat'], closest['stop_lon']],
        "distance": round(closest['dist'] * 1000, 1),
        "buses": upcoming[['route_short_name', 'arrival_time']].to_dict('records')
    }

@app.get("/api/track/{route_id}")
def track_route(route_id: str):
    curr_time = clock.get_time()
    mask = TRIPS['route_id'].astype(str) == str(route_id)
    matching_trips = TRIPS[mask]
    if matching_trips.empty: return {"error": "No trips found"}
    
    trip_id = matching_trips['trip_id'].iloc[0]
    schedule = STOP_TIMES[STOP_TIMES['trip_id'] == trip_id].sort_values('stop_sequence')
    path = pd.merge(schedule, STOPS, on='stop_id')
    passed = path[path['arrival_time'] <= curr_time]
    bus_pos = path.iloc[0] if passed.empty else passed.iloc[-1]
    
    return {
        "polyline": path[['stop_lat', 'stop_lon']].values.tolist(),
        "bus_loc": [bus_pos['stop_lat'], bus_pos['stop_lon']],
        "stop": bus_pos['stop_name']
    }