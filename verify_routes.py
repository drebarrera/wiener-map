import json
from collections import defaultdict

with open('/home/claude/line_data.json') as f:
    line_data = json.load(f)
with open('/home/claude/stop_data.json') as f:
    stop_data = json.load(f)

BUCKET = 0.05  # must match generate_stop_data.py

output = []

for line_ref in sorted(line_data.keys()):
    line = line_data[line_ref]
    route_type = line['route_type']
    speed = line['speed_kmh']

    for direction, entries in sorted(line['directions'].items()):
        output.append(f"\n{'='*72}")
        output.append(f"Line {line_ref} → {direction}  [{route_type}, {speed} km/h, {len(entries)} stops]")
        output.append(f"{'='*72}")
        output.append(f"{'#':<4} {'Stop Name':<35} {'cum_km':>7} {'snap':>6}  Home  Routes assigned in stop_data")
        output.append(f"{'-'*4} {'-'*35} {'-'*7} {'-'*6}  {'-'*4}  {'-'*45}")

        issues = []

        # Build position bucket -> best snap_dist (same logic as generation script)
        best_snap_at_pos = {}
        for e in entries:
            if e['snap_dist'] < 20:
                key = (stop_data.get(e['id'], {}).get('name', ''), round(e['cum_km'] / BUCKET))
                if key not in best_snap_at_pos or e['snap_dist'] < best_snap_at_pos[key]:
                    best_snap_at_pos[key] = e['snap_dist']

        for i, entry in enumerate(entries):
            nid = entry['id']
            cum = entry['cum_km']
            snap = entry['snap_dist']
            sd = stop_data.get(nid)

            if sd is None:
                output.append(f"{i+1:<4} {'[MISSING from stop_data]':<35} {cum:>7.3f} {snap:>6.1f}  ???   ???")
                issues.append(f"  ! {nid} missing from stop_data")
                continue

            name = sd['name']
            routes = sd.get('routes', [])
            this_route = {'line': line_ref, 'direction': direction}
            in_routes = this_route in routes
            opp = sd.get('opposite_ids', {})

            # Is this node home at this position on this direction?
            key = (name, round(cum / BUCKET))
            best_snap = best_snap_at_pos.get(key, float('inf'))
            is_home = snap < 20 and abs(snap - best_snap) < 1.0

            home_marker = "YES" if is_home else "no"

            routes_str = ', '.join(f"L{r['line']}→{r['direction'][:15]}" for r in routes) if routes else "(none)"
            opp_str = f"  opp→{list(opp.values())}" if opp else ""

            # Flag real anomalies only:
            # 1. Node is home but route not assigned
            # 2. Node is not home but route IS assigned (shouldn't happen)
            flag = ""
            if is_home and not in_routes:
                flag = "  ⚠ HOME but missing from routes"
                issues.append(f"  ! {name} ({nid}) snap={snap:.1f}m is home but not in stop_data routes")
            elif not is_home and in_routes:
                flag = "  ⚠ non-home but in routes"
                issues.append(f"  ! {name} ({nid}) snap={snap:.1f}m is non-home but appears in stop_data routes")

            output.append(f"{i+1:<4} {name:<35} {cum:>7.3f} {snap:>6.1f}  {home_marker:<4}  {routes_str}{opp_str}{flag}")

        if issues:
            output.append(f"\n  ISSUES IN THIS DIRECTION:")
            output.extend(issues)

# Summary
output.append(f"\n\n{'='*72}")
output.append("SUMMARY")
output.append(f"{'='*72}")

total_issues = sum(1 for line in output if line.strip().startswith('!'))
output.append(f"Lines:           {len(line_data)}")
output.append(f"Directions:      {sum(len(l['directions']) for l in line_data.values())}")
output.append(f"Stop data nodes: {len(stop_data)}")
output.append(f"Flagged issues:  {total_issues}")

no_routes = [(k, v) for k, v in stop_data.items() if not v.get('routes')]
output.append(f"Nodes with no routes assigned: {len(no_routes)}")
if no_routes[:8]:
    for k, v in no_routes[:8]:
        output.append(f"  {v['name']} ({k})")

