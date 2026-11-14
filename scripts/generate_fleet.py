#!/usr/bin/env python3
"""Generate the fleet CSVs (routes, waypoints, vessels) used by the globe.

Routes are computed between real ports with the `searoute` package, which routes over a global
maritime network (canals, straits and traffic lanes), so ships follow real sea lanes instead of
cutting across land. All vessels are fictional.

    pip install searoute
    python scripts/generate_fleet.py        # rewrites data/shipping_routes.csv, route_waypoints.csv, vessels.csv

The output is committed, so you only need to run this if you want to change the routes or fleet.
"""
import csv
import math
import random
from pathlib import Path

import searoute as sr

DATA = Path(__file__).resolve().parent.parent / "data"
R_NM = 3440.065

# Ports as (lon, lat)
PORTS = {
    "Shanghai": (121.95, 30.62), "Rotterdam": (4.05, 51.95), "Ras Tanura": (50.16, 26.64),
    "Qingdao": (120.3, 36.0), "Chiba": (140.1, 35.55), "Jebel Ali": (55.03, 25.0),
    "Fujairah": (56.4, 25.17), "Singapore": (103.85, 1.25), "Mumbai": (72.95, 18.95),
    "Mundra": (69.7, 22.74), "Chennai": (80.3, 13.1), "Long Beach": (-118.2, 33.74),
    "Valdez": (-146.35, 61.1), "New York": (-74.0, 40.55), "Houston": (-94.7, 29.3),
    "Santos": (-46.3, -24.0), "Port Hedland": (118.6, -20.3), "Bonny": (7.15, 4.4),
    "Yokohama": (139.75, 35.35), "Busan": (129.05, 35.05),
}

# (origin, destination, number of ships, vessel type mix)
LANES = [
    ("Shanghai", "Rotterdam", 8, [("container_ship", 5), ("crude_tanker", 1), ("bulk_carrier", 2)]),
    ("Ras Tanura", "Chiba", 7, [("crude_tanker", 7)]),
    ("Ras Tanura", "Rotterdam", 5, [("crude_tanker", 5)]),
    ("Fujairah", "Singapore", 5, [("crude_tanker", 3), ("product_tanker", 2)]),
    ("Jebel Ali", "Mumbai", 4, [("container_ship", 2), ("product_tanker", 2)]),
    ("Mundra", "Rotterdam", 4, [("container_ship", 2), ("bulk_carrier", 1), ("product_tanker", 1)]),
    ("Chennai", "Singapore", 3, [("container_ship", 2), ("product_tanker", 1)]),
    ("Bonny", "Mumbai", 4, [("crude_tanker", 4)]),
    ("Yokohama", "Long Beach", 5, [("container_ship", 4), ("product_tanker", 1)]),
    ("Busan", "Long Beach", 4, [("container_ship", 4)]),
    ("Valdez", "Long Beach", 4, [("crude_tanker", 4)]),
    ("Rotterdam", "New York", 5, [("container_ship", 3), ("product_tanker", 2)]),
    ("Houston", "Rotterdam", 5, [("crude_tanker", 4), ("product_tanker", 1)]),
    ("Santos", "Rotterdam", 5, [("bulk_carrier", 3), ("crude_tanker", 2)]),
    ("Port Hedland", "Qingdao", 5, [("bulk_carrier", 5)]),
    ("Singapore", "Rotterdam", 4, [("container_ship", 2), ("crude_tanker", 2)]),
]

SPEED = {"container_ship": (16, 20), "crude_tanker": (12, 15), "product_tanker": (13, 16), "bulk_carrier": (11, 14)}
ADJ = ("Silver Northern Pacific Golden Crimson Azure Iron Coral Amber Ivory Cobalt Misty Bright Swift Noble Lunar "
       "Solar Emerald Granite Polar Velvet Copper Jade Scarlet Harbor Distant Quiet Rising Wandering Hidden").split()
NOUN = ("Crest Voyager Horizon Spirit Meridian Tide Mariner Dawn Star Wave Pioneer Venture Drift Beacon Current "
        "Falcon Anchor Pearl Compass Gannet Albatross Kestrel Lantern").split()
