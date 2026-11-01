import json, math
from collections import defaultdict

def haversine(c1, c2):
    R = 6371; r = lambda d: d * math.pi / 180
    dlat = r(c2[1]-c1[1]); dlon = r(c2[0]-c1[0])
    a = math.sin(dlat/2)**2 + math.cos(r(c1[1]))*math.cos(r(c2[1]))*math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))

with open('wiener_linien_stops.geojson') as f:
    all_stops = [{'id': feat['properties']['@id'],
                  'name': feat['properties'].get('name',''),
                  'coords': feat['geometry']['coordinates']}
                 for feat in json.load(f)['features']]

with open('wiener_linien_lines.geojson') as f:
    lines_data = json.load(f)

def snap(coord, path, step=4):
    best_i, best_d = 0, float('inf')
    for i in range(0, len(path), step):
        d = haversine(coord, path[i])
        if d < best_d: best_d, best_i = d, i
    for i in range(max(0, best_i-step*2), min(len(path), best_i+step*2+1)):
        d = haversine(coord, path[i])
        if d < best_d: best_d, best_i = d, i
    return best_i, best_d

def cum_dists(path):
    c = [0.0]
    for i in range(1, len(path)):
        c.append(c[-1] + haversine(path[i-1], path[i]))
    return c

# Group OSM features by line ref
line_feats = defaultdict(list)
for feat in lines_data['features']:
    if feat['geometry']['type'] != 'MultiLineString': continue
    ref = feat['properties'].get('ref', '')
    if ref: line_feats[ref].append(feat)

lines_out = {}

for ref, feats in sorted(line_feats.items()):
    route_type = feats[0]['properties'].get('route', 'tram')
    speed = 35 if route_type == 'subway' else 15
    directions = []

    for feat in feats:
        props = feat['properties']
        path = [c for seg in feat['geometry']['coordinates'] for c in seg]
        if len(path) < 2: continue
        cums = cum_dists(path)

        # Snap every stop to this path
        snapped = []
        for stop in all_stops:
            si, sd = snap(stop['coords'], path)
            if sd < 0.15:   # 150m inclusion threshold
                snapped.append({
                    'id':       stop['id'],
                    'name':     stop['name'],
                    'coords':   stop['coords'],
                    'cum_km':   round(cums[si], 4),
                    'path_idx': si,
                    'snap_dist': round(sd * 1000, 2),  # metres
                })

        snapped.sort(key=lambda s: s['path_idx'])

        # Deduplicate by node ID only (handles circular routes revisiting same node)
        # Do NOT deduplicate by name - that drops legitimate opposite-platform nodes
        seen_ids = set()
        deduped = []
        for s in snapped:
            if s['id'] not in seen_ids:
                seen_ids.add(s['id'])
                deduped.append(s)

        if len(deduped) < 2:
            continue

        # Use OSM from/to as terminal labels - these are authoritative direction names
        # matching what appears on the front of the vehicle.
        # The snapped stop sequence determines path order; OSM from/to names the direction.
        # (Don't use last snapped stop name - OSM path geometry may be truncated.)
        terminal_from = props.get('from', deduped[0]['name'])
        terminal_to   = props.get('to',   deduped[-1]['name'])

        directions.append({
            'terminal_from': terminal_from,
            'terminal_to':   terminal_to,
            'stops': [{
                'id':        s['id'],
                'name':      s['name'],
                'coords':    s['coords'],
                'cum_km':    s['cum_km'],
                'snap_dist': s['snap_dist'],
            } for s in deduped]
        })

    if not directions:
        continue

    # Keep longest direction per terminal pair (handles short-turn variants)
    by_terminal = defaultdict(list)
    for d in directions:
        key = (d['terminal_from'], d['terminal_to'])
        by_terminal[key].append(d)
    candidates = [max(ds, key=lambda d: len(d['stops'])) for ds in by_terminal.values()]

    # Remove short-turn variants: directions whose stop IDs are a strict subset
    # of a longer direction's stop IDs on the same line
    def is_short_turn(d, others):
        d_ids = set(s['id'] for s in d['stops'])
        return any(d_ids < set(s['id'] for s in o['stops'])
                   for o in others if o is not d)

    unique_dirs = [d for d in candidates if not is_short_turn(d, candidates)]
    if not unique_dirs:
        continue

    lines_out[ref] = {
        'route_type': route_type,
        'speed_kmh':  speed,
        'directions': unique_dirs,
    }

# Build partner map:
# For each line, find stop nodes with the same name, different IDs,
# on opposite directions, within 200m. These are opposite-platform pairs.
# Only pair nodes that are home (snap_dist < 20m) on their respective directions.
partners = {}
HOME_SNAP_M = 20

for ref, line in lines_out.items():
    dirs = line['directions']
    for i, dir_a in enumerate(dirs):
        for j, dir_b in enumerate(dirs):
            if i >= j: continue
            if dir_a['terminal_to'] == dir_b['terminal_to']: continue

            # Only home nodes participate in pairing
            home_a = {s['name']: s for s in dir_a['stops'] if s['snap_dist'] < HOME_SNAP_M}
            home_b = {s['name']: s for s in dir_b['stops'] if s['snap_dist'] < HOME_SNAP_M}

            for name in set(home_a) & set(home_b):
                s_a = home_a[name]
                s_b = home_b[name]
                if s_a['id'] == s_b['id']: continue  # same node = single platform
                if haversine(s_a['coords'], s_b['coords']) > 0.25: continue  # >250m = different station

                partners[s_a['id']] = {
                    'partner_id':       s_b['id'],
                    'partner_terminal': dir_b['terminal_to'],
                    'line_ref':         ref,
                }
                partners[s_b['id']] = {
                    'partner_id':       s_a['id'],
                    'partner_terminal': dir_a['terminal_to'],
                    'line_ref':         ref,
                }

# Validate
print(f"Lines: {len(lines_out)}")
print(f"Partner pairs: {len(partners)//2}")
print()

print("U1 directions:")
for d in lines_out.get('U1', {}).get('directions', []):
    print(f"  {d['terminal_from']} → {d['terminal_to']}  ({len(d['stops'])} stops)")
    print(f"    first: {d['stops'][0]['name']}  last: {d['stops'][-1]['name']}")

print()
print("Troststraße partners:")
for d in lines_out.get('U1', {}).get('directions', []):
    for s in d['stops']:
        if s['name'] == 'Troststraße':
            p = partners.get(s['id'])
            print(f"  {d['terminal_from']}→{d['terminal_to']}: {s['id']} snap={s['snap_dist']}m partner→{p['partner_terminal'] if p else None}")

with open('line_stops.json', 'w') as f:
    json.dump({'lines': lines_out, 'partners': partners}, f)
print()
print("Saved line_stops.json")
