import json, math
from collections import defaultdict

def haversine(c1, c2):
    R = 6371; r = lambda d: d * math.pi / 180
    dlat = r(c2[1]-c1[1]); dlon = r(c2[0]-c1[0])
    a = math.sin(dlat/2)**2 + math.cos(r(c1[1]))*math.cos(r(c2[1]))*math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))

with open('wiener_linien_stops.geojson') as f:
    all_stops = {feat['properties']['@id']: {
        'id':     feat['properties']['@id'],
        'name':   feat['properties'].get('name', ''),
        'coords': feat['geometry']['coordinates'],
    } for feat in json.load(f)['features']}

with open('wiener_linien_lines.geojson') as f:
    lines_data = json.load(f)

def snap(coord, path, step=4):
    # Phase 1: coarse scan at given step size
    best_i, best_d = 0, float('inf')
    for i in range(0, len(path), step):
        d = haversine(coord, path[i])
        if d < best_d: best_d, best_i = d, i
    # Phase 2: fine refinement in neighborhood (±step*2)
    for i in range(max(0, best_i-step*2), min(len(path), best_i+step*2+1)):
        d = haversine(coord, path[i])
        if d < best_d: best_d, best_i = d, i
    # Phase 3: full exact scan if result > 20m (HOME_SNAP_M threshold)
    # Catches cases where the closest point is far from the coarse best_i
    # (e.g. U3 Ottakring terminus where step-4 misses the exact closest point)
    if best_d > 0.020:
        for i in range(len(path)):
            d = haversine(coord, path[i])
            if d < best_d: best_d, best_i = d, i
    return best_i, best_d

def cum_dists(path):
    c = [0.0]
    for i in range(1, len(path)):
        c.append(c[-1] + haversine(path[i-1], path[i]))
    return c

HOME_SNAP_M = 20

# ── Step 1: Group OSM features by line ref ────────────────────────────────────
line_feats = defaultdict(list)
for feat in lines_data['features']:
    if feat['geometry']['type'] != 'MultiLineString': continue
    ref = feat['properties'].get('ref', '')
    if ref: line_feats[ref].append(feat)

# ── Step 2: Build raw directions per line ─────────────────────────────────────
# Each direction: { terminal_from, terminal_to, route_type, speed_kmh,
#                   stops: [{ id, name, coords, cum_km, snap_dist }] }
raw_directions = defaultdict(list)  # ref -> [direction, ...]

