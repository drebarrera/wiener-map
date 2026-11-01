import { useState, useEffect, useRef, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import * as turf from '@turf/turf'
import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_DEST = { coords: [16.387847, 48.173449], label: 'CEU, Quellenstraße 51, 1100 Wien' }
const WALK_SPEED_KMH = 4.5 / 1.2 / 1.2  // 1.2x walk time scaling
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const MAX_ALIGHT_WALK_MIN = 25
const HOME_SNAP_M = 20

const PIN_COLORS = [
  { id:'yellow', fill:'#eab308', stroke:'#713f12', label:'Yellow' },
  { id:'red',    fill:'#ef4444', stroke:'#7f1d1d', label:'Red'    },
  { id:'green',  fill:'#22c55e', stroke:'#14532d', label:'Green'  },
  { id:'blue',   fill:'#3b82f6', stroke:'#1e3a5f', label:'Blue'   },
  { id:'purple', fill:'#a855f7', stroke:'#4a1d96', label:'Purple' },
  { id:'pink',   fill:'#ec4899', stroke:'#831843', label:'Pink'   },
]

const DISTRICT_NAMES = {
  '1':'Innere Stadt','2':'Leopoldstadt','3':'Landstraße','4':'Wieden',
  '5':'Margareten','6':'Mariahilf','7':'Neubau','8':'Josefstadt',
  '9':'Alsergrund','10':'Favoriten','11':'Simmering','12':'Meidling',
  '13':'Hietzing','14':'Penzing','15':'Rudolfsheim','16':'Ottakring',
  '17':'Hernals','18':'Währing','19':'Döbling','20':'Brigittenau',
  '21':'Floridsdorf','22':'Donaustadt','23':'Liesing',
}

const DEFAULT_SENTIMENT = {
  '1':1,'2':1,'3':1,'4':1,'5':0,'6':1,'7':1,'8':0,'9':1,
  '10':-1,'11':-1,'12':0,'13':0,'14':-1,'15':0,'16':-1,
  '17':-1,'18':0,'19':1,'20':0,'21':-1,'22':-1,'23':-1,
}

const LINE_COLORS = {
  U1:'#E3000F', U2:'#A862A4', U3:'#EF7C00', U4:'#319F49', U6:'#9D6830', tram:'#C8102E',
}

function getLineColor(ref, routeType) {
  if (LINE_COLORS[ref]) return LINE_COLORS[ref]
  if (routeType === 'tram') return LINE_COLORS.tram
  return '#888'
}

function haversine(c1, c2) {
  const R = 6371, r = d => d * Math.PI / 180
  const dlat = r(c2[1]-c1[1]), dlon = r(c2[0]-c1[0])
  const a = Math.sin(dlat/2)**2 + Math.cos(r(c1[1]))*Math.cos(r(c2[1]))*Math.sin(dlon/2)**2
  return R * 2 * Math.asin(Math.sqrt(a))
}

// ── Core computation ──────────────────────────────────────────────────────────
// For a single stop node + destination, compute the best transit option across
// all its home routes. Returns an array of route results sorted by total time.
//
// Each result: { line, direction, transit_min, walk_min, alight_id, alight_name, total }
//
// "wrong direction" = stop appears in line_data for that direction but is PAST
// the alight stop (cum_km > alight cum_km). These get flagged, not circles.
function computeRouteOptions(osmId, stopInfo, lineData, destCoords) {
  const results = []
  const wrongDir = []   // routes heading away from dest

  for (const { line, direction } of (stopInfo.routes || [])) {
    const lineInfo = lineData[line]
    if (!lineInfo) continue
    const ordered = lineInfo.directions[direction]
    if (!ordered) continue

    // Find alight stop = home stop closest to dest on this direction
    let bestDist = Infinity, primaryAlight = null
    for (const entry of ordered) {
      if (entry.snap_dist >= HOME_SNAP_M) continue
      const d = haversine(stopInfo.coords, destCoords)  // placeholder - need stop coords
      // We need coords from stopData - passed in via stopInfo for the alight
    }

    // Recalculate properly: iterate ordered stops, look up coords from stopData
    // But we don't have all stop coords here - we need stopData passed in
    // Handle this in the caller with full stopData available
    void 0
  }
  return { results, wrongDir }
}

// Full computation with stopData and lineData available
function computeAllStopData(stopData, lineData, destCoords) {
  // results[osmId] = { best, allOptions, wrongDirRoutes }
  // best = { line, direction, transit_min, walk_min, alight_id, alight_name, total, coords }
  // allOptions = array of above sorted by total (for "Also:" display)
  // wrongDirRoutes = routes where stop is past alight

  const output = {}

  for (const [osmId, stopInfo] of Object.entries(stopData)) {
    if (!stopInfo.routes?.length) continue

    const validOptions = []
    const wrongDirOptions = []

    for (const { line, direction } of stopInfo.routes) {
      const lineInfo = lineData[line]
      if (!lineInfo) continue
      const ordered = lineInfo.directions[direction]
      if (!ordered) continue

      // Find alight = home stop in this direction closest to dest
      let bestDist = Infinity, alightEntry = null
      for (const entry of ordered) {
        if (entry.snap_dist >= HOME_SNAP_M) continue
        const sd = stopData[entry.id]
        if (!sd) continue
        const d = haversine(sd.coords, destCoords)
        if (d < bestDist) { bestDist = d; alightEntry = entry }
      }
      if (!alightEntry) continue

      const alightStop = stopData[alightEntry.id]
      if (!alightStop) continue
      const walkMin = haversine(alightStop.coords, destCoords) / WALK_SPEED_KMH * 60
      if (walkMin > MAX_ALIGHT_WALK_MIN) continue

      // Find this stop in the ordered list
      const boardEntry = ordered.find(e => e.id === osmId)
      if (!boardEntry) continue

      if (boardEntry.cum_km > alightEntry.cum_km + 0.01) {
        // Past the alight stop - wrong direction
        wrongDirOptions.push({ line, direction,
          alight_id: alightEntry.id, alight_name: alightStop.name,
          walk_min: Math.round(walkMin * 10) / 10,
        })
        continue
      }

      const transitMin = boardEntry.id === alightEntry.id
        ? 0
        : (alightEntry.cum_km - boardEntry.cum_km) / (lineInfo.speed_kmh / 1.2) * 60  // 1.2x transit time scaling

      if (transitMin < 0) continue
      const total = transitMin + walkMin

      validOptions.push({
        line, direction,
        transit_min: Math.round(transitMin * 10) / 10,
        walk_min:    Math.round(walkMin * 10) / 10,
        alight_id:   alightEntry.id,
        alight_name: alightStop.name,
        total:       Math.round(total * 10) / 10,
        coords:      stopInfo.coords,
      })
    }

    if (!validOptions.length && !wrongDirOptions.length) continue

    validOptions.sort((a, b) => a.total - b.total)

    output[osmId] = {
      name:          stopInfo.name,
      coords:        stopInfo.coords,
      stop_type:     stopInfo.stop_type,
      best:          validOptions[0] || null,
      allOptions:    validOptions,
      wrongDirRoutes: wrongDirOptions,
      opposite_ids:  stopInfo.opposite_ids || {},
    }
  }
  return output
}

// ── GeoSearch ─────────────────────────────────────────────────────────────────
function GeoSearch({ placeholder, icon, iconColor, onSelect, onClear, onRegisterClear, initialLabel, label }) {
  const [query, setQuery] = useState(initialLabel || '')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)
  const wrapRef = useRef(null)

  useEffect(() => { if (label !== undefined) setQuery(label) }, [label])

  const clear = useCallback(() => {
    setQuery(''); setResults([]); setOpen(false)
    onClear?.()
  }, [onClear])

  // Register clear fn with parent on mount and whenever it changes
  useEffect(() => { onRegisterClear?.(clear) }, [clear, onRegisterClear])

  const handleChange = (e) => {
    const val = e.target.value
    setQuery(val); setOpen(false); setResults([])
    clearTimeout(debounceRef.current)
    if (!val) { onClear?.(); return }
    if (val.length < 3) return
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(val)}.json?proximity=16.387847,48.173449&country=AT&access_token=${MAPBOX_TOKEN}&limit=5`
        setResults((await fetch(url).then(r => r.json())).features || [])
        setOpen(true)
      } catch (e) { console.error('Geocoding:', e) }
      finally { setLoading(false) }
    }, 700)
  }

  const handleSelect = (f) => {
    onSelect({ coords: f.center, label: f.place_name })
    setQuery(f.place_name); setResults([]); setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <div className="geo-wrap" ref={wrapRef}>
      <div className="geo-box">
        <span className="geo-pin" style={{ color: iconColor || '#94a3b8' }}>{icon || '📍'}</span>
        <input ref={inputRef} className="geo-input" type="text"
          placeholder={placeholder || 'Search…'} value={query}
          onChange={handleChange}
          onFocus={() => { if (results.length) setOpen(true) }}
          onBlur={() => setTimeout(() => setOpen(false), 160)}
        />
        {loading && <span className="geo-spin">⟳</span>}
      </div>
      {open && results.length > 0 && (
        <ul className="geo-results">
          {results.map(f => (
            <li key={f.id} onMouseDown={() => handleSelect(f)}>
              <span className="res-name">{f.text}</span>
              <span className="res-sub">{f.place_name.split(',').slice(1).join(',').trim()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── District checkboxes ───────────────────────────────────────────────────────
function DistrictPanel({ sentiment, onChange }) {
  return (
    <div className="dp-grid">
      {Object.entries(DISTRICT_NAMES).map(([num, name]) => {
        const val = sentiment[num] ?? 0
        return (
          <label key={num} className="dp-row" title={name}>
            <span className="dp-num">{num}</span>
            <span className="dp-name">{name}</span>
            <div className="dp-checks">
              <input type="checkbox" checked={val === 1} onChange={() => onChange(num, val === 1 ? 0 : 1)} />
              <span className="dp-plus">+</span>
              <input type="checkbox" checked={val === -1} onChange={() => onChange(num, val === -1 ? 0 : -1)} />
              <span className="dp-minus">−</span>
            </div>
          </label>
        )
      })}
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const destMarkerRef = useRef(null)
  const poiMarkerRef = useRef(null)
  const popupRef = useRef(null)
  const poiGeoSearchRef = useRef(null)

  const [dest, setDest] = useState(DEFAULT_DEST)
  const [timeBudget, setTimeBudget] = useState(30)
  const [mapReady, setMapReady] = useState(false)
  const [rawData, setRawData] = useState(null)       // { stopData, lineData }
  const [stopResults, setStopResults] = useState(null) // computed per dest
  const [clickedStop, setClickedStop] = useState(null)
  const [sentiment, setSentiment] = useState(DEFAULT_SENTIMENT)
  const [showDistricts, setShowDistricts] = useState(false)
  const [savedPins, setSavedPins] = useState([])       // { id, coords, label, name, colorId, link, marker }
  const [pendingPoi, setPendingPoi] = useState(null)
  const [editingPinId, setEditingPinId] = useState(null)
  const [lightbox, setLightbox] = useState(null)       // null | { mode: 'export'|'import', text: string }

  // Load both data files once
  useEffect(() => {
    Promise.all([
      fetch('/stop_data.json').then(r => r.json()),
      fetch('/line_data.json').then(r => r.json()),
    ]).then(([stopData, lineData]) => setRawData({ stopData, lineData }))
  }, [])

  // Recompute when destination or data changes
  useEffect(() => {
    if (!rawData) return
    setStopResults(computeAllStopData(rawData.stopData, rawData.lineData, dest.coords))
  }, [rawData, dest])

  // Move dest marker
  useEffect(() => {
    if (!mapReady) return
    destMarkerRef.current?.setLngLat(dest.coords)
    map.current?.flyTo({ center: dest.coords, zoom: 12, duration: 800 })
  }, [dest, mapReady])

  // District colors
  useEffect(() => {
    if (!mapReady || !map.current?.getSource('districts')) return
    const expr = ['case']
    for (const [num, val] of Object.entries(sentiment)) {
      if (val === 1)  expr.push(['==', ['get','districtNum'], num], '#4ade80')
      if (val === -1) expr.push(['==', ['get','districtNum'], num], '#f87171')
    }
    expr.push('#94a3b8')
    map.current.setPaintProperty('districts-fill', 'fill-color', expr)
    map.current.setPaintProperty('districts-border', 'line-color', expr)
  }, [sentiment, mapReady])

  // Init map
  useEffect(() => {
    if (map.current) return
    if (!MAPBOX_TOKEN || MAPBOX_TOKEN === 'pk.your_token_here') { console.error('❌ No Mapbox token'); return }
    mapboxgl.accessToken = MAPBOX_TOKEN

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: DEFAULT_DEST.coords, zoom: 12,
    })
    map.current.on('error', e => console.error('Mapbox:', e.error))

    map.current.on('load', async () => {
      const [stops, lines, districts] = await Promise.all([
        fetch('/wiener_linien_stops.geojson').then(r => r.json()),
        fetch('/wiener_linien_lines.geojson').then(r => r.json()),
        fetch('/vienna_districts.geojson').then(r => r.json()).catch(() => null),
      ])

      // Walking circles (bottom)
      map.current.addSource('walking-circles', { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
      map.current.addLayer({ id:'walking-circles-fill', type:'fill', source:'walking-circles',
        paint:{ 'fill-color':'#60a5fa', 'fill-opacity':0.06 } })
      map.current.addLayer({ id:'walking-circles-border', type:'line', source:'walking-circles',
        paint:{ 'line-color':'#60a5fa', 'line-width':1, 'line-opacity':0.3 } })

      // Districts
      if (districts) {
        const sp = districts.features[0]?.properties || {}
        const numKey = ['ref','BEZNR','BEZ','district'].find(k => sp[k] !== undefined && /^\d+$/.test(String(sp[k])))
        const nameKey = ['name','NAMEG','NAMETEXT','NAME','BEZNAME'].find(k => sp[k] !== undefined)
        districts.features = districts.features.map(f => ({
          ...f, properties: { ...f.properties,
            districtNum: String(f.properties[numKey]||'').replace(/\D/g,''),
            districtName: f.properties[nameKey] || '',
          }
        }))
        map.current.addSource('districts', { type:'geojson', data:districts })
        map.current.addLayer({ id:'districts-fill', type:'fill', source:'districts',
          paint:{ 'fill-color':'#94a3b8', 'fill-opacity':0.15 } })
        map.current.addLayer({ id:'districts-border', type:'line', source:'districts',
          paint:{ 'line-color':'#94a3b8', 'line-width':1.5, 'line-opacity':0.6 } })
        map.current.addLayer({ id:'districts-label', type:'symbol', source:'districts',
          layout:{ 'text-field':['get','districtName'], 'text-size':11,
            'text-font':['DIN Pro Medium','Arial Unicode MS Regular'] },
          paint:{ 'text-color':'rgba(255,255,255,0.5)', 'text-halo-color':'rgba(0,0,0,0.8)', 'text-halo-width':1 } })
      }

      // Transit lines
      const seenRefs = new Set()
      const dedupedLines = { type:'FeatureCollection', features: lines.features
        .filter(f => { const r = f.properties.ref; if (!r || seenRefs.has(r)) return false; seenRefs.add(r); return true })
        .map(f => ({ ...f, properties: { ...f.properties, lineColor: getLineColor(f.properties.ref, f.properties.route) } }))
      }
      map.current.addSource('transit-lines', { type:'geojson', data:dedupedLines })
      map.current.addLayer({ id:'transit-lines-layer', type:'line', source:'transit-lines',
        paint:{ 'line-color':['get','lineColor'],
          'line-width':['case',['==',['get','route'],'subway'],3,1.5], 'line-opacity':0.85 } })

      // Transit stops
      map.current.addSource('transit-stops', { type:'geojson', data:stops })
      map.current.addLayer({ id:'transit-stops-layer', type:'circle', source:'transit-stops',
        paint:{ 'circle-radius':['interpolate',['linear'],['zoom'],10,2,14,5],
          'circle-color':'#fff', 'circle-stroke-color':'#555', 'circle-stroke-width':1, 'circle-opacity':0.85 } })

      // Dest pin
      const destEl = document.createElement('div')
      destEl.className = 'dest-pin'
      destEl.innerHTML = `<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z" fill="#60a5fa" stroke="#1e3a5f" stroke-width="1.5"/>
        <circle cx="12" cy="8" r="3" fill="white"/>
      </svg>`
      destMarkerRef.current = new mapboxgl.Marker({ element:destEl, anchor:'bottom', draggable:true })
        .setLngLat(DEFAULT_DEST.coords).addTo(map.current)
      destMarkerRef.current.on('dragend', () => {
        const { lng, lat } = destMarkerRef.current.getLngLat()
        setDest({ coords:[lng,lat], label:`${lat.toFixed(5)}, ${lng.toFixed(5)}` })
      })

      map.current.on('mouseenter', 'transit-stops-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'transit-stops-layer', () => { map.current.getCanvas().style.cursor = '' })
      map.current.on('click', 'transit-stops-layer', e => {
        setClickedStop({ osmId: e.features[0].properties['@id'], stopName: e.features[0].properties.name || '', lngLat: e.lngLat })
      })

      setMapReady(true)
    })

    return () => { map.current?.remove(); map.current = null }
  }, [])

  // Update walking circles - only valid (non-wrong-direction) stops
  useEffect(() => {
    if (!mapReady || !stopResults) return
    const circles = []
    for (const result of Object.values(stopResults)) {
      if (!result.best) continue
      const remaining = timeBudget - result.best.total
      if (remaining <= 0) continue
      const radiusKm = (remaining / 60) * WALK_SPEED_KMH
      if (radiusKm < 0.05) continue
      try {
        const circle = turf.circle(result.coords, radiusKm, { steps:32, units:'kilometers' })
        circles.push(circle)
      } catch {}
    }
    map.current?.getSource('walking-circles')?.setData({ type:'FeatureCollection', features:circles })
  }, [mapReady, stopResults, timeBudget])

  // Popup
  useEffect(() => {
    if (!clickedStop || !mapReady) return
    if (popupRef.current) { popupRef.current.remove(); popupRef.current = null }

    const { osmId, stopName, lngLat } = clickedStop
    const result = stopResults?.[osmId]
    const rawStop = rawData?.stopData?.[osmId]

    let html

    // Helper: find the opposite node ID for a wrong-direction route.
    // Uses opposite_ids[line] if available; fallback finds a same-name node
    // that has a valid route for the SAME LINE (not just any valid best).
    const findOppId = (wd, name) => {
      const oppId = result?.opposite_ids?.[wd.line]
      if (oppId) return oppId
      // Fallback: find another node with same name that has a route for this specific line
      return Object.keys(stopResults).find(id => {
        if (id === osmId) return false
        if (rawData?.stopData?.[id]?.name !== name) return false
        const oppRoutes = rawData?.stopData?.[id]?.routes || []
        // Must have a valid (non-wrong-dir) route for the same line
        const oppResult = stopResults[id]
        return oppRoutes.some(r => r.line === wd.line) &&
               oppResult?.allOptions?.some(o => o.line === wd.line)
      }) || null
    }

    // Lines that already have a valid route on this node - suppress redundant warnings
    const validLines = new Set((result?.allOptions || []).map(o => o.line))

    // Helper: render transit block from a result object
    const transitBlock = (b) => {
      const total = b.total
      const remaining = timeBudget - total
      const withinBudget = remaining > 0
      const radius = withinBudget ? ((remaining / 60) * WALK_SPEED_KMH * 1000).toFixed(0) : 0
      const status = withinBudget
        ? `<span style="color:#60a5fa">⭕ ${radius}m walk radius</span>`
        : `<span style="color:#f87171">Outside ${timeBudget} min budget</span>`
      return `🚇 <strong>${b.transit_min.toFixed(0)}</strong> min transit
        🚶 <strong>${b.walk_min.toFixed(0)}</strong> min walk from ${b.line}, ${b.alight_name}<br/>
        <span style="color:#cbd5e1">Total: <strong>${total.toFixed(0)} min</strong></span><br/>
        ${status}`
    }

    const name = result?.name || rawStop?.name || stopName

    if (result?.best) {
      // ── Normal case: has at least one valid route ──────────────────────────
      const b = result.best

      // Primary line label
      let linesHtml = `<span style="color:#94a3b8">Line ${b.line} → ${b.direction}</span>`

      // Other valid routes at same stop
      const others = result.allOptions.slice(1)
      if (others.length) {
        linesHtml += `<br/><span style="color:#64748b;font-size:11px">Also: ${
          others.map(o => `Line ${o.line} → ${o.direction} (${o.total.toFixed(0)} min)`).join(', ')
        }</span>`
      }

      // Wrong-direction warning for any wrong-dir routes at this stop.
      // Suppress if this line already has a valid route on this node - the
      // valid route is already shown; the wrong-dir one is a different direction
      // of the same line and doesn't need a separate warning.
      let wrongHtml = ''
      for (const wd of (result.wrongDirRoutes || [])) {
        if (validLines.has(wd.line)) continue  // line already shown as valid
        const oppId = findOppId(wd, name)
        if (!oppId) continue
        // Show the direction the opposite node serves for THIS SPECIFIC LINE.
        // Don't use oppBest.direction (overall best) - that may be a different line.
        const oppRoutes = rawData?.stopData?.[oppId]?.routes || []
        const oppRouteForLine = oppRoutes.find(r => r.line === wd.line)
        const oppDir = oppRouteForLine?.direction
          || stopResults[oppId]?.best?.direction
          || oppRoutes[0]?.direction || ''
        wrongHtml += `<br/><span style="color:#fb923c;font-size:11px">
          ⚠ <a href="#" class="opp-link" data-id="${oppId}" data-name="${name}"
             style="color:#fb923c;text-decoration:none;font-size:11px">
            Line ${wd.line}: board opposite platform → ${oppDir}
          </a></span>`
      }

      html = `<strong>${name}</strong><br/>${linesHtml}${wrongHtml}
        <div style="margin-top:6px">${transitBlock(b)}</div>`

    } else if (result?.wrongDirRoutes?.length) {
      // ── All routes wrong direction: show data from opposite node ──────────
      const wd = result.wrongDirRoutes[0]
      const oppId = findOppId(wd, name)
      const oppResult = oppId ? stopResults[oppId] : null
      const oppBest = oppResult?.best

      // Show the correct-direction data (from opposite node) as the reference times
      let dataHtml = ''
      if (oppBest) {
        dataHtml = `<div style="margin-top:6px;color:#94a3b8;font-size:11px">If boarding correct platform:</div>
          <div style="margin-top:2px">${transitBlock(oppBest)}</div>`
      }

      // Warning link
      let warnHtml = ''
      if (oppId) {
        // Use the direction the opposite node serves for the specific wrong-dir line
        const oppRoutes = rawData?.stopData?.[oppId]?.routes || []
        const oppRouteForLine = oppRoutes.find(r => r.line === wd.line)
        const oppDir = oppRouteForLine?.direction
          || oppResult?.best?.direction
          || oppRoutes[0]?.direction || ''
        warnHtml = `<span style="color:#fb923c">
          ⚠ <a href="#" class="opp-link" data-id="${oppId}" data-name="${name}"
             style="color:#fb923c;text-decoration:none">
            Board from the opposite platform → ${oppDir}
          </a></span>`
      } else {
        warnHtml = `<span style="color:#64748b;font-size:11px">Heading away from destination — no opposite platform found</span>`
      }

      html = `<strong>${name}</strong><br/>${warnHtml}${dataHtml}`

    } else if (rawStop) {
      html = `<strong>${name}</strong><br/>
        <span style="color:#94a3b8;font-size:11px">No lines serve this stop within ${MAX_ALIGHT_WALK_MIN} min walk of destination</span>`
    } else {
      html = `<strong>${stopName || 'Stop'}</strong><br/>
        <span style="color:#94a3b8;font-size:11px">Bus or regional stop — not on a tracked line</span>`
    }

    popupRef.current = new mapboxgl.Popup({ closeButton:true, maxWidth:'260px' })
      .setLngLat(lngLat)
      .setHTML(`<div style="font-family:sans-serif;font-size:12px;line-height:1.8">${html}</div>`)
      .addTo(map.current)

    // Clear clickedStop when popup is closed so slider changes don't reopen it
    popupRef.current.on('close', () => setClickedStop(null))

    // Wire opposite platform link
    const link = popupRef.current.getElement()?.querySelector('.opp-link')
    if (link) {
      link.addEventListener('click', e => {
        e.preventDefault()
        const partnerId = link.getAttribute('data-id')
        const partnerName = link.getAttribute('data-name')
        const partnerStop = rawData?.stopData?.[partnerId]
        if (partnerStop) {
          setClickedStop({ osmId: partnerId, stopName: partnerName,
            lngLat: { lng: partnerStop.coords[0], lat: partnerStop.coords[1] } })
        }
      })
    }
  }, [clickedStop, stopResults, rawData, timeBudget, mapReady])

  // POI helpers
  const makePinEl = (color, strokeColor, className) => {
    const el = document.createElement('div')
    el.className = className
    el.innerHTML = `<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z" fill="${color}" stroke="${strokeColor}" stroke-width="1.5"/>
      <circle cx="12" cy="8" r="3" fill="white"/>
    </svg>`
    return el
  }

  const handlePoiSelect = useCallback(({ coords, label }) => {
    if (!map.current) return
    poiMarkerRef.current?.remove()
    const el = makePinEl('#f97316', '#7c2d00', 'poi-pin')
    poiMarkerRef.current = new mapboxgl.Marker({ element:el, anchor:'bottom' })
      .setLngLat(coords).addTo(map.current)
    setPendingPoi({ coords, label })
    map.current.flyTo({ center:coords, zoom:14, duration:600 })
  }, [])

  const handlePoiClear = useCallback(() => {
    poiMarkerRef.current?.remove()
    poiMarkerRef.current = null
    setPendingPoi(null)
  }, [])

  const handleSavePin = useCallback(() => {
    if (!pendingPoi || !map.current) return
    const { coords, label } = pendingPoi
    const c = PIN_COLORS[0]
    const el = makePinEl(c.fill, c.stroke, 'saved-pin')
    const id = Date.now()
    const marker = new mapboxgl.Marker({ element:el, anchor:'bottom' }).setLngLat(coords).addTo(map.current)
    el.addEventListener('click', () => {
      setSavedPins(current => {
        const pin = current.find(p => p.id === id)
        if (pin?.link) window.open(pin.link.startsWith('http') ? pin.link : 'https://' + pin.link, '_blank')
        return current
      })
    })
    setSavedPins(prev => [...prev, { id, coords, label, name: label.split(',')[0], colorId:'yellow', link:'', marker }])
    setEditingPinId(id)
    poiMarkerRef.current?.remove()
    poiMarkerRef.current = null
    setPendingPoi(null)
    if (poiGeoSearchRef.current) poiGeoSearchRef.current._clear()
  }, [pendingPoi])

  const handleRenamePin = useCallback((id, name) => {
    setSavedPins(prev => prev.map(p => p.id === id ? { ...p, name } : p))
  }, [])

  const handleColorPin = useCallback((id, colorId) => {
    setSavedPins(prev => prev.map(p => {
      if (p.id !== id) return p
      const c = PIN_COLORS.find(x => x.id === colorId)
      const el = p.marker.getElement()
      el.innerHTML = `<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>
        <circle cx="12" cy="8" r="3" fill="white"/>
      </svg>`
      return { ...p, colorId }
    }))
  }, [])

  const handleDeletePin = useCallback((id) => {
    setSavedPins(prev => { const pin = prev.find(p => p.id === id); pin?.marker?.remove(); return prev.filter(p => p.id !== id) })
    setEditingPinId(prev => prev === id ? null : prev)
  }, [])

  const handleLinkPin = useCallback((id, link) => {
    setSavedPins(prev => prev.map(p => p.id === id ? { ...p, link } : p))
  }, [])

  const handleExport = useCallback(() => {
    const data = {
      savedPins: savedPins.map(({ id, coords, label, name, colorId, link }) =>
        ({ id, coords, label, name, colorId, link: link || '' })
      ),
      sentiment,
    }
    setLightbox({ mode: 'export', text: JSON.stringify(data, null, 2) })
  }, [savedPins, sentiment])

  const handleImport = useCallback((jsonText) => {
    try {
      const data = JSON.parse(jsonText)
      if (data.sentiment) setSentiment(data.sentiment)
      if (Array.isArray(data.savedPins) && map.current) {
        setSavedPins(prev => { prev.forEach(p => p.marker?.remove()); return [] })
        const newPins = data.savedPins.map(p => {
          const c = PIN_COLORS.find(x => x.id === p.colorId) || PIN_COLORS[0]
          const el = makePinEl(c.fill, c.stroke, 'saved-pin')
          const id = p.id || Date.now() + Math.random()
          el.addEventListener('click', () => {
            setSavedPins(current => {
              const pin = current.find(pin => pin.id === id)
              if (pin?.link) window.open(pin.link.startsWith('http') ? pin.link : 'https://' + pin.link, '_blank')
              return current
            })
          })
          const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat(p.coords).addTo(map.current)
          return { ...p, id, marker }
        })
        setSavedPins(newPins)
      }
      setLightbox(null)
    } catch {
      alert('Invalid JSON — please check the data and try again.')
    }
  }, [])

  const activeStops = stopResults
    ? Object.values(stopResults).filter(r => r.best && r.best.total < timeBudget).length
    : 0
  const pct = ((timeBudget - 5) / 55 * 100).toFixed(1)

  return (
    <div className="app">
      <nav className="navbar">
        <span className="nav-title">Vienna Transit</span>
        <div className="poi-search-wrap" ref={poiGeoSearchRef}>
          <GeoSearch placeholder="Drop a pin anywhere…" icon="🟠" iconColor="#f97316"
            onSelect={handlePoiSelect} onClear={handlePoiClear}
            onRegisterClear={fn => { poiGeoSearchRef.current = { _clear: fn } }} />
          <button className={`save-pin-btn${pendingPoi ? ' active' : ''}`}
            onClick={handleSavePin} disabled={!pendingPoi} title="Save this pin">Save</button>
        </div>
        <div className="nav-actions">
          <button className="nav-btn" onClick={handleExport}>Export</button>
          <button className="nav-btn" onClick={() => setLightbox({ mode:'import', text:'' })}>Import</button>
        </div>
      </nav>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        <div className="side-panel">
          <div className="sp-section">
            <div className="sp-label">🎓 Destination</div>
            <GeoSearch placeholder="Set destination…" icon="📍" iconColor="#60a5fa"
              onSelect={setDest} initialLabel={DEFAULT_DEST.label} label={dest.label} />
          </div>

          <div className="sp-section">
            <div className="sp-label">⏱ Time budget</div>
            <div className="slider-row">
              <input type="range" min={5} max={60} step={1} value={timeBudget}
                style={{'--pct':`${pct}%`}} onChange={e => setTimeBudget(Number(e.target.value))}
                className="slider" />
              <span className="slider-val">{timeBudget}m</span>
            </div>
            <div className="stats-row">
              <span className="stat-num">{activeStops}</span>
              <span className="stat-lbl"> stops in range</span>
            </div>
          </div>

          <div className="sp-section">
            <div className="sp-label">Legend</div>
            <div className="legend-row">
              <span className="sw pos"/><span>Good</span>
              <span className="sw neg"/><span>Avoid</span>
              <span className="sw neu"/><span>Neutral</span>
            </div>
            <div className="lines-row">
              {Object.entries(LINE_COLORS).filter(([k]) => k.startsWith('U')).map(([ref,color]) => (
                <span key={ref} className="lbadge" style={{background:color}}>{ref}</span>
              ))}
              <span className="lbadge" style={{background:LINE_COLORS.tram}}>Tram</span>
            </div>
          </div>

          {savedPins.length > 0 && (
            <div className="sp-section">
              <div className="sp-label">📍 Saved pins</div>
              <div className="saved-pins-list">
                {savedPins.map(pin => {
                  const c = PIN_COLORS.find(x => x.id === pin.colorId) || PIN_COLORS[0]
                  const isEditing = editingPinId === pin.id
                  return (
                    <div key={pin.id} className="saved-pin-entry">
                      <div className="saved-pin-row">
                        <span className="saved-pin-dot" style={{ color: c.fill }}>●</span>
                        <span className="saved-pin-label"
                          onClick={() => { map.current?.flyTo({ center:pin.coords, zoom:15, duration:500 }); setEditingPinId(isEditing ? null : pin.id) }}>
                          {pin.name || pin.label.split(',')[0]}
                        </span>
                        {pin.link && (
                          <a href={pin.link.startsWith('http') ? pin.link : 'https://' + pin.link}
                            target="_blank" rel="noopener noreferrer"
                            className="pin-link-icon" title={pin.link}
                            onClick={e => e.stopPropagation()}>↗</a>
                        )}
                        <button className="delete-pin-btn" onClick={() => handleDeletePin(pin.id)}>✕</button>
                      </div>
                      {isEditing && (
                        <div className="pin-editor">
                          <input className="pin-name-input" value={pin.name || ''}
                            placeholder="Rename pin…" autoFocus
                            onChange={e => handleRenamePin(pin.id, e.target.value)} />
                          <input className="pin-name-input" value={pin.link || ''}
                            placeholder="Add a link (optional)…"
                            onChange={e => handleLinkPin(pin.id, e.target.value)} />
                          <div className="pin-color-row">
                            {PIN_COLORS.map(col => (
                              <button key={col.id}
                                className={`color-swatch${pin.colorId === col.id ? ' selected' : ''}`}
                                style={{ background: col.fill, borderColor: pin.colorId === col.id ? '#fff' : col.fill }}
                                title={col.label} onClick={() => handleColorPin(pin.id, col.id)} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="sp-section">
            <button className="sp-toggle" onClick={() => setShowDistricts(v => !v)}>
              Districts {showDistricts ? '▲' : '▼'}
            </button>
            {showDistricts && (
              <DistrictPanel sentiment={sentiment} onChange={(num,val) => setSentiment(p => ({...p,[num]:val}))} />
            )}
          </div>
        </div>

        <div ref={mapContainer} className="map-container" />
      </div>

      {lightbox && (
        <div className="lightbox-overlay" onClick={e => { if (e.target === e.currentTarget) setLightbox(null) }}>
          <div className="lightbox">
            <div className="lightbox-header">
              <span>{lightbox.mode === 'export' ? 'Export Session' : 'Import Session'}</span>
              <button className="lightbox-close" onClick={() => setLightbox(null)}>✕</button>
            </div>
            <p className="lightbox-desc">
              {lightbox.mode === 'export'
                ? 'Copy the JSON below to save your pins and district selections.'
                : 'Paste a previously exported JSON to restore your session.'}
            </p>
            <textarea className="lightbox-textarea"
              value={lightbox.text}
              readOnly={lightbox.mode === 'export'}
              onChange={e => setLightbox(lb => ({ ...lb, text: e.target.value }))}
              spellCheck={false}
            />
            <div className="lightbox-actions">
              {lightbox.mode === 'export'
                ? <button className="lightbox-btn primary"
                    onClick={() => navigator.clipboard?.writeText(lightbox.text)}>
                    Copy to clipboard
                  </button>
                : <button className="lightbox-btn primary"
                    onClick={() => handleImport(lightbox.text)}>
                    Import
                  </button>
              }
              <button className="lightbox-btn" onClick={() => setLightbox(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
