from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import numpy as np
import os
import math
from typing import Optional
from pydantic import BaseModel
from datetime import datetime, timedelta
import time

app = FastAPI()

# --- CORS MIDDLEWARE ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- UNIVERSAL CLOCK LOGIC ---
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

# --- GEOLOCATION MATH ---
def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371 
    dlat, dlon = math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * (2 * math.atan2(math.sqrt(a), math.sqrt(1-a)))

# --- DATA ENGINE ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
CEP2_DIR = os.path.join(BASE_DIR, "cep 2")

def load_gtfs():
    path = os.path.join(BASE_DIR, "gtfs_data")
    # Standard GTFS files
    r = pd.read_csv(os.path.join(path, "routes.txt"))
    s = pd.read_csv(os.path.join(path, "stops.txt"))
    t = pd.read_csv(os.path.join(path, "trips.txt"))
    st = pd.read_csv(os.path.join(path, "stop_times.txt"))
    
    # CRITICAL FIX: Force every ID to a string to prevent merge failures
    for df in [r, s, t, st]:
        for col in ['route_id', 'stop_id', 'trip_id']:
            if col in df.columns:
                df[col] = df[col].astype(str).str.strip()

    # Critical for route geometry/order: stop_sequence must be numeric, not text
    if 'stop_sequence' in st.columns:
        st['stop_sequence'] = pd.to_numeric(st['stop_sequence'], errors='coerce')
        st = st.dropna(subset=['stop_sequence']).copy()
        st['stop_sequence'] = st['stop_sequence'].astype(int)
    
    r['display'] = r['route_short_name'].astype(str) + " (" + r['route_long_name'] + ")"
    return r, s, t, st

ROUTES, STOPS, TRIPS, STOP_TIMES = load_gtfs()

STOPS_UNIQUE = STOPS.drop_duplicates("stop_name").copy()
STOPS_UNIQUE["stop_lat"] = STOPS_UNIQUE["stop_lat"].astype(float)
STOPS_UNIQUE["stop_lon"] = STOPS_UNIQUE["stop_lon"].astype(float)

STOP_TIMES_BY_STOP = {str(stop_id): group.copy() for stop_id, group in STOP_TIMES.groupby("stop_id", sort=False)}
STOP_TIMES_BY_TRIP = {
    str(trip_id): group.sort_values("stop_sequence").copy() for trip_id, group in STOP_TIMES.groupby("trip_id", sort=False)
}
STOPS_BY_ID = STOPS.drop_duplicates("stop_id").set_index("stop_id")
STOP_NAME_TO_IDS = {
    str(name): sorted(group["stop_id"].astype(str).tolist())
    for name, group in STOPS.groupby("stop_name", sort=False)
}
STOP_COORDS_BY_ID = STOPS_BY_ID[["stop_lat", "stop_lon"]].copy()
STOP_COORDS_BY_ID["stop_lat"] = STOP_COORDS_BY_ID["stop_lat"].astype(float)
STOP_COORDS_BY_ID["stop_lon"] = STOP_COORDS_BY_ID["stop_lon"].astype(float)
TRIP_TO_ROUTE = TRIPS.drop_duplicates("trip_id").set_index("trip_id")["route_id"].astype(str).to_dict()
ROUTE_TO_SHORT = ROUTES.drop_duplicates("route_id").set_index("route_id")["route_short_name"].astype(str).to_dict()

MAX_RESULTS = 5
MAX_START_TRIPS = 8
MAX_TRANSFER_STOPS = 20
MAX_TRANSFER_WAIT_SECONDS = 60 * 60
MAX_TRANSFER_JUMP_KM = 0.5


class BusLocationPayload(BaseModel):
    bus_id: str
    latitude: float
    longitude: float
    timestamp: Optional[str] = None


BUS_LOCATIONS: dict[str, dict] = {}


def parse_stop_ids(value: Optional[str]) -> list[str]:
    if value is None:
        return []
    return [part.strip() for part in str(value).split(",") if part.strip()]


