from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
import pandas as pd
import os
import math
from datetime import datetime, timedelta

app = FastAPI()

class UniversalClock:
    def __init__(self):
        # Initializing with the requested test time
        self.current_time = datetime.strptime("10:15:00", "%H:%M:%S")

    def tick(self, minutes=1):
        self.current_time += timedelta(minutes=minutes)
        return self.get_time()

    def get_time(self):
        return self.current_time.strftime("%H:%M:%S")

clock = UniversalClock()

def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371 
    dlat, dlon = math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * (2 * math.atan2(math.sqrt(a), math.sqrt(1-a)))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

def load_gtfs():
    path = os.path.join(BASE_DIR, "gtfs_data")
    # Loading standardized GTFS files from the PMPML repository
    r, s, t, st = [pd.read_csv(os.path.join(path, f"{x}.txt")) for x in ["routes", "stops", "trips", "stop_times"]]
    for df in [r, t, s, st]:
        if 'route_id' in df.columns: df['route_id'] = df['route_id'].astype(str)
        if 'stop_id' in df.columns: df['stop_id'] = df['stop_id'].astype(str)
    return r, s, t, st

ROUTES, STOPS, TRIPS, STOP_TIMES = load_gtfs()

@app.get("/")
def home(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request, 
        "stops": STOPS[['stop_id', 'stop_name']].sort_values('stop_name').drop_duplicates('stop_name').to_dict('records'),
        "current_time": clock.get_time()
    })

@app.post("/api/tick")
async def clock_tick(): return {"time": clock.tick(1)}

@app.get("/api/plan")
def plan_route(u_lat: float, u_lon: float, end_id: str):
    curr_time_str = clock.get_time()
    curr_dt = datetime.strptime(curr_time_str, "%H:%M:%S")
    
    stops_copy = STOPS.drop_duplicates('stop_name').copy()
    stops_copy['dist'] = stops_copy.apply(lambda x: calculate_distance(u_lat, u_lon, float(x['stop_lat']), float(x['stop_lon'])), axis=1)
    near_stops = stops_copy.sort_values('dist').head(5)
    
    all_options = []
    for _, start_stop in near_stops.iterrows():
        start_trips = STOP_TIMES[STOP_TIMES['stop_id'] == str(start_stop['stop_id'])]
        end_trips = STOP_TIMES[STOP_TIMES['stop_id'] == end_id]
        merged = pd.merge(start_trips, end_trips, on='trip_id', suffixes=('_s', '_e'))
        valid = merged[merged['stop_sequence_s'] < merged['stop_sequence_e']]
        
        if not valid.empty:
            upcoming = valid[valid['departure_time_s'] >= curr_time_str].sort_values('departure_time_s').head(3)
            for _, trip in upcoming.iterrows():
                route_id = TRIPS[TRIPS['trip_id'] == trip['trip_id']].iloc[0]['route_id']
                bus_no = ROUTES[ROUTES['route_id'] == route_id].iloc[0]['route_short_name']
                
                # Live ETA Calculation
                dep_dt = datetime.strptime(trip['departure_time_s'], "%H:%M:%S")
                eta_minutes = int((dep_dt - curr_dt).total_seconds() / 60)
                
                segment = STOP_TIMES[STOP_TIMES['trip_id'] == trip['trip_id']].sort_values('stop_sequence')
                seg_mask = (segment['stop_sequence'] >= trip['stop_sequence_s']) & (segment['stop_sequence'] <= trip['stop_sequence_e'])
                path = pd.merge(segment[seg_mask], STOPS, on='stop_id')

                all_options.append({
                    "bus_no": bus_no,
                    "departure": trip['departure_time_s'],
                    "eta": eta_minutes,
                    "start_stop": start_stop['stop_name'],
                    "walk_dist": round(start_stop['dist'] * 1000),
                    "start_coords": [start_stop['stop_lat'], start_stop['stop_lon']],
                    "polyline": path[['stop_lat', 'stop_lon']].values.tolist()
                })

    return {"options": sorted(all_options, key=lambda x: x['departure'])[:5]}