text = '\n'.join(output)
with open('/home/claude/route_verification.txt', 'w') as f:
    f.write(text)
print(f"Written ({len(text):,} chars)")

# ── Additional checks for popup rendering correctness ─────────────────────────

def simulate_stop_results(stop_data, line_data, dest_coords):
    """Replicate computeAllStopData logic in Python for validation."""
    WALK_SPEED = 4.5 / 1.2
    MAX_ALIGHT_WALK = 25
    import math
    def hav(c1, c2):
        R = 6371; r = lambda d: d * math.pi / 180
        dlat = r(c2[1]-c1[1]); dlon = r(c2[0]-c1[0])
        a = math.sin(dlat/2)**2 + math.cos(r(c1[1]))*math.cos(r(c2[1]))*math.sin(dlon/2)**2
        return R * 2 * math.asin(math.sqrt(a))

    results = {}
    for osmId, sd in stop_data.items():
        valid, wrong = [], []
        for route in sd.get('routes', []):
            ref, direction = route['line'], route['direction']
            li = line_data.get(ref, {})
            ordered = li.get('directions', {}).get(direction, [])
            if not ordered: continue
            home = [e for e in ordered if e['snap_dist'] < 20]
            if not home: continue
            alight_e = min(home, key=lambda e: hav(stop_data[e['id']]['coords'], dest_coords)
                          if e['id'] in stop_data else float('inf'))
            if alight_e['id'] not in stop_data: continue
            alight_s = stop_data[alight_e['id']]
            walk = hav(alight_s['coords'], dest_coords) / WALK_SPEED * 60
            if walk > MAX_ALIGHT_WALK: continue
            board = next((e for e in ordered if e['id'] == osmId), None)
            if not board: continue
            is_past = board['cum_km'] > alight_e['cum_km'] + 0.01
            if is_past:
                wrong.append({'line': ref, 'direction': direction,
                              'alight': alight_s['name'], 'walk': round(walk,1)})
            else:
                transit = 0 if board['id'] == alight_e['id'] else \
                    (alight_e['cum_km'] - board['cum_km']) / li['speed_kmh'] * 60
                valid.append({'line': ref, 'direction': direction,
                             'transit': round(transit,1), 'walk': round(walk,1),
                             'total': round(transit+walk,1), 'alight': alight_s['name']})
        valid.sort(key=lambda x: x['total'])
        if valid or wrong:
            results[osmId] = {
                'name': sd['name'], 'best': valid[0] if valid else None,
                'allOptions': valid, 'wrongDirRoutes': wrong,
                'opposite_ids': sd.get('opposite_ids', {})
            }
    return results


CEU = [16.387847, 48.173449]
stop_results = simulate_stop_results(stop_data, line_data, CEU)

popup_issues = []

