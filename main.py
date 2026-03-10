from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
import pandas as pd
import numpy as np
import os
import math
from typing import Optional
from datetime import datetime, timedelta

app = FastAPI()

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
STOP_ID_TO_NAME = STOPS_BY_ID["stop_name"].astype(str).to_dict()
TRIP_TO_ROUTE = TRIPS.drop_duplicates("trip_id").set_index("trip_id")["route_id"].astype(str).to_dict()
ROUTE_TO_SHORT = ROUTES.drop_duplicates("route_id").set_index("route_id")["route_short_name"].astype(str).to_dict()


def parse_stop_ids(value: Optional[str]) -> list[str]:
    if value is None:
        return []
    return [part.strip() for part in str(value).split(",") if part.strip()]


def time_to_seconds(time_value: str) -> int:
    hours, minutes, seconds = [int(part) for part in str(time_value).split(":")]
    return hours * 3600 + minutes * 60 + seconds


def seconds_to_hhmmss(total_seconds: int) -> str:
    total_seconds %= 24 * 3600
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def normalize_next_seconds(value_seconds: int, reference_seconds: int) -> int:
    while value_seconds < reference_seconds:
        value_seconds += 24 * 3600
    return value_seconds


def haversine_km_vectorized(lat1, lon1, lat2_series, lon2_series):
    lat1_rad = np.radians(lat1)
    lon1_rad = np.radians(lon1)
    lat2_rad = np.radians(lat2_series.to_numpy())
    lon2_rad = np.radians(lon2_series.to_numpy())

    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(dlon / 2) ** 2
    return 6371 * (2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a)))

@app.get("/")
def home(request: Request):
    stops_for_ui = STOPS_UNIQUE[["stop_id", "stop_name"]].sort_values("stop_name").to_dict("records")
    stop_map = {
        str(name): sorted(group["stop_id"].astype(str).tolist())
        for name, group in STOPS.groupby("stop_name", sort=False)
    }
    return templates.TemplateResponse("index.html", {
        "request": request, 
        "stops": stops_for_ui,
        "stop_map": stop_map,
        "current_time": clock.get_time()
    })