def time_to_seconds(time_value: str) -> int:
    hours, minutes, seconds = [int(part) for part in str(time_value).split(":")]
    return hours * 3600 + minutes * 60 + seconds


def align_to_reference(raw_seconds: int, reference_seconds: int) -> int:
    aligned = int(raw_seconds)
    while aligned < reference_seconds:
        aligned += 24 * 3600
    return aligned


def calculate_fare_inr(distance_km: float) -> float:
    """
    Calculate bus fare in Indian Rupees (₹) based on distance.
    Standard PMPML pricing: Base fare + per km charge
    """
    base_fare = 5.0  # ₹5 base fare
    per_km_charge = 1.5  # ₹1.5 per km
    
    if distance_km <= 0:
        return base_fare
    
    fare = base_fare + (distance_km * per_km_charge)
    # Round to nearest 50 paise
    fare = round(fare * 2) / 2
    return max(5.0, fare)  # Minimum ₹5


def calculate_distance_for_route(polyline: list) -> float:
    """
    Calculate total distance from polyline coordinates (in km)
    """
    if not polyline or len(polyline) < 2:
        return 0.0
    
    total_distance = 0.0
    for i in range(len(polyline) - 1):
        lat1, lon1 = polyline[i]
        lat2, lon2 = polyline[i + 1]
        total_distance += calculate_distance(lat1, lon1, lat2, lon2)
    
    return total_distance


def build_polyline_from_segment(segment_df: pd.DataFrame) -> list[list[float]]:
    if segment_df is None or segment_df.empty:
        return []

    ordered = segment_df.sort_values("stop_sequence")
    points = []
    for stop_id in ordered["stop_id"].astype(str).tolist():
        if stop_id not in STOP_COORDS_BY_ID.index:
            continue
        coord = STOP_COORDS_BY_ID.loc[stop_id]
        point = [float(coord["stop_lat"]), float(coord["stop_lon"])]
        if not points or points[-1] != point:
            points.append(point)
    return points


def seconds_to_hhmmss(total_seconds: int) -> str:
    total_seconds %= 24 * 3600
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def haversine_km_vectorized(lat1, lon1, lat2_series, lon2_series):
    lat1_rad = np.radians(lat1)
    lon1_rad = np.radians(lon1)
    lat2_rad = np.radians(lat2_series.to_numpy())
    lon2_rad = np.radians(lon2_series.to_numpy())

    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(dlon / 2) ** 2
    return 6371 * (2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a)))


def nearest_stop_from_coords(lat: float, lon: float) -> dict:
    stops_copy = STOPS_UNIQUE.copy()
    stops_copy["dist_km"] = haversine_km_vectorized(lat, lon, stops_copy["stop_lat"], stops_copy["stop_lon"])
    nearest = stops_copy.nsmallest(1, "dist_km").iloc[0]
    stop_name = str(nearest["stop_name"])
    return {
        "stop_name": stop_name,
        "stop_ids": STOP_NAME_TO_IDS.get(stop_name, [str(nearest["stop_id"])]),
        "stop_id": str(nearest["stop_id"]),
        "stop_lat": float(nearest["stop_lat"]),
        "stop_lon": float(nearest["stop_lon"]),
        "distance_m": int(round(float(nearest["dist_km"]) * 1000)),
    }

@app.get("/")
def home():
    return FileResponse(os.path.join(CEP2_DIR, "home.html"))


@app.get("/cep2/home")
def cep2_home():
    return FileResponse(os.path.join(CEP2_DIR, "home.html"))


@app.get("/cep2/driver")
def cep2_driver():
    return FileResponse(os.path.join(CEP2_DIR, "driver.html"))


@app.get("/api/stops")
def get_stops():
    stop_names = sorted(STOP_NAME_TO_IDS.keys())
    return {
        "stop_names": stop_names,
        "stop_name_to_ids": STOP_NAME_TO_IDS,
    }