for osmId, result in stop_results.items():
    name = result['name']
    opp_ids = result['opposite_ids']

    # ── Check 1: For each wrong-dir route, verify opposite node has a route
    #    for the SAME LINE pointing toward dest (not just any best direction)
    for wd in result['wrongDirRoutes']:
        line = wd['line']
        opp_id = opp_ids.get(line)

        if not opp_id:
            # No opposite_ids for this line - will use fallback
            # Check if fallback finds a different node with same name
            fallback_id = next((
                k for k in stop_results
                if k != osmId
                and stop_data.get(k, {}).get('name') == name
                and stop_results[k].get('best') is not None
            ), None)

            if fallback_id:
                fallback_best = stop_results[fallback_id]['best']
                popup_issues.append(
                    f"  FALLBACK OPP: {name} ({osmId}) wrong-dir L{line} has no opposite_id "
                    f"→ fallback finds {fallback_id}, shows dir='{fallback_best['direction']}'"
                )
            else:
                popup_issues.append(
                    f"  NO OPP FOUND: {name} ({osmId}) wrong-dir L{line} has no opposite_id "
                    f"and no fallback node → will show 'no opposite platform'"
                )
        else:
            # Has opposite_id - check that opposite node has a route for THIS line
            opp_sd = stop_data.get(opp_id, {})
            opp_result = stop_results.get(opp_id, {})
            opp_routes_for_line = [r for r in opp_sd.get('routes', []) if r['line'] == line]

            if not opp_routes_for_line:
                popup_issues.append(
                    f"  OPP MISSING LINE: {name} ({osmId}) wrong-dir L{line} → "
                    f"opp={opp_id} has no route for L{line} → popup will use overall best dir"
                )
            else:
                # The correct terminal to show = the direction on the opposite node for this line
                correct_dir = opp_routes_for_line[0]['direction']
                # What the popup will actually show = oppBest.direction (overall best)
                opp_best = opp_result.get('best')
                shown_dir = opp_best['direction'] if opp_best else '(none)'

                if shown_dir != correct_dir:
                    popup_issues.append(
                        f"  WRONG TERMINAL: {name} ({osmId}) wrong-dir L{line} "
                        f"→ opp={opp_id} correct_dir='{correct_dir}' "
                        f"but popup shows oppBest.dir='{shown_dir}'"
                    )

    # ── Check 2: Valid-best node with same-name no-opp neighbor
    #    (neighbor will incorrectly trigger fallback warning instead of showing own data)
    if result['best']:
        same_name_wrong_dir_no_opp = [
            k for k in stop_results
            if k != osmId
            and stop_data.get(k, {}).get('name') == name
            and not stop_results[k].get('best')
            and stop_results[k].get('wrongDirRoutes')
            and not stop_results[k].get('opposite_ids')
        ]
        for neighbor_id in same_name_wrong_dir_no_opp:
            # This neighbor has no valid routes, no opposite_ids, will fall back to osmId
            popup_issues.append(
                f"  FALLBACK COLLISION: {name} ({neighbor_id}) has no valid routes + "
                f"no opposite_ids → fallback finds valid node {osmId} "
                f"(correct, but valid node {osmId} also matches this pattern "
                f"meaning neighbor shows data correctly)"
            )


output2 = ["\n\n" + "="*72, "POPUP RENDERING CHECKS", "="*72]
output2.append(f"Issues found: {len(popup_issues)}")
output2.append("")
output2.extend(popup_issues)

with open('/home/claude/route_verification.txt', 'a') as f:
    f.write('\n'.join(output2))

print(f"Popup checks appended. Issues found: {len(popup_issues)}")

# ── Check 3: Both nodes at same station show identical wrong-dir popup ─────────
# Symptom: two nodes with same name, both wrong-dir only, both pointing to
# the same opposite node. Should differ - one should be valid.

output3 = ["\n\n" + "="*72, "CHECK 3: BOTH NODES SHOWING IDENTICAL WRONG-DIR (e.g. Praterstern)", "="*72]

# Group stopResults by station name
from collections import defaultdict
by_name = defaultdict(list)
for osmId, result in stop_results.items():
    by_name[result['name']].append((osmId, result))

identical_wrong_dir = []
for name, nodes in by_name.items():
    if len(nodes) < 2: continue
    # Find nodes that are all-wrong-dir (no valid best)
    wrong_only = [(nid, r) for nid, r in nodes if not r['best'] and r['wrongDirRoutes']]
    if len(wrong_only) < 2: continue
    # Check if they all point to the same opposite node
    opp_targets = set()
    for nid, r in wrong_only:
        for wd in r['wrongDirRoutes']:
            opp_id = r['opposite_ids'].get(wd['line'])
            if not opp_id:
                # fallback - find same-name node with valid best + same line
                opp_id = next((
                    k for k in stop_results
                    if k != nid
                    and stop_data.get(k, {}).get('name') == name
                    and stop_results[k].get('allOptions')
                    and any(o['line'] == wd['line'] for o in stop_results[k]['allOptions'])
                ), 'NONE')
            opp_targets.add(opp_id)
    if len(opp_targets) <= 1:
        identical_wrong_dir.append({
            'name': name,
            'nodes': [(nid, r['opposite_ids'], [w['line']+'→'+w['direction'] for w in r['wrongDirRoutes']]) for nid, r in wrong_only],
            'opp_targets': opp_targets
        })