STALL = ["Port congestion", "Awaiting orders", "Heavy traffic", "Bad weather", "Canal queue"]
LEAK = ["Hull crack", "Cargo valve failure", "Corroded fuel line"]


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R_NM * math.asin(min(1, math.sqrt(h)))


def interp(a, b, t):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d = hav(a, b) / R_NM
    if d == 0:
        return a
    A, B = math.sin((1 - t) * d) / math.sin(d), math.sin(t * d) / math.sin(d)
    x = A * math.cos(la1) * math.cos(lo1) + B * math.cos(la2) * math.cos(lo2)
    y = A * math.cos(la1) * math.sin(lo1) + B * math.cos(la2) * math.sin(lo2)
    z = A * math.sin(la1) + B * math.sin(la2)
    return (math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x)))


def position(pts, p):
    segs = [hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    d = p * sum(segs)
    for i, s in enumerate(segs):
        if d <= s or i == len(segs) - 1:
            return interp(pts[i], pts[i + 1], min(1, d / s) if s else 0)
        d -= s


def rdp(pts, eps):
    """Douglas-Peucker simplification in degrees (iterative)."""
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i], pts[j]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-12
        best, idx = 0, None
        for k in range(i + 1, j):
            d = abs(dy * (pts[k][0] - x1) - dx * (pts[k][1] - y1)) / norm
            if d > best:
                best, idx = d, k
        if idx is not None and best > eps:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def unwrap(pts):
    """Keep consecutive longitudes continuous across the antimeridian for simplification."""
    out, off = [pts[0]], 0.0
    for (la, lo), (_, plo) in zip(pts[1:], pts[:-1]):
        if lo - plo > 180: off -= 360
        elif lo - plo < -180: off += 360
        out.append((la, lo + off))
    return out


def wrap(pts):
    return [(la, ((lo + 180) % 360) - 180) for la, lo in pts]


def main():
    rng = random.Random(2026)
    routes, waypoints, vessels, names = [], [], [], set()
    vid = 1
    for rid, (o, d, count, mix) in enumerate(LANES, 1):
        feat = sr.searoute(list(PORTS[o]), list(PORTS[d]), units="naut", append_orig_dest=True)
        raw = [(lat, lon) for lon, lat in feat.geometry["coordinates"]]
        pts = wrap(rdp(unwrap(raw), 0.04))
        routes.append((rid, f"{o} - {d}"))
        waypoints += [(rid, i, round(la, 4), round(lo, 4)) for i, (la, lo) in enumerate(pts, 1)]
        print(f"{o} - {d}: {len(raw)} raw -> {len(pts)} points, {feat.properties['length']:.0f} nm")

        types = [t for t, k in mix for _ in range(k)]
        rng.shuffle(types)
        for t in types[:count]:
            while True:
                name = f"{rng.choice(ADJ)} {rng.choice(NOUN)}"
                if name not in names:
                    names.add(name)
                    break
            p = round(rng.uniform(0.03, 0.97), 4)
            lat, lon = position(pts, p)
            lo_s, hi_s = SPEED[t]
            vessels.append([vid, name, t, rid, rng.choice([1, -1]), round(rng.uniform(lo_s, hi_s), 1), p,
                            round(lat, 4), round(lon, 4), "running", "", 0])
            vid += 1

    tankers = [v for v in vessels if "tanker" in v[2]]
    for v in rng.sample(tankers, 3):
        v[9], v[10], v[11] = "leaking", rng.choice(LEAK), rng.randint(300, 4000)
    for v in rng.sample([v for v in vessels if v[9] == "running"], 6):
        v[9], v[10] = "stalled", rng.choice(STALL)

    with open(DATA / "shipping_routes.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["route_id", "name"]); w.writerows(routes)
    with open(DATA / "route_waypoints.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["route_id", "seq", "latitude", "longitude"]); w.writerows(waypoints)
    with open(DATA / "vessels.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vessel_id", "name", "vessel_type", "route_id", "direction", "speed_knots", "progress",
                    "latitude", "longitude", "status", "status_reason", "leaked_barrels"])
        w.writerows(vessels)
    print(f"{len(routes)} routes, {len(waypoints)} waypoints, {len(vessels)} vessels")


if __name__ == "__main__":
    main()