@app.get("/api/nearest-stop")
def get_nearest_stop(lat: float, lon: float):
    return nearest_stop_from_coords(lat, lon)


@app.get("/api/search-bus")
def search_bus_by_number(bus_no: str):
    """
    Search and track buses by their bus number.
    Returns all trips for the given bus number with timing and route info.
    """
    bus_no_str = str(bus_no).strip().upper()
    
    # Find all routes matching this bus number
    matching_routes = ROUTES[ROUTES['route_short_name'].astype(str).str.upper().str.strip() == bus_no_str]
    
    if matching_routes.empty:
        return {
            "bus_no": bus_no_str,
            "found": False,
            "message": f"Bus number {bus_no_str} not found"
        }
    
    bus_routes = []
    for _, route in matching_routes.iterrows():
        route_id = str(route['route_id'])
        route_name = str(route['route_long_name'])
        route_short = str(route['route_short_name'])
        
        # Find all trips for this route
        trips_for_route = TRIPS[TRIPS['route_id'].astype(str) == route_id]
        
        if trips_for_route.empty:
            continue
            
        # Get timing info and stops for first few trips
        trip_details = []
        for _, trip in trips_for_route.head(3).iterrows():
            trip_id = str(trip['trip_id'])
            trip_stops = STOP_TIMES_BY_TRIP.get(trip_id)
            
            if trip_stops is not None and not trip_stops.empty:
                first_stop = trip_stops.iloc[0]
                last_stop = trip_stops.iloc[-1]
                
                start_stop_id = str(first_stop['stop_id'])
                end_stop_id = str(last_stop['stop_id'])
                
                start_stop_name = STOPS_BY_ID.loc[start_stop_id, 'stop_name'] if start_stop_id in STOPS_BY_ID.index else "Unknown"
                end_stop_name = STOPS_BY_ID.loc[end_stop_id, 'stop_name'] if end_stop_id in STOPS_BY_ID.index else "Unknown"
                
                # Calculate route polyline and fare
                polyline = build_polyline_from_segment(trip_stops)
                distance_km = calculate_distance_for_route(polyline)
                fare_inr = calculate_fare_inr(distance_km)
                
                trip_details.append({
                    "trip_id": trip_id,
                    "departure": str(first_stop['departure_time']),
                    "arrival": str(last_stop['arrival_time']),
                    "start_stop": start_stop_name,
                    "end_stop": end_stop_name,
                    "distance_km": round(distance_km, 2),
                    "fare_inr": round(fare_inr, 2),
                    "stops_count": len(trip_stops)
                })
        
        if trip_details:
            bus_routes.append({
                "route_id": route_id,
                "route_name": route_name,
                "route_short": route_short,
                "trips": trip_details
            })
    
    return {
        "bus_no": bus_no_str,
        "found": len(bus_routes) > 0,
        "routes": bus_routes
    }

@app.post("/api/tick")
async def clock_tick(): return {"time": clock.tick(1)}


@app.post("/api/bus-location")
def update_bus_location(payload: BusLocationPayload):
    bus_id = payload.bus_id.strip()
    if not bus_id:
        raise HTTPException(status_code=400, detail="Missing bus_id")

    BUS_LOCATIONS[bus_id] = {
        "bus_id": bus_id,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "timestamp": payload.timestamp or datetime.utcnow().isoformat(),
        "lastUpdated": int(time.time() * 1000),
    }
    return {"success": True}


@app.get("/api/bus-location")
def get_bus_location(bus_id: str):
    bus_id = bus_id.strip()
    if not bus_id:
        raise HTTPException(status_code=400, detail="Missing bus_id parameter")

    location = BUS_LOCATIONS.get(bus_id)
    if location is None:
        raise HTTPException(status_code=404, detail="Bus location not found")

    is_stale = int(time.time() * 1000) - int(location["lastUpdated"]) > 30000
    return {
        "bus_id": location["bus_id"],
        "latitude": location["latitude"],
        "longitude": location["longitude"],
        "timestamp": location["timestamp"],
        "isStale": is_stale,
    }