for ref, feats in sorted(line_feats.items()):
    route_type = feats[0]['properties'].get('route', 'tram')
    speed = 35 if route_type == 'subway' else 15

    for feat in feats:
        props = feat['properties']
        # Normalize terminal names: strip "Wien " prefix so that
        # "Wien Ottakring" and "Ottakring" are treated as the same terminal.
        # OSM data is inconsistent in its use of city prefix.
        def _norm(t):
            return t.replace('Wien ', '').replace('Wien-', '').strip()
        terminal_from = _norm(props.get('from', ''))
        terminal_to   = _norm(props.get('to',   ''))
        path = [c for seg in feat['geometry']['coordinates'] for c in seg]
        if len(path) < 2: continue
        cums = cum_dists(path)

        snapped = []
        for stop in all_stops.values():
            si, sd = snap(stop['coords'], path)
            if sd < 0.15:
                snapped.append({
                    'id':        stop['id'],
                    'name':      stop['name'],
                    'coords':    stop['coords'],
                    'cum_km':    round(cums[si], 4),
                    'snap_dist': round(sd * 1000, 2),
                    'path_idx':  si,
                })

        snapped.sort(key=lambda s: s['path_idx'])

        # ── Loop detection ────────────────────────────────────────────────────
        # Some OSM path geometries double back (e.g. Leopoldau→Oberlaa loops
        # back north after passing through the destination area). This causes
        # stops to snap to a high cum_km position (return leg) instead of the
        # correct low cum_km position (forward leg).
        #
        # Detection: if a stop's cum_km is > LOOP_RATIO x its straight-line
        # distance from path[0], the path has looped. Re-snap to only the
        # forward portion of the path (up to 2x the straight-line distance).
        #
        # Threshold 2.0 catches Ringstraße return-leg artefacts (ratio 2-40x)
        # while not affecting regular tram routes (ratio typically < 1.8 for
        # stops on the forward leg).
        #
        # NOTE: Do NOT use circular path detection (start≈end) — all tram
        # lines have loop termini with near-zero start-to-end distance, so
        # that approach incorrectly cuts valid second-half stops.

        LOOP_RATIO_THRESHOLD = 2.0
        loop_checked = []
        for s in snapped:
            geo_dist = haversine(s['coords'], path[0])
            if s['cum_km'] > 1.0 and geo_dist > 0.1:
                ratio = s['cum_km'] / geo_dist
                if ratio > LOOP_RATIO_THRESHOLD:
                    cutoff_cum = geo_dist * 2.0
                    cutoff_idx = next(
                        (i for i, c in enumerate(cums) if c > cutoff_cum),
                        len(path) // 2
                    )
                    if cutoff_idx > 10:
                        new_si, new_sd = snap(s['coords'], path[:cutoff_idx], step=4)
                        if new_sd < 0.15 and cums[new_si] < s['cum_km']:
                            s = {**s,
                                 'cum_km':    round(cums[new_si], 4),
                                 'snap_dist': round(new_sd * 1000, 2),
                                 'path_idx':  new_si}
            loop_checked.append(s)

        loop_checked.sort(key=lambda s: s['path_idx'])

        # Deduplicate by node ID (handles circular routes)
        seen_ids = set()
        id_deduped = []
        for s in loop_checked:
            if s['id'] not in seen_ids:
                seen_ids.add(s['id'])
                id_deduped.append(s)

        deduped = id_deduped

        if len(deduped) < 2: continue

        raw_directions[ref].append({
            'terminal_from': terminal_from,
            'terminal_to':   terminal_to,
            'route_type':    route_type,
            'speed_kmh':     speed,
            'stops':         deduped,
        })

    # Keep longest per terminal pair, remove short-turn subsets
    by_terminal = defaultdict(list)
    for d in raw_directions[ref]:
        by_terminal[(d['terminal_from'], d['terminal_to'])].append(d)
    candidates = [max(ds, key=lambda d: len(d['stops'])) for ds in by_terminal.values()]

    def is_short_turn(d, others):
        # A direction is a short-turn if its stop IDs are a strict subset of another
        # direction's stop IDs, UNLESS the two directions are a true bidirectional pair
        # (one goes A→B, the other goes B→A - terminals swap completely).
        # This preserves genuine opposite directions (e.g. U3 Ottakring↔Simmering)
        # while still removing partial short-turn variants (e.g. L11→Fickeysstraße).
        d_ids = set(s['id'] for s in d['stops'])
        for o in others:
            if o is d: continue
            if not (d_ids < set(s['id'] for s in o['stops'])): continue
            # d is a subset of o. Is this a true bidirectional pair?
            # True pair: d goes X→Y and o goes Y→X (terminals swap)
            is_true_opposite = (
                d['terminal_from'] == o['terminal_to'] and
                d['terminal_to']   == o['terminal_from']
            )
            if not is_true_opposite:
                return True  # genuine short-turn
        return False

    raw_directions[ref] = [d for d in candidates if not is_short_turn(d, candidates)]

# ── Step 3: Build stop_data.json first (needed for line_data consistency) ─────
# stop_data is built in Step 4 below, but we need the route assignments
# to build consistent line_data. We build stop_data first, then line_data.
# (Step 4 label kept below for clarity.)