output3.append(f"Cases found: {len(identical_wrong_dir)}\n")
for case in identical_wrong_dir[:30]:
    output3.append(f"  {case['name']}  opp_targets={case['opp_targets']}")
    for nid, opp_ids, wds in case['nodes']:
        output3.append(f"    {nid}  opp_ids={opp_ids}  wrong_dir={wds}")


# ── Check 4: Wrong-dir nodes with no opposite found (Widholzgasse pattern) ────
output4 = ["\n\n" + "="*72, "CHECK 4: WRONG-DIR NODES WITH NO OPPOSITE FOUND (e.g. Widholzgasse)", "="*72]

no_opp_wrong_dir = []
for osmId, result in stop_results.items():
    if result['best']: continue
    if not result['wrongDirRoutes']: continue
    name = result['name']
    for wd in result['wrongDirRoutes']:
        # Check opposite_ids first
        opp_id = result['opposite_ids'].get(wd['line'])
        if opp_id:
            continue
        # Check fallback (same-name node with valid route for same line)
        fallback = next((
            k for k in stop_results
            if k != osmId
            and stop_data.get(k, {}).get('name') == name
            and stop_results[k].get('allOptions')
            and any(o['line'] == wd['line'] for o in stop_results[k]['allOptions'])
        ), None)
        if not fallback:
            no_opp_wrong_dir.append({
                'osmId': osmId, 'name': name,
                'line': wd['line'], 'direction': wd['direction'],
                'opp_ids': result['opposite_ids'],
            })

output4.append(f"Cases found: {len(no_opp_wrong_dir)}\n")
# Deduplicate by name for readability
seen_names = set()
for case in no_opp_wrong_dir:
    key = f"{case['name']}|{case['osmId']}"
    if key in seen_names: continue
    seen_names.add(key)
    output4.append(f"  {case['name']} ({case['osmId']})  L{case['line']}→{case['direction']}  opp_ids={case['opp_ids']}")

with open('/home/claude/route_verification.txt', 'a') as f:
    f.write('\n'.join(output3 + output4))

print(f"Check 3 (identical wrong-dir pairs): {len(identical_wrong_dir)}")
print(f"Check 4 (no opposite found): {len(no_opp_wrong_dir)} raw, {len(seen_names)} unique nodes")

# ── Check 5: Multiple home nodes on the SAME direction at the same station ────
# Symptom: two nodes with the same name, both home (snap<20m) on the same
# line+direction, appearing within 150m of each other physically.
# This causes duplicate popup entries with identical line/direction labels.
# Legitimate exceptions: stops that are genuinely far apart (>80m) like
# Oper/Karlsplatz ring road stops.

output5 = ["\n\n" + "="*72,
           "CHECK 5: DUPLICATE HOME NODES ON SAME LINE+DIRECTION (e.g. Oper/Karlsplatz)",
           "="*72]

import math as _math

def _hav(c1, c2):
    R = 6371; r = lambda d: d * _math.pi / 180
    dlat = r(c2[1]-c1[1]); dlon = r(c2[0]-c1[0])
    a = _math.sin(dlat/2)**2 + _math.cos(r(c1[1]))*_math.cos(r(c2[1]))*_math.sin(dlon/2)**2
    return R * 2 * _math.asin(_math.sqrt(a))

SAME_DIR_DIST_THRESHOLD = 80  # metres - below this is a likely duplicate

dup_cases = []

for ref, line in line_data.items():
    for direction, entries in line['directions'].items():
        # Find all home nodes (snap < 20m) grouped by name
        home_by_name = defaultdict(list)
        for e in entries:
            if e['snap_dist'] < 20:
                sd_entry = stop_data.get(e['id'])
                if sd_entry:
                    home_by_name[sd_entry['name']].append({
                        'id': e['id'],
                        'cum_km': e['cum_km'],
                        'snap_dist': e['snap_dist'],
                        'coords': sd_entry['coords'],
                    })

        for name, nodes in home_by_name.items():
            if len(nodes) < 2:
                continue
            # Check all pairs
            for i, n_a in enumerate(nodes):
                for n_b in nodes[i+1:]:
                    dist = _hav(n_a['coords'], n_b['coords']) * 1000
                    cum_diff = abs(n_a['cum_km'] - n_b['cum_km']) * 1000  # metres along path
                    if dist < SAME_DIR_DIST_THRESHOLD:
                        dup_cases.append({
                            'name': name,
                            'line': ref,
                            'direction': direction,
                            'node_a': n_a['id'],
                            'snap_a': n_a['snap_dist'],
                            'cum_a': n_a['cum_km'],
                            'node_b': n_b['id'],
                            'snap_b': n_b['snap_dist'],
                            'cum_b': n_b['cum_km'],
                            'physical_dist_m': round(dist, 1),
                            'cum_diff_m': round(cum_diff, 1),
                        })