@app.get("/api/plan")
def plan_route(end_id: str, u_lat: Optional[float] = None, u_lon: Optional[float] = None, start_id: Optional[str] = None):
    curr_time_str = clock.get_time()
    curr_seconds = time_to_seconds(curr_time_str)
    end_ids = parse_stop_ids(end_id)
    start_ids = parse_stop_ids(start_id)

    end_frames = [STOP_TIMES_BY_STOP.get(stop_id) for stop_id in end_ids]
    end_frames = [frame for frame in end_frames if frame is not None and not frame.empty]
    if not end_frames:
        return {"options": []}
    end_trips = pd.concat(end_frames, ignore_index=True)
    end_trips = end_trips.drop_duplicates(subset=["trip_id", "stop_sequence"])

    # Build candidate start stops from manual start selection or GPS proximity
    if start_ids:
        start_rows = []
        for stop_id in start_ids:
            if stop_id not in STOPS_BY_ID.index:
                continue
            start_row = STOPS_BY_ID.loc[stop_id]
            start_rows.append(
                {
                    "stop_id": str(stop_id),
                    "stop_name": start_row["stop_name"],
                    "stop_lat": float(start_row["stop_lat"]),
                    "stop_lon": float(start_row["stop_lon"]),
                    "dist": 0.0,
                }
            )
        if not start_rows:
            return {"options": []}
        near_stops = pd.DataFrame(start_rows)
    else:
        if u_lat is None or u_lon is None:
            return {"options": []}
        stops_copy = STOPS_UNIQUE.copy()
        stops_copy["dist"] = haversine_km_vectorized(u_lat, u_lon, stops_copy["stop_lat"], stops_copy["stop_lon"])
        near_stops = stops_copy.nsmallest(5, "dist")
    
    all_options = []
    for _, start_stop in near_stops.iterrows():
        s_id = str(start_stop['stop_id'])
        
        # Filtering trips passing through current proximity and target destination
        start_trips = STOP_TIMES_BY_STOP.get(s_id)
        if start_trips is None or start_trips.empty:
            continue
        
        merged = pd.merge(start_trips, end_trips, on='trip_id', suffixes=('_s', '_e'))
        valid = merged[merged['stop_sequence_s'] < merged['stop_sequence_e']]
        
        if not valid.empty:
            # Look for next buses, including next-day rollover
            valid = valid.copy()
            valid["dep_seconds_raw"] = valid["departure_time_s"].astype(str).map(time_to_seconds)
            valid["dep_seconds_effective"] = valid["dep_seconds_raw"].map(lambda x: align_to_reference(x, curr_seconds))
            upcoming = valid.nsmallest(3, "dep_seconds_effective")
            
            for _, trip in upcoming.iterrows():
                trip_id = str(trip['trip_id'])
                route_id = TRIP_TO_ROUTE.get(trip_id)
                bus_no = ROUTE_TO_SHORT.get(route_id, "N/A")
                
                # ETA Logic
                eta_minutes = max(0, int((int(trip["dep_seconds_effective"]) - curr_seconds) / 60))
                
                segment = STOP_TIMES_BY_TRIP.get(trip_id)
                if segment is None or segment.empty:
                    continue
                seg_mask = (segment['stop_sequence'] >= trip['stop_sequence_s']) & (segment['stop_sequence'] <= trip['stop_sequence_e'])
                path_segment = segment[seg_mask]
                polyline = build_polyline_from_segment(path_segment)

                if not polyline:
                    continue

                # Extract stop names from path segment
                stop_names_list = []
                try:
                    for _, row in path_segment.sort_values('stop_sequence').iterrows():
                        stop_id = str(row['stop_id'])
                        if stop_id in STOPS_BY_ID.index:
                            stop_name = str(STOPS_BY_ID.loc[stop_id, 'stop_name'])
                            if stop_name not in stop_names_list:  # Avoid duplicates
                                stop_names_list.append(stop_name)
                except Exception as e:
                    print(f"[DEBUG] Error extracting stops: {e}")
                    stop_names_list = []

                # Calculate distance and fare for this route
                distance_km = calculate_distance_for_route(polyline)
                fare_inr = calculate_fare_inr(distance_km)

                all_options.append({
                    "bus_no": bus_no,
                    "departure": str(trip['departure_time_s']),
                    "eta": eta_minutes,
                    "stops": stop_names_list,
                    "start_stop": start_stop['stop_name'],
                    "walk_dist": round(start_stop['dist'] * 1000),
                    "distance_km": round(distance_km, 2),
                    "fare_inr": round(fare_inr, 2),
                    "start_coords": [float(start_stop['stop_lat']), float(start_stop['stop_lon'])],
                    "polyline": polyline
                })

    if all_options:
        return {"options": sorted(all_options, key=lambda x: x['eta'])[:MAX_RESULTS]}

    transfer_options = []
    end_trips_small = end_trips[['trip_id', 'stop_sequence', 'arrival_time']].rename(
        columns={'stop_sequence': 'stop_sequence_e', 'arrival_time': 'arrival_time_e'}
    )

    for _, start_stop in near_stops.iterrows():
        s_id = str(start_stop['stop_id'])
        start_trips = STOP_TIMES_BY_STOP.get(s_id)
        if start_trips is None or start_trips.empty:
            continue

        start_candidates = start_trips.copy()
        start_candidates['dep_start_raw'] = start_candidates['departure_time'].astype(str).map(time_to_seconds)
        start_candidates['dep_start_effective'] = start_candidates['dep_start_raw'].map(lambda x: align_to_reference(x, curr_seconds))
        start_candidates = start_candidates.nsmallest(MAX_START_TRIPS, 'dep_start_effective')

        for _, leg1 in start_candidates.iterrows():
            trip1_id = str(leg1['trip_id'])
            trip1_route = ROUTE_TO_SHORT.get(TRIP_TO_ROUTE.get(trip1_id), 'N/A')

            segment1 = STOP_TIMES_BY_TRIP.get(trip1_id)
            if segment1 is None or segment1.empty:
                continue

            start_seq_1 = int(leg1['stop_sequence'])
            dep1_eff = int(leg1['dep_start_effective'])

            transfer_points = segment1[segment1['stop_sequence'] > start_seq_1].head(MAX_TRANSFER_STOPS)
            for _, transfer_point in transfer_points.iterrows():
                transfer_stop_id = str(transfer_point['stop_id'])
                transfer_seq_1 = int(transfer_point['stop_sequence'])
                arr1_raw = time_to_seconds(str(transfer_point['arrival_time']))
                arr1_eff = align_to_reference(arr1_raw, dep1_eff)

                transfer_trips = STOP_TIMES_BY_STOP.get(transfer_stop_id)
                if transfer_trips is None or transfer_trips.empty:
                    continue

                leg2_merge = pd.merge(transfer_trips, end_trips_small, on='trip_id', how='inner')
                if leg2_merge.empty:
                    continue

                leg2_merge = leg2_merge[
                    (leg2_merge['stop_sequence'] < leg2_merge['stop_sequence_e']) &
                    (leg2_merge['trip_id'] != trip1_id)
                ]
                if leg2_merge.empty:
                    continue

                leg2_merge = leg2_merge.copy()
                leg2_merge['dep2_raw'] = leg2_merge['departure_time'].astype(str).map(time_to_seconds)
                leg2_merge['dep2_eff'] = leg2_merge['dep2_raw'].map(lambda x: align_to_reference(x, arr1_eff))
                leg2_merge['wait'] = leg2_merge['dep2_eff'] - arr1_eff
                leg2_merge = leg2_merge[leg2_merge['wait'] <= MAX_TRANSFER_WAIT_SECONDS]
                if leg2_merge.empty:
                    continue

                leg2 = leg2_merge.nsmallest(1, 'dep2_eff').iloc[0]
                trip2_id = str(leg2['trip_id'])
                trip2_route = ROUTE_TO_SHORT.get(TRIP_TO_ROUTE.get(trip2_id), 'N/A')

                segment2 = STOP_TIMES_BY_TRIP.get(trip2_id)
                if segment2 is None or segment2.empty:
                    continue

                transfer_seq_2 = int(leg2['stop_sequence'])
                end_seq_2 = int(leg2['stop_sequence_e'])
                leg1_path_segment = segment1[(segment1['stop_sequence'] >= start_seq_1) & (segment1['stop_sequence'] <= transfer_seq_1)]
                leg2_path_segment = segment2[(segment2['stop_sequence'] >= transfer_seq_2) & (segment2['stop_sequence'] <= end_seq_2)]
                leg1_coords = build_polyline_from_segment(leg1_path_segment)
                leg2_coords = build_polyline_from_segment(leg2_path_segment)

                if not leg1_coords or not leg2_coords:
                    continue

                jump_km = calculate_distance(
                    leg1_coords[-1][0],
                    leg1_coords[-1][1],
                    leg2_coords[0][0],
                    leg2_coords[0][1],
                )
                if jump_km > MAX_TRANSFER_JUMP_KM:
                    continue

                if leg1_coords and leg2_coords and leg1_coords[-1] == leg2_coords[0]:
                    polyline = leg1_coords + leg2_coords[1:]
                else:
                    polyline = leg1_coords + leg2_coords

                # Extract stops for leg 1 and leg 2
                leg1_stops = []
                try:
                    for _, row in leg1_path_segment.sort_values('stop_sequence').iterrows():
                        stop_id = str(row['stop_id'])
                        if stop_id in STOPS_BY_ID.index:
                            stop_name = str(STOPS_BY_ID.loc[stop_id, 'stop_name'])
                            if stop_name not in leg1_stops:
                                leg1_stops.append(stop_name)
                except Exception as e:
                    print(f"[DEBUG] Error extracting leg1 stops: {e}")
                    leg1_stops = []
                
                leg2_stops = []
                try:
                    for _, row in leg2_path_segment.sort_values('stop_sequence').iterrows():
                        stop_id = str(row['stop_id'])
                        if stop_id in STOPS_BY_ID.index:
                            stop_name = str(STOPS_BY_ID.loc[stop_id, 'stop_name'])
                            if stop_name not in leg2_stops:
                                leg2_stops.append(stop_name)
                except Exception as e:
                    print(f"[DEBUG] Error extracting leg2 stops: {e}")
                    leg2_stops = []

                # Calculate distance and fare for transfer route
                total_distance_km = calculate_distance_for_route(polyline)
                total_fare_inr = calculate_fare_inr(total_distance_km)

                eta_minutes = max(0, int((dep1_eff - curr_seconds) / 60))
                transfer_options.append(
                    {
                        'bus_no': f"{trip1_route} → {trip2_route}",
                        'departure': str(leg1['departure_time']),
                        'eta': eta_minutes,
                        'start_stop': start_stop['stop_name'],
                        'walk_dist': round(start_stop['dist'] * 1000),
                        'distance_km': round(total_distance_km, 2),
                        'fare_inr': round(total_fare_inr, 2),
                        'start_coords': [float(start_stop['stop_lat']), float(start_stop['stop_lon'])],
                        'polyline': polyline,
                        'stops': leg1_stops + leg2_stops,
                        'is_transfer': True,
                        'transfer_stop': transfer_stop_id,
                    }
                )

                if len(transfer_options) >= MAX_RESULTS:
                    return {'options': sorted(transfer_options, key=lambda x: x['eta'])[:MAX_RESULTS]}

    return {'options': sorted(transfer_options, key=lambda x: x['eta'])[:MAX_RESULTS]}