# ── Step 3: Build line_data.json ──────────────────────────────────────────────
# Built AFTER stop_data routes are assigned, to ensure consistency:
# only include a node in line_data[ref][direction] if it has that route
# in stop_data. This prevents divergence between the two files.
# line_data is populated at the end of Step 4.
line_data = {}  # populated after stop_data

# ── Step 4: Build stop_data.json ──────────────────────────────────────────────
# Structure:
# {
#   "node/2260653592": {
#     "name":      "Reumannplatz",
#     "coords":    [...],
#     "stop_type": "subway",
#     "speed_kmh": 35,
#     "routes":    [{ "line": "U1", "direction": "Leopoldau" }, ...],
#     "opposite_ids": { "U1": "node/1862342812" }
#   }
# }

stop_data = {}

# Pass 1: build stop entries and routes list.
#
# The home-direction rule needs to handle two distinct cases:
#
# Case A - Terminal/turnaround (e.g. Oberlaa on U1):
#   Two platform nodes 12m apart. Both appear in BOTH directions at the
#   SAME cum_km (the line starts/ends there). Only one node belongs to each
#   direction. Fix: for same-name nodes at nearly identical cum_km on the
#   same direction, keep only the one with the minimum snap_dist.
#
# Case B - Mid-route opposite platforms (e.g. Windtenstraße on Line 1):
#   Two platform nodes ~13m apart. They appear in BOTH directions at
#   DIFFERENT cum_km positions (the tram passes both in sequence).
#   Both nodes legitimately serve both directions. Keep both.
#
# Rule: a node is home on a direction if snap_dist < HOME_SNAP_M AND
# no other node with the same name has a LOWER snap_dist at a SIMILAR
# cum_km position (within 50m path distance = 0.05 km) on this direction.

for ref, directions in raw_directions.items():
    route_type = directions[0]['route_type']
    speed      = directions[0]['speed_kmh']

    for d in directions:
        terminal = d['terminal_to']

        # Build a lookup: for each (name, approx_cum_km_bucket) -> best snap_dist
        # bucket = round cum_km to nearest 0.05km to group same-position nodes
        BUCKET = 0.05
        best_snap_at_pos = {}  # (name, bucket) -> min snap_dist
        for s in d['stops']:
            if s['snap_dist'] < HOME_SNAP_M:
                key = (s['name'], round(s['cum_km'] / BUCKET))
                if key not in best_snap_at_pos or s['snap_dist'] < best_snap_at_pos[key]:
                    best_snap_at_pos[key] = s['snap_dist']

        for s in d['stops']:
            sid = s['id']
            if sid not in stop_data:
                stop_data[sid] = {
                    'name':         s['name'],
                    'coords':       s['coords'],
                    'stop_type':    route_type,
                    'speed_kmh':    speed,
                    'routes':       [],
                    'opposite_ids': {},
                }
            if s['snap_dist'] >= HOME_SNAP_M:
                continue
            key = (s['name'], round(s['cum_km'] / BUCKET))
            # Home if this node has the minimum snap_dist at this position
            # (handles terminal case). Tolerance of 1m for float noise.
            if abs(s['snap_dist'] - best_snap_at_pos[key]) < 1.0:
                route_entry = {'line': ref, 'direction': terminal}
                if route_entry not in stop_data[sid]['routes']:
                    stop_data[sid]['routes'].append(route_entry)

# Pass 1b: remove true duplicate route assignments
# For same-name nodes within 150m that are assigned the EXACT SAME line+direction,
# keep only the one with the lower exact snap_dist for that direction.
# This handles step-snap inaccuracies (e.g. two nodes both getting 13m snap
# when one's true snap is 0m and the other's is 6m).
# SAFE: only touches nodes that share an identical route - never strips
# a route that the other node doesn't also have, so opposite platforms
# (which have complementary, non-overlapping routes) are never affected.

exact_snap = {}
for ref, directions in raw_directions.items():
    for d in directions:
        for s in d['stops']:
            key = (ref, d['terminal_to'])
            if s['id'] not in exact_snap:
                exact_snap[s['id']] = {}
            if key not in exact_snap[s['id']] or s['snap_dist'] < exact_snap[s['id']][key]:
                exact_snap[s['id']][key] = s['snap_dist']