output5.append(f"Cases found: {len(dup_cases)}\n")
for c in dup_cases:
    output5.append(
        f"  {c['name']}  L{c['line']}→{c['direction'][:20]}"
        f"  dist={c['physical_dist_m']}m  cum_diff={c['cum_diff_m']}m"
    )
    output5.append(
        f"    {c['node_a']}  snap={c['snap_a']}m  cum={c['cum_a']}"
    )
    output5.append(
        f"    {c['node_b']}  snap={c['snap_b']}m  cum={c['cum_b']}"
    )

with open('/home/claude/route_verification.txt', 'a') as f:
    f.write('\n'.join(output5))

print(f"Check 5 (duplicate home nodes same direction): {len(dup_cases)}")

# ── Check 6: Data consistency issues causing "No lines serve this stop" ────────
# Two sub-checks:
# 6a: nodes in stop_data.routes but missing from line_data (inconsistency)
# 6b: nodes with empty routes that have a same-name neighbor within 150m with routes
#     (stripped by proximity dedup - should have the opposite direction)

import math as _m6
def _h6(c1,c2):
    R=6371;r=lambda d:d*_m6.pi/180;dlat=r(c2[1]-c1[1]);dlon=r(c2[0]-c1[0])
    a=_m6.sin(dlat/2)**2+_m6.cos(r(c1[1]))*_m6.cos(r(c2[1]))*_m6.sin(dlon/2)**2
    return R*2*_m6.asin(_m6.sqrt(a))

output6 = ["\n\n" + "="*72,
           "CHECK 6: CONSISTENCY ISSUES CAUSING 'NO LINES SERVE THIS STOP'",
           "="*72]

# 6a: routes in stop_data missing from line_data
in_line_data = set()
for ref, line in line_data.items():
    for direction, entries in line['directions'].items():
        for e in entries:
            in_line_data.add((e['id'], ref, direction))

missing_from_ld = []
for nid, v in stop_data.items():
    for route in v.get('routes', []):
        ref, direction = route['line'], route['direction']
        if (nid, ref, direction) not in in_line_data:
            missing_from_ld.append(f"  6a: {v['name']} ({nid})  L{ref}→{direction[:20]}  [in routes, not in line_data]")

# 6b: nodes stripped to empty routes that have neighbor with routes
from collections import defaultdict as _dd6
_by_name = _dd6(list)
for nid, v in stop_data.items():
    _by_name[v['name']].append((nid, v))

stripped_nodes = []
for nid, v in stop_data.items():
    if v.get('routes'): continue
    neighbors = [(k,w) for k,w in _by_name[v['name']] if k != nid]
    close = [(k,w) for k,w in neighbors
             if w.get('routes') and _h6(v['coords'], w['coords']) < 0.15]
    if close:
        neighbor_dirs = [r['line']+'→'+r['direction'][:12] for k,w in close for r in w.get('routes',[])]
        stripped_nodes.append(f"  6b: {v['name']} ({nid})  empty routes, neighbor has: {neighbor_dirs[:3]}")

total = len(missing_from_ld) + len(stripped_nodes)
output6.append(f"Total issues: {total}  (6a: {len(missing_from_ld)}, 6b: {len(stripped_nodes)})\n")
output6.extend(missing_from_ld)
output6.extend(stripped_nodes[:40])
if len(stripped_nodes) > 40:
    output6.append(f"  ... and {len(stripped_nodes)-40} more 6b cases")