@app.post("/api/tick")
async def clock_tick(): return {"time": clock.tick(1)}

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
            # FIX: Look for buses departing today, prioritizing next 3
            valid = valid.copy()
            valid["dep_raw_seconds"] = valid["departure_time_s"].astype(str).map(time_to_seconds)
            valid["dep_seconds"] = valid["dep_raw_seconds"].apply(lambda value: normalize_next_seconds(int(value), curr_seconds))
            upcoming = valid.nsmallest(3, "dep_seconds")
            
            for _, trip in upcoming.iterrows():
                trip_id = str(trip['trip_id'])
                route_id = TRIP_TO_ROUTE.get(trip_id)
                bus_no = ROUTE_TO_SHORT.get(route_id, "N/A")
                
                # ETA Logic
                eta_minutes = max(0, int((int(trip["dep_seconds"]) - curr_seconds) / 60))
                
                segment = STOP_TIMES_BY_TRIP.get(trip_id)
                if segment is None or segment.empty:
                    continue
                seg_mask = (segment['stop_sequence'] >= trip['stop_sequence_s']) & (segment['stop_sequence'] <= trip['stop_sequence_e'])
                path = pd.merge(segment[seg_mask], STOPS, on='stop_id')

                if path.empty:
                    continue

                polyline = path[["stop_lat", "stop_lon"]].astype(float).values.tolist()

                all_options.append({
                    "bus_no": bus_no,
                    "departure": seconds_to_hhmmss(int(trip["dep_raw_seconds"])),
                    "eta": eta_minutes,
                    "start_stop": start_stop['stop_name'],
                    "walk_dist": round(start_stop['dist'] * 1000),
                    "start_coords": [float(start_stop['stop_lat']), float(start_stop['stop_lon'])],
                    "polyline": polyline
                })

    if all_options:
        return {"options": sorted(all_options, key=lambda x: x['departure'])[:5]}

    transfer_options = []
    seen_transfer_keys = set()
    for _, start_stop in near_stops.iterrows():
        s_id = str(start_stop["stop_id"])
        start_trips = STOP_TIMES_BY_STOP.get(s_id)
        if start_trips is None or start_trips.empty:
            continue

        first_leg = start_trips.copy()
        first_leg["dep1_raw_seconds"] = first_leg["departure_time"].astype(str).map(time_to_seconds)
        first_leg["dep1_seconds"] = first_leg["dep1_raw_seconds"].apply(lambda value: normalize_next_seconds(int(value), curr_seconds))
        first_leg = first_leg.nsmallest(4, "dep1_seconds")

        for _, leg1 in first_leg.iterrows():
            trip1_id = str(leg1["trip_id"])
            segment1 = STOP_TIMES_BY_TRIP.get(trip1_id)
            if segment1 is None or segment1.empty:
                continue

            transfer_points = segment1[segment1["stop_sequence"] > leg1["stop_sequence"]][
                ["stop_id", "stop_sequence", "arrival_time"]
            ].drop_duplicates(subset=["stop_id"]).head(18)

            for _, tp in transfer_points.iterrows():
                transfer_stop_id = str(tp["stop_id"])
                transfer_arrival_raw = time_to_seconds(str(tp["arrival_time"]))
                transfer_arrival_seconds = normalize_next_seconds(transfer_arrival_raw, int(leg1["dep1_seconds"]))

                transfer_trips = STOP_TIMES_BY_STOP.get(transfer_stop_id)
                if transfer_trips is None or transfer_trips.empty:
                    continue

                second_merge = pd.merge(transfer_trips, end_trips, on="trip_id", suffixes=("_x", "_e"))
                second_valid = second_merge[second_merge["stop_sequence_x"] < second_merge["stop_sequence_e"]]
                if second_valid.empty:
                    continue

                second_valid = second_valid.copy()
                second_valid["dep2_raw_seconds"] = second_valid["departure_time_x"].astype(str).map(time_to_seconds)
                second_valid["dep2_seconds"] = second_valid["dep2_raw_seconds"].apply(
                    lambda value: normalize_next_seconds(int(value), transfer_arrival_seconds)
                )
                if second_valid.empty:
                    continue

                leg2 = second_valid.nsmallest(1, "dep2_seconds").iloc[0]
                trip2_id = str(leg2["trip_id"])

                if trip1_id == trip2_id:
                    continue

                key = (trip1_id, trip2_id, s_id, transfer_stop_id)
                if key in seen_transfer_keys:
                    continue
                seen_transfer_keys.add(key)

                route1 = TRIP_TO_ROUTE.get(trip1_id)
                route2 = TRIP_TO_ROUTE.get(trip2_id)
                bus1 = ROUTE_TO_SHORT.get(route1, "N/A")
                bus2 = ROUTE_TO_SHORT.get(route2, "N/A")

                segment2 = STOP_TIMES_BY_TRIP.get(trip2_id)
                if segment2 is None or segment2.empty:
                    continue

                leg1_mask = (segment1["stop_sequence"] >= leg1["stop_sequence"]) & (segment1["stop_sequence"] <= tp["stop_sequence"])
                leg2_mask = (segment2["stop_sequence"] >= leg2["stop_sequence_x"]) & (segment2["stop_sequence"] <= leg2["stop_sequence_e"])
                path1 = pd.merge(segment1[leg1_mask], STOPS, on="stop_id")
                path2 = pd.merge(segment2[leg2_mask], STOPS, on="stop_id")
                if path1.empty or path2.empty:
                    continue

                polyline1 = path1[["stop_lat", "stop_lon"]].astype(float).values.tolist()
                polyline2 = path2[["stop_lat", "stop_lon"]].astype(float).values.tolist()
                polyline = polyline1 + polyline2[1:]

                transfer_options.append(
                    {
                        "bus_no": f"{bus1} ➜ {bus2}",
                        "departure": seconds_to_hhmmss(int(leg1["dep1_raw_seconds"])),
                        "eta": max(0, int((int(leg1["dep1_seconds"]) - curr_seconds) / 60)),
                        "start_stop": start_stop["stop_name"],
                        "walk_dist": round(start_stop["dist"] * 1000),
                        "start_coords": [float(start_stop["stop_lat"]), float(start_stop["stop_lon"])],
                        "transfer_stop": STOP_ID_TO_NAME.get(transfer_stop_id, transfer_stop_id),
                        "polyline": polyline,
                    }
                )

                if len(transfer_options) >= 5:
                    break

            if len(transfer_options) >= 5:
                break

        if len(transfer_options) >= 5:
            break

    if transfer_options:
        return {"options": sorted(transfer_options, key=lambda x: x['departure'])[:5]}

    untimed_options = []
    seen_untimed_keys = set()
    end_id_set = set(end_ids)

    for _, start_stop in near_stops.iterrows():
        s_id = str(start_stop["stop_id"])
        start_trips = STOP_TIMES_BY_STOP.get(s_id)
        if start_trips is None or start_trips.empty:
            continue

        first_leg_rows = start_trips.sort_values("departure_time").head(10)
        for _, leg1 in first_leg_rows.iterrows():
            trip1_id = str(leg1["trip_id"])
            segment1 = STOP_TIMES_BY_TRIP.get(trip1_id)
            if segment1 is None or segment1.empty:
                continue

            transfer_points = segment1[segment1["stop_sequence"] > leg1["stop_sequence"]][["stop_id", "stop_sequence"]]
            transfer_points = transfer_points.drop_duplicates(subset=["stop_id"]).head(12)

            for _, tp in transfer_points.iterrows():
                transfer_stop_id = str(tp["stop_id"])
                transfer_trips = STOP_TIMES_BY_STOP.get(transfer_stop_id)
                if transfer_trips is None or transfer_trips.empty:
                    continue

                for trip2_id in transfer_trips["trip_id"].astype(str).drop_duplicates().head(8):
                    if trip2_id == trip1_id:
                        continue

                    segment2 = STOP_TIMES_BY_TRIP.get(trip2_id)
                    if segment2 is None or segment2.empty:
                        continue

                    seq_transfer_rows = segment2[segment2["stop_id"] == transfer_stop_id]
                    if seq_transfer_rows.empty:
                        continue
                    seq_transfer = seq_transfer_rows["stop_sequence"].min()

                    end_rows = segment2[(segment2["stop_id"].isin(end_id_set)) & (segment2["stop_sequence"] > seq_transfer)]
                    if end_rows.empty:
                        continue

                    key = (trip1_id, str(trip2_id), s_id, transfer_stop_id)
                    if key in seen_untimed_keys:
                        continue
                    seen_untimed_keys.add(key)

                    route1 = TRIP_TO_ROUTE.get(trip1_id)
                    route2 = TRIP_TO_ROUTE.get(str(trip2_id))
                    bus1 = ROUTE_TO_SHORT.get(route1, "N/A")
                    bus2 = ROUTE_TO_SHORT.get(route2, "N/A")

                    leg1_mask = (segment1["stop_sequence"] >= leg1["stop_sequence"]) & (segment1["stop_sequence"] <= tp["stop_sequence"])
                    end_row = end_rows.nsmallest(1, "stop_sequence").iloc[0]
                    leg2_mask = (segment2["stop_sequence"] >= seq_transfer) & (segment2["stop_sequence"] <= end_row["stop_sequence"])

                    path1 = pd.merge(segment1[leg1_mask], STOPS, on="stop_id")
                    path2 = pd.merge(segment2[leg2_mask], STOPS, on="stop_id")
                    if path1.empty or path2.empty:
                        continue

                    polyline1 = path1[["stop_lat", "stop_lon"]].astype(float).values.tolist()
                    polyline2 = path2[["stop_lat", "stop_lon"]].astype(float).values.tolist()
                    polyline = polyline1 + polyline2[1:]

                    dep1_raw = time_to_seconds(str(leg1["departure_time"]))
                    dep1_norm = normalize_next_seconds(dep1_raw, curr_seconds)

                    untimed_options.append(
                        {
                            "bus_no": f"{bus1} ➜ {bus2}",
                            "departure": seconds_to_hhmmss(dep1_raw),
                            "eta": max(0, int((dep1_norm - curr_seconds) / 60)),
                            "start_stop": start_stop["stop_name"],
                            "walk_dist": round(start_stop["dist"] * 1000),
                            "start_coords": [float(start_stop["stop_lat"]), float(start_stop["stop_lon"])],
                            "transfer_stop": STOP_ID_TO_NAME.get(transfer_stop_id, transfer_stop_id),
                            "polyline": polyline,
                        }
                    )

                    if len(untimed_options) >= 5:
                        break

                if len(untimed_options) >= 5:
                    break

            if len(untimed_options) >= 5:
                break

        if len(untimed_options) >= 5:
            break

    if untimed_options:
        return {"options": sorted(untimed_options, key=lambda x: x['departure'])[:5]}

    return {"options": []}