from collections import defaultdict as _dd
import math as _math

def _hav2(c1, c2):
    R = 6371; r = lambda d: d * _math.pi / 180
    dlat = r(c2[1]-c1[1]); dlon = r(c2[0]-c1[0])
    a = _math.sin(dlat/2)**2 + _math.cos(r(c1[1]))*_math.cos(r(c2[1]))*_math.sin(dlon/2)**2
    return R * 2 * _math.asin(_math.sqrt(a))

by_name = _dd(list)
for nid, v in stop_data.items():
    by_name[v['name']].append(nid)

PROX_KM = 0.150
for name, node_ids in by_name.items():
    if len(node_ids) < 2: continue
    for i, na in enumerate(node_ids):
        va = stop_data[na]
        for nb in node_ids[i+1:]:
            vb = stop_data[nb]
            if _hav2(va['coords'], vb['coords']) >= PROX_KM: continue
            # Find routes BOTH nodes share (identical line+direction)
            routes_a = {(r['line'], r['direction']) for r in va['routes']}
            routes_b = {(r['line'], r['direction']) for r in vb['routes']}
            shared = routes_a & routes_b
            # Only deduplicate shared routes - never touch routes unique to one node
            for ref, direction in shared:
                snap_a = exact_snap.get(na, {}).get((ref, direction), 999)
                snap_b = exact_snap.get(nb, {}).get((ref, direction), 999)
                # Only strip when one node has STRICTLY lower snap (clear winner).
                # If snaps are equal, both nodes are equally valid - keep both.
                if snap_a < snap_b - 0.5:   # strictly lower by >0.5m
                    stop_data[nb]['routes'] = [r for r in stop_data[nb]['routes']
                                               if not (r['line']==ref and r['direction']==direction)]
                elif snap_b < snap_a - 0.5:  # strictly lower by >0.5m
                    stop_data[na]['routes'] = [r for r in stop_data[na]['routes']
                                               if not (r['line']==ref and r['direction']==direction)]
                # else: equal snap - keep both (they're at genuinely different locations)

# Pass 2: build opposite_ids per stop per line
# For each line, for each pair of opposite directions, find home nodes on each
# and pair them if same name, different ID, within 250m.
for ref, directions in raw_directions.items():
    for i, dir_a in enumerate(directions):
        for j, dir_b in enumerate(directions):
            if i >= j: continue
            if dir_a['terminal_to'] == dir_b['terminal_to']: continue

            home_a = {s['name']: s for s in dir_a['stops'] if s['snap_dist'] < HOME_SNAP_M}
            home_b = {s['name']: s for s in dir_b['stops'] if s['snap_dist'] < HOME_SNAP_M}

            for name in set(home_a) & set(home_b):
                s_a = home_a[name]
                s_b = home_b[name]
                if s_a['id'] == s_b['id']: continue
                if haversine(s_a['coords'], s_b['coords']) > 0.25: continue

                # s_a is on dir_a, its opposite (for line ref) is s_b
                if s_a['id'] in stop_data:
                    stop_data[s_a['id']]['opposite_ids'][ref] = s_b['id']
                if s_b['id'] in stop_data:
                    stop_data[s_b['id']]['opposite_ids'][ref] = s_a['id']

# ── Build line_data from stop_data routes for consistency ────────────────────
# For each node in stop_data, look up its cum_km and snap_dist in raw_directions
# and add it to the correct line_data direction. This guarantees that every
# node in stop_data.routes has a corresponding entry in line_data.