with open('/home/claude/route_verification.txt', 'a') as f:
    f.write('\n'.join(output6))

print(f"Check 6a (in routes, missing from line_data): {len(missing_from_ld)}")
print(f"Check 6b (stripped to empty routes): {len(stripped_nodes)}")

# ── Check 6: Nodes in stop_data with empty routes ─────────────────────────────
# These nodes were snapped within 150m of a line but ended up with no route
# assignments. They show "No lines serve this stop" even though they sit on
# a tracked line. Caused by Pass 1b proximity dedup being too aggressive
# (removing routes from opposite-platform nodes).

output6 = ["\n\n" + "="*72,
           "CHECK 6: STOP_DATA NODES WITH EMPTY ROUTES",
           "="*72]

import math as _m6

def _hav6(c1, c2):
    R = 6371; r = lambda d: d * _m6.pi / 180
    dlat = r(c2[1]-c1[1]); dlon = r(c2[0]-c1[0])
    a = _m6.sin(dlat/2)**2 + _m6.cos(r(c1[1]))*_m6.cos(r(c2[1]))*_m6.sin(dlon/2)**2
    return R * 2 * _m6.asin(_m6.sqrt(a))

empty_route_nodes = [(nid, v) for nid, v in stop_data.items() if not v.get('routes')]

# For each empty-route node, find nearby nodes with routes (within 200m)
# to understand if this is an opposite-platform situation
detailed = []
for nid, v in empty_route_nodes:
    nearby_with_routes = []
    for other_id, other_v in stop_data.items():
        if other_id == nid: continue
        if not other_v.get('routes'): continue
        dist = _hav6(v['coords'], other_v['coords']) * 1000
        if dist < 200:
            nearby_with_routes.append({
                'id': other_id,
                'name': other_v['name'],
                'dist_m': round(dist, 1),
                'routes': other_v['routes'],
            })
    nearby_with_routes.sort(key=lambda x: x['dist_m'])
    detailed.append({'nid': nid, 'name': v['name'], 'coords': v['coords'],
                     'nearby': nearby_with_routes})

output6.append(f"Empty-route nodes: {len(empty_route_nodes)}\n")
for d in detailed[:50]:
    output6.append(f"  {d['nid']} ({d['name']})")
    for nb in d['nearby'][:3]:
        routes_str = ', '.join(f"L{r['line']}→{r['direction'][:12]}" for r in nb['routes'])
        output6.append(f"    {nb['dist_m']}m away: {nb['id']} ({nb['name']}) [{routes_str}]")
if len(detailed) > 50:
    output6.append(f"  ... and {len(detailed)-50} more")

# ── Check 7: Nodes with routes in stop_data but absent from line_data ─────────
# stop_data says "board here for L6→Geiereckstraße" but line_data doesn't
# have this node in that direction. The JS compute can't find the cum_km
# needed to calculate transit time, so the route is silently skipped.

output7 = ["\n\n" + "="*72,
           "CHECK 7: STOP_DATA ROUTES NOT IN LINE_DATA",
           "="*72]

missing_from_line_data = []
for nid, v in stop_data.items():
    for route in v.get('routes', []):
        ref, direction = route['line'], route['direction']
        entries = line_data.get(ref, {}).get('directions', {}).get(direction, [])
        if not any(e['id'] == nid for e in entries):
            missing_from_line_data.append({
                'nid': nid, 'name': v['name'],
                'line': ref, 'direction': direction,
            })

output7.append(f"Routes in stop_data missing from line_data: {len(missing_from_line_data)}\n")
for m in missing_from_line_data[:50]:
    output7.append(f"  {m['nid']} ({m['name']})  L{m['line']}→{m['direction']}")
if len(missing_from_line_data) > 50:
    output7.append(f"  ... and {len(missing_from_line_data)-50} more")

with open('/home/claude/route_verification.txt', 'a') as f:
    f.write('\n'.join(output6 + output7))

print(f"Check 6 (empty-route nodes): {len(empty_route_nodes)}")
print(f"Check 7 (routes missing from line_data): {len(missing_from_line_data)}")