# Build lookup: (ref, direction) -> {node_id -> {cum_km, snap_dist}}
raw_lookup = {}  # (ref, terminal) -> {node_id: {cum_km, snap_dist}}
for ref, directions in raw_directions.items():
    for d in directions:
        key = (ref, d['terminal_to'])
        if key not in raw_lookup:
            raw_lookup[key] = {}
        # Merge stops from multiple features with the same terminal (don't overwrite)
        for s in d['stops']:
            if s['id'] not in raw_lookup[key]:
                raw_lookup[key][s['id']] = {'cum_km': s['cum_km'], 'snap_dist': s['snap_dist']}

# Build line metadata lookup
line_meta = {}
for ref, directions in raw_directions.items():
    line_meta[ref] = {
        'route_type': directions[0]['route_type'],
        'speed_kmh': directions[0]['speed_kmh'],
    }

for nid, sd_entry in stop_data.items():
    for route in sd_entry.get('routes', []):
        ref, direction = route['line'], route['direction']
        key = (ref, direction)
        if key not in raw_lookup:
            continue
        node_entry = raw_lookup[key].get(nid)
        if not node_entry:
            # Node is in stop_data.routes but not in raw_directions for this direction.
            # Find it in any raw direction for this line and use that cum_km.
            for d in raw_directions.get(ref, []):
                s = next((x for x in d['stops'] if x['id'] == nid), None)
                if s:
                    node_entry = {'cum_km': s['cum_km'], 'snap_dist': s['snap_dist']}
                    break
        if not node_entry:
            continue

        if ref not in line_data:
            meta = line_meta.get(ref, {'route_type': 'tram', 'speed_kmh': 15})
            line_data[ref] = {
                'route_type': meta['route_type'],
                'speed_kmh': meta['speed_kmh'],
                'directions': {}
            }
        if direction not in line_data[ref]['directions']:
            line_data[ref]['directions'][direction] = []
        line_data[ref]['directions'][direction].append({
            'id': nid,
            'cum_km': node_entry['cum_km'],
            'snap_dist': node_entry['snap_dist'],
        })

# Sort each direction's stops by cum_km
for ref, line in line_data.items():
    for direction in line['directions']:
        line['directions'][direction].sort(key=lambda e: e['cum_km'])

# ── Step 5: Validate ──────────────────────────────────────────────────────────
print(f"stop_data entries: {len(stop_data)}")
print(f"line_data lines:   {len(line_data)}")
print()
print("U1 directions in line_data:")
for terminal, stops in line_data.get('U1', {}).get('directions', {}).items():
    print(f"  → {terminal}: {len(stops)} stops  first={stops[0]['id']} last={stops[-1]['id']}")
print()
print("Reumannplatz in stop_data:")
for sid, v in stop_data.items():
    if v['name'] != 'Reumannplatz': continue
    print(f"  {sid}")
    print(f"    routes: {v['routes']}")
    print(f"    opposite_ids: {v['opposite_ids']}")
print()
print("Troststraße in stop_data:")
for sid, v in stop_data.items():
    if v['name'] != 'Troststraße': continue
    print(f"  {sid}")
    print(f"    routes: {v['routes']}")
    print(f"    opposite_ids: {v['opposite_ids']}")
print()
print("Gellertplatz in stop_data (shared-track Lines 6+11):")
for sid, v in stop_data.items():
    if v['name'] != 'Gellertplatz': continue
    print(f"  {sid}")
    print(f"    routes: {v['routes']}")
    print(f"    opposite_ids: {v['opposite_ids']}")
print()
print("=== Discrepancy log (opposite_ids with >1 unique value) ===")
disc_count = 0
for sid, v in stop_data.items():
    opp = v['opposite_ids']
    if len(set(opp.values())) > 1:
        disc_count += 1
        print(f"  {sid} ({v['name']}): {opp}")
print(f"Total discrepancies: {disc_count}")

# Save
with open('stop_data.json', 'w') as f:
    json.dump(stop_data, f, indent=2)
with open('line_data.json', 'w') as f:
    json.dump(line_data, f, indent=2)
print()
print("Saved stop_data.json and line_data.json")
