import { useState, useEffect, useRef, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import * as turf from '@turf/turf'
import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_DEST = { coords: [16.387847, 48.173449], label: 'CEU, Quellenstraße 51, 1100 Wien' }
const WALK_SPEED_KMH = 4.5 / 1.2 / 1.2
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
  '1':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,
  '10':0,'11':0,'12':0,'13':0,'14':0,'15':0,'16':0,
  '17':0,'18':0,'19':0,'20':0,'21':0,'22':0,'23':0,
}

const LINE_COLORS = {
  U1:'#E3000F', U2:'#A862A4', U3:'#EF7C00', U4:'#319F49', U6:'#9D6830', tram:'#C8102E',
}

const TOOLTIPS = {
  destination: 'Your origin point. Walking radius circles appear around every transit stop reachable within your time budget from here. Drag the blue pin on the map to reposition.',
  timeBudget: 'Maximum total commute time (transit + walk from the stop). Stops whose best route fits within this budget show a walking radius circle indicating how far you could go on foot after alighting.',
  legend: 'District shading reflects your preferences from the Districts panel. Green = preferred, red = avoid, grey = neutral.',
  savedPins: 'Apartments or locations saved for comparison. Click a pin name to fly to it. Use the chevron to edit name, link, and color.',
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

function computeAllStopData(stopData, lineData, destCoords) {
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
      const boardEntry = ordered.find(e => e.id === osmId)
      if (!boardEntry) continue
      if (boardEntry.cum_km > alightEntry.cum_km + 0.01) {
        wrongDirOptions.push({ line, direction,
          alight_id: alightEntry.id, alight_name: alightStop.name,
          walk_min: Math.round(walkMin * 10) / 10,
        })
        continue
      }
      const transitMin = boardEntry.id === alightEntry.id
        ? 0
        : (alightEntry.cum_km - boardEntry.cum_km) / (lineInfo.speed_kmh / 1.2) * 60
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

// ── InfoTip ───────────────────────────────────────────────────────────────────
function InfoTip({ text }) {
  const [clickOpen, setClickOpen] = useState(false)
  const [hoverOpen, setHoverOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const wrapRef = useRef(null)
  const isMobile = () => window.matchMedia('(max-width: 768px)').matches
  useEffect(() => {
    if (!clickOpen) return
    const handler = (e) => { if (!wrapRef.current?.contains(e.target)) setClickOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [clickOpen])
  const open = isMobile() ? clickOpen : (hoverOpen || clickOpen)
  const updatePos = () => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setPos({ top: r.top + r.height / 2, left: r.right + 6 })
  }
  return (
    <span className="info-tip-wrap" ref={wrapRef}
      onMouseEnter={() => { if (!isMobile()) { updatePos(); setHoverOpen(true) } }}
      onMouseLeave={() => setHoverOpen(false)}>
      <button className="info-tip-btn" ref={btnRef}
        onClick={() => { updatePos(); setClickOpen(v => !v) }}>?</button>
      {open && (
        <div className="info-tip-box" style={isMobile() ? {} : {
          position: 'fixed', top: pos.top, left: pos.left,
          transform: 'translateY(-50%)', margin: 0
        }}>{text}</div>
      )}
    </span>
  )
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
    setQuery(''); setResults([]); setOpen(false); onClear?.()
  }, [onClear])
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
          placeholder={placeholder || 'Search...'} value={query}
          onChange={handleChange}
          onFocus={() => { if (results.length) setOpen(true) }}
          onBlur={() => setTimeout(() => setOpen(false), 160)} />
        {loading && <span className="geo-spin">&#8635;</span>}
      </div>
      {open && results.length > 0 && (
        <ul className="geo-results">
          {results.map(f => (
            <li key={f.id} onMouseDown={() => handleSelect(f)}>
              <span className="res-name">{f.address ? `${f.text} ${f.address}` : f.text}</span>
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
              <span className="dp-minus">-</span>
            </div>
          </label>
        )
      })}
    </div>
  )
}

// ── WelcomeLightbox ───────────────────────────────────────────────────────────
function WelcomeLightbox({ onClose, onStart, helpOnly, initialDest, initialBudget }) {
  const [dest, setDest] = useState(initialDest || DEFAULT_DEST)
  const [budget, setBudget] = useState(initialBudget || 30)
  const [importMode, setImportMode] = useState(false)
  const [importText, setImportText] = useState('')
  const pct = ((budget - 5) / 55 * 100).toFixed(1)

  return (
    <div className="lightbox-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="lightbox welcome-lightbox">
        <div className="lightbox-header">
          <div className="welcome-title-row nav-title-main" style={{display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center"}}>
            <span style={{fontSize: "26px", marginTop: "-4px"}}>&#128647;</span>
            <span>Wiener Linien Transmission Map</span>
          </div>
          <button className="lightbox-close" onClick={onClose}>&#10005;</button>
        </div>

        <p className="lightbox-desc welcome-intro">
          This map visualises transit reach from a fixed origin using Wiener Linien U-Bahn and Tram services: every stop reachable within your time budget is shown with a walking radius circle, indicating the approximate radial distance you could cover on foot after exiting at that stop. The map assumes direct service with no transfers.
        </p>
        <strong style={{color:'#e2e8f0', fontSize: "14px"}}>Use cases:</strong>
        <ul className="welcome-usecases">
          <li><strong style={{color:'#cbd5e1'}}>Apartment hunting</strong> — find every transit stop reachable from your workplace within your commute budget</li>
          <li><strong style={{color:'#cbd5e1'}}>Event dispersal</strong> — approximate the zone attendees re-enter as they leave a venue at a given time</li>
          <li><strong style={{color:'#cbd5e1'}}>Transmission spread</strong> — trace a plausible dispersal radius from a known patient-zero origin</li>
          <li><strong style={{color:'#cbd5e1'}}>15-minute city analysis</strong> — set any residential address as origin and see which destinations fall within a self-sufficient neighbourhood radius by transit and foot</li>
        </ul>

        {!helpOnly && !importMode && (
          <>
            <div className="welcome-field">
              <label className="welcome-label">Where are you commuting from?</label>
              <GeoSearch
                placeholder="Search an address or place..."
                icon="&#128205;" iconColor="#60a5fa"
                onSelect={setDest}
                initialLabel={dest.label}
                label={dest.label}
              />
            </div>
            <div className="welcome-field">
              <label className="welcome-label">Maximum commute time</label>
              <div className="slider-row" style={{ marginTop: 4 }}>
                <input type="range" min={5} max={60} step={1} value={budget}
                  style={{'--pct':`${pct}%`}} onChange={e => setBudget(Number(e.target.value))}
                  className="slider" />
                <span className="slider-val">{budget}m</span>
              </div>
            </div>
            <div className="lightbox-actions welcome-actions">
              <button className="lightbox-btn" onClick={() => setImportMode(true)}>
                Import previous session
              </button>
              <button className="lightbox-btn primary" onClick={() => onStart({ dest, budget })}>
                Get started &#8594;
              </button>
            </div>
          </>
        )}

        {!helpOnly && importMode && (
          <>
            <div style={{display:'flex', justifyContent:'space-between', gap:'8px'}}>
              <button className="lightbox-btn" onClick={() => setImportMode(false)}>&#8592; Back</button>
              <button className="lightbox-btn" onClick={async () => {
                const r = await fetch('/demo.json'); const txt = await r.text()
                setImportText(txt)
              }}>Load demo data</button>
            </div>
            <p className="lightbox-desc">Paste a previously exported JSON to restore your pins and district preferences.</p>
            <textarea className="lightbox-textarea"
              style={{minHeight: '52px'}}
              value={importText}
              placeholder='{"savedPins": [...], "sentiment": {...}}'
              onChange={e => setImportText(e.target.value)}
              spellCheck={false} />
            <div className="lightbox-actions">
              <button className="lightbox-btn primary" onClick={() => onStart({ dest, budget, importJson: importText })}>
                Import &amp; start
              </button>
            </div>
          </>
        )}

        {helpOnly && (
          <>
            <div className="help-sections">
              <div className="help-section">
                <div className="help-section-title">&#128205; Origin &amp; time budget</div>
                <p>Set your origin in the left panel. Drag the blue pin on the map to adjust. The slider controls maximum total minutes (transit + walk back from the stop). The map assumes no transfers.</p>
              </div>
              <div className="help-section">
                <div className="help-section-title">&#11093; Walking circles</div>
                <p>Every transit stop reachable within your budget shows a circle. Its radius is the walking distance you would have left over after riding to the nearest stop to your destination.</p>
              </div>
              <div className="help-section">
                <div className="help-section-title">&#127968; Saving pins</div>
                <p>Search for an address in the top bar and click Save. Pins appear in the left panel where you can rename them, add a listing link, and colour-code by preference. Use the chevron to expand a pin's settings, and the trash icon inside to delete it.</p>
              </div>
              <div className="help-section">
                <div className="help-section-title">&#128506; Districts</div>
                <p>Use the Districts panel to mark districts as preferred (+) or to avoid (-). The map shades them green or red. Your preferences export with your session.</p>
              </div>
              <div className="help-section">
                <div className="help-section-title">&#128190; Export / Import</div>
                <p>Export saves your pins and district preferences as JSON you can paste back into any future session.</p>
              </div>
            </div>
            <div className="lightbox-actions">
              <button className="lightbox-btn primary" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
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
  const [rawData, setRawData] = useState(null)
  const [stopResults, setStopResults] = useState(null)
  const [clickedStop, setClickedStop] = useState(null)
  const [sentiment, setSentiment] = useState(DEFAULT_SENTIMENT)
  const [showDistricts, setShowDistricts] = useState(false)
  const [savedPins, setSavedPins] = useState([])
  const [pendingPoi, setPendingPoi] = useState(null)
  const [expandedPinId, setExpandedPinId] = useState(null)
  const [lightbox, setLightbox] = useState(null)

  useEffect(() => { setLightbox({ mode: 'welcome' }) }, [])

  useEffect(() => {
    Promise.all([
      fetch('/stop_data.json').then(r => r.json()),
      fetch('/line_data.json').then(r => r.json()),
    ]).then(([stopData, lineData]) => setRawData({ stopData, lineData }))
  }, [])

  useEffect(() => {
    if (!rawData) return
    setStopResults(computeAllStopData(rawData.stopData, rawData.lineData, dest.coords))
  }, [rawData, dest])

  useEffect(() => {
    if (!mapReady) return
    destMarkerRef.current?.setLngLat(dest.coords)
    map.current?.flyTo({ center: dest.coords, zoom: 12, duration: 800 })
  }, [dest, mapReady])

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

  useEffect(() => {
    if (map.current) return
    if (!MAPBOX_TOKEN || MAPBOX_TOKEN === 'pk.your_token_here') { console.error('No Mapbox token'); return }
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
      map.current.addSource('walking-circles', { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
      map.current.addLayer({ id:'walking-circles-fill', type:'fill', source:'walking-circles',
        paint:{ 'fill-color':'#60a5fa', 'fill-opacity':0.06 } })
      map.current.addLayer({ id:'walking-circles-border', type:'line', source:'walking-circles',
        paint:{ 'line-color':'#60a5fa', 'line-width':1, 'line-opacity':0.3 } })
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
      const seenRefs = new Set()
      const dedupedLines = { type:'FeatureCollection', features: lines.features
        .filter(f => { const r = f.properties.ref; if (!r || seenRefs.has(r)) return false; seenRefs.add(r); return true })
        .map(f => ({ ...f, properties: { ...f.properties, lineColor: getLineColor(f.properties.ref, f.properties.route) } }))
      }
      map.current.addSource('transit-lines', { type:'geojson', data:dedupedLines })
      map.current.addLayer({ id:'transit-lines-layer', type:'line', source:'transit-lines',
        paint:{ 'line-color':['get','lineColor'],
          'line-width':['case',['==',['get','route'],'subway'],3,1.5], 'line-opacity':0.85 } })
      map.current.addSource('transit-stops', { type:'geojson', data:stops })
      map.current.addLayer({ id:'transit-stops-layer', type:'circle', source:'transit-stops',
        paint:{ 'circle-radius':['interpolate',['linear'],['zoom'],10,2,14,5],
          'circle-color':'#fff', 'circle-stroke-color':'#555', 'circle-stroke-width':1, 'circle-opacity':0.85 } })
      const destEl = document.createElement('div')
      destEl.className = 'dest-pin'
      destEl.innerHTML = '<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z" fill="#60a5fa" stroke="#1e3a5f" stroke-width="1.5"/><circle cx="12" cy="8" r="3" fill="white"/></svg>'
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

  useEffect(() => {
    if (!clickedStop || !mapReady) return
    if (popupRef.current) { popupRef.current.remove(); popupRef.current = null }
    const { osmId, stopName, lngLat } = clickedStop
    const result = stopResults?.[osmId]
    const rawStop = rawData?.stopData?.[osmId]
    let html
    const findOppId = (wd, name) => {
      const oppId = result?.opposite_ids?.[wd.line]
      if (oppId) return oppId
      return Object.keys(stopResults).find(id => {
        if (id === osmId) return false
        if (rawData?.stopData?.[id]?.name !== name) return false
        const oppRoutes = rawData?.stopData?.[id]?.routes || []
        const oppResult = stopResults[id]
        return oppRoutes.some(r => r.line === wd.line) &&
               oppResult?.allOptions?.some(o => o.line === wd.line)
      }) || null
    }
    const validLines = new Set((result?.allOptions || []).map(o => o.line))
    const transitBlock = (b) => {
      const total = b.total
      const remaining = timeBudget - total
      const withinBudget = remaining > 0
      const radius = withinBudget ? ((remaining / 60) * WALK_SPEED_KMH * 1000).toFixed(0) : 0
      const status = withinBudget
        ? `<span style="color:#60a5fa">&#11093; ${radius}m walk radius</span>`
        : `<span style="color:#f87171">Outside ${timeBudget} min budget</span>`
      return `&#128647; <strong>${b.transit_min.toFixed(0)}</strong> min transit
        &#128694; <strong>${b.walk_min.toFixed(0)}</strong> min walk from ${b.line}, ${b.alight_name}<br/>
        <span style="color:#cbd5e1">Total: <strong>${total.toFixed(0)} min</strong></span><br/>
        ${status}`
    }
    const name = result?.name || rawStop?.name || stopName
    if (result?.best) {
      const b = result.best
      let linesHtml = `<span style="color:#94a3b8">Line ${b.line} &#8594; ${b.direction}</span>`
      const others = result.allOptions.slice(1)
      if (others.length) {
        linesHtml += `<br/><span style="color:#64748b;font-size:11px">Also: ${
          others.map(o => `Line ${o.line} &#8594; ${o.direction} (${o.total.toFixed(0)} min)`).join(', ')
        }</span>`
      }
      let wrongHtml = ''
      for (const wd of (result.wrongDirRoutes || [])) {
        if (validLines.has(wd.line)) continue
        const oppId = findOppId(wd, name)
        if (!oppId) continue
        const oppRoutes = rawData?.stopData?.[oppId]?.routes || []
        const oppRouteForLine = oppRoutes.find(r => r.line === wd.line)
        const oppDir = oppRouteForLine?.direction || stopResults[oppId]?.best?.direction || oppRoutes[0]?.direction || ''
        wrongHtml += `<br/><span style="color:#fb923c;font-size:11px">&#9888; <a href="#" class="opp-link" data-id="${oppId}" data-name="${name}" style="color:#fb923c;text-decoration:none;font-size:11px">Line ${wd.line}: board opposite platform &#8594; ${oppDir}</a></span>`
      }
      html = `<strong>${name}</strong><br/>${linesHtml}${wrongHtml}<div style="margin-top:6px">${transitBlock(b)}</div>`
    } else if (result?.wrongDirRoutes?.length) {
      const wd = result.wrongDirRoutes[0]
      const oppId = findOppId(wd, name)
      const oppResult = oppId ? stopResults[oppId] : null
      const oppBest = oppResult?.best
      let dataHtml = ''
      if (oppBest) {
        dataHtml = `<div style="margin-top:6px;color:#94a3b8;font-size:11px">If boarding correct platform:</div><div style="margin-top:2px">${transitBlock(oppBest)}</div>`
      }
      let warnHtml = ''
      if (oppId) {
        const oppRoutes = rawData?.stopData?.[oppId]?.routes || []
        const oppRouteForLine = oppRoutes.find(r => r.line === wd.line)
        const oppDir = oppRouteForLine?.direction || oppResult?.best?.direction || oppRoutes[0]?.direction || ''
        warnHtml = `<span style="color:#fb923c">&#9888; <a href="#" class="opp-link" data-id="${oppId}" data-name="${name}" style="color:#fb923c;text-decoration:none">Board from the opposite platform &#8594; ${oppDir}</a></span>`
      } else {
        warnHtml = `<span style="color:#64748b;font-size:11px">Heading away from destination - no opposite platform found</span>`
      }
      html = `<strong>${name}</strong><br/>${warnHtml}${dataHtml}`
    } else if (rawStop) {
      html = `<strong>${name}</strong><br/><span style="color:#94a3b8;font-size:11px">No lines serve this stop within ${MAX_ALIGHT_WALK_MIN} min walk of destination</span>`
    } else {
      html = `<strong>${stopName || 'Stop'}</strong><br/><span style="color:#94a3b8;font-size:11px">Bus or regional stop - not on a tracked line</span>`
    }
    popupRef.current = new mapboxgl.Popup({ closeButton:true, maxWidth:'260px' })
      .setLngLat(lngLat)
      .setHTML(`<div style="font-family:sans-serif;font-size:12px;line-height:1.8">${html}</div>`)
      .addTo(map.current)
    popupRef.current.on('close', () => setClickedStop(null))
    const link = popupRef.current.getElement()?.querySelector('.opp-link')
    if (link) {
      link.addEventListener('click', e => {
        e.preventDefault()
        const partnerId = link.getAttribute('data-id')
        const partnerName = link.getAttribute('data-name')
        const partnerStop = rawData?.stopData?.[partnerId]
        if (partnerStop) {
          setClickedStop({ osmId: partnerId, stopName: partnerName, lngLat: { lng: partnerStop.coords[0], lat: partnerStop.coords[1] } })
        }
      })
    }
  }, [clickedStop, stopResults, rawData, timeBudget, mapReady])

  const makePinEl = (color, strokeColor, className) => {
    const el = document.createElement('div')
    el.className = className
    el.innerHTML = `<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z" fill="${color}" stroke="${strokeColor}" stroke-width="1.5"/><circle cx="12" cy="8" r="3" fill="white"/></svg>`
    return el
  }

  const handlePoiSelect = useCallback(({ coords, label }) => {
    if (!map.current) return
    poiMarkerRef.current?.remove()
    const el = makePinEl('#f97316', '#7c2d00', 'poi-pin')
    poiMarkerRef.current = new mapboxgl.Marker({ element:el, anchor:'bottom' }).setLngLat(coords).addTo(map.current)
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
    setExpandedPinId(id)
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
      el.innerHTML = `<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/><circle cx="12" cy="8" r="3" fill="white"/></svg>`
      return { ...p, colorId }
    }))
  }, [])

  const handleDeletePin = useCallback((id) => {
    setSavedPins(prev => { const pin = prev.find(p => p.id === id); pin?.marker?.remove(); return prev.filter(p => p.id !== id) })
    setExpandedPinId(prev => prev === id ? null : prev)
  }, [])

  const handleLinkPin = useCallback((id, link) => {
    setSavedPins(prev => prev.map(p => p.id === id ? { ...p, link } : p))
  }, [])

  const handleExport = useCallback(() => {
    const data = {
      savedPins: savedPins.map(({ id, coords, label, name, colorId, link }) => ({ id, coords, label, name, colorId, link: link || '' })),
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
          const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat(p.coords).addTo(map.current)
          return { ...p, id, marker }
        })
        setSavedPins(newPins)
      }
      setLightbox(null)
    } catch {
      alert('Invalid JSON - please check the data and try again.')
    }
  }, [])

  const handleWelcomeStart = useCallback(({ dest: newDest, budget, importJson }) => {
    if (newDest) setDest(newDest)
    if (budget) setTimeBudget(budget)
    if (importJson) {
      try {
        const data = JSON.parse(importJson)
        if (data.sentiment) setSentiment(data.sentiment)
        if (Array.isArray(data.savedPins)) {
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
            const marker = map.current
              ? new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat(p.coords).addTo(map.current)
              : null
            return { ...p, id, marker }
          })
          setSavedPins(newPins)
        }
      } catch {
        alert('Invalid JSON in import - pins were not restored.')
      }
    }
    setLightbox(null)
  }, [])

  const activeStops = stopResults
    ? Object.values(stopResults).filter(r => r.best && r.best.total < timeBudget).length
    : 0
  const pct = ((timeBudget - 5) / 55 * 100).toFixed(1)

  return (
    <div className="app">
      <nav className="navbar">
        <div className="welcome-title-row nav-title-main" style={{display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center"}}>
            <span style={{fontSize: "26px", marginTop: "-4px"}}>&#128647;</span>
            <span>Wiener Linien Transmission Map</span>
          </div>
        <div className="poi-search-wrap" ref={poiGeoSearchRef}>
          <GeoSearch placeholder="Drop a pin anywhere..." icon="&#128205;" iconColor="#f97316"
            onSelect={handlePoiSelect} onClear={handlePoiClear}
            onRegisterClear={fn => { poiGeoSearchRef.current = { _clear: fn } }} />
          <button className={`save-pin-btn${pendingPoi ? ' active' : ''}`}
            onClick={handleSavePin} disabled={!pendingPoi} title="Save this pin">Save</button>
        </div>
        <div className="nav-actions nav-actions-btns">
          <button className="nav-btn help-btn" onClick={() => setLightbox({ mode: 'help' })}>
            Help <span className="help-btn-icon">?</span>
          </button>
          <button className="nav-btn" onClick={handleExport}>Export</button>
          <button className="nav-btn" onClick={() => setLightbox({ mode:'import', text:'' })}>Import</button>
        </div>
      </nav>

      <div className="app-body">
        <div className="side-panel">
          <div className="mobile-panel-title">
            <span style={{fontSize:"18px", marginTop:"-3px", display:"inline-block"}}>&#128647;</span>
            {' '}Wiener Linien Transmission Map
          </div>
          <div className="sp-section mobile-half">
            <div className="sp-label">
              <span style={{"fontSize":"14px"}}>&#9873;</span> Origin
              <InfoTip text={TOOLTIPS.destination} />
            </div>
            <GeoSearch placeholder="Set destination..." icon="&#128205;" iconColor="#60a5fa"
              onSelect={setDest} initialLabel={DEFAULT_DEST.label} label={dest.label} />
          </div>

          <div className="sp-section mobile-half">
            <div className="sp-label">
              <span style={{"fontSize":"14px"}}>⏱</span> Time budget
              <InfoTip text={TOOLTIPS.timeBudget} />
            </div>
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
            <div className="sp-label">
              Legend
              <InfoTip text={TOOLTIPS.legend} />
            </div>
            <div className="legend-row">
              <span className="sw pos"/><span>Positive</span>
              <span className="sw neg"/><span>Negative</span>
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
            <div className="sp-section mobile-full">
              <div className="sp-label">
                &#128205; Saved pins
                <InfoTip text={TOOLTIPS.savedPins} />
              </div>
              <div className="saved-pins-list">
                {savedPins.map(pin => {
                  const c = PIN_COLORS.find(x => x.id === pin.colorId) || PIN_COLORS[0]
                  const isExpanded = expandedPinId === pin.id
                  return (
                    <div key={pin.id} className="saved-pin-entry">
                      <div className="saved-pin-row">
                        <span className="saved-pin-dot" style={{ color: c.fill }}>&#9679;</span>
                        <span className="saved-pin-label"
                          onClick={() => map.current?.flyTo({ center:pin.coords, zoom:15, duration:500 })}>
                          {pin.name || pin.label.split(',')[0]}
                        </span>
                        {pin.link && (
                          <a href={pin.link.startsWith('http') ? pin.link : 'https://' + pin.link}
                            target="_blank" rel="noopener noreferrer"
                            className="pin-link-icon" title={pin.link}
                            onClick={e => e.stopPropagation()}>&#8599;</a>
                        )}
                        <button
                          className={`pin-toggle-btn${isExpanded ? ' open' : ''}`}
                          onClick={() => setExpandedPinId(isExpanded ? null : pin.id)}
                          title={isExpanded ? 'Collapse' : 'Edit pin'}>
                          {isExpanded ? '▼' : '▶'}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="pin-editor">
                          <input className="pin-name-input" value={pin.name || ''}
                            placeholder="Rename pin..." autoFocus
                            onChange={e => handleRenamePin(pin.id, e.target.value)} />
                          <input className="pin-name-input" value={pin.link || ''}
                            placeholder="Add a link (optional)..."
                            onChange={e => handleLinkPin(pin.id, e.target.value)} />
                          <div className="pin-editor-footer">
                            <div className="pin-color-row">
                              {PIN_COLORS.map(col => (
                                <button key={col.id}
                                  className={`color-swatch${pin.colorId === col.id ? ' selected' : ''}`}
                                  style={{ background: col.fill, borderColor: pin.colorId === col.id ? '#fff' : col.fill }}
                                  title={col.label} onClick={() => handleColorPin(pin.id, col.id)} />
                              ))}
                            </div>
                            <button className="pin-delete-btn" onClick={() => handleDeletePin(pin.id)} title="Delete pin">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="24px" width="24px" fill="#e3e3e3"><path d="M7,21q-0.82,0-1.41-0.59T5,19V6H4V4H9V3h6V4h5V6H19V19q0,0.82-0.59,1.41T17,21H7ZM17,6H7V19H17V6ZM9,17h2V8H9v9Zm4,0h2V8H13v9ZM7,6V19V6Z"/></svg>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="sp-section mobile-full">
            <button className="sp-toggle" onClick={() => setShowDistricts(v => !v)}>
              Districts {showDistricts ? '▼' : '▶'}
            </button>
            {showDistricts && (
              <DistrictPanel sentiment={sentiment} onChange={(num,val) => setSentiment(p => ({...p,[num]:val}))} />
            )}
          </div>
        </div>

        <div ref={mapContainer} className="map-container">
          <div className="mobile-legend">
            <div className="legend-row">
              <span className="sw pos"/><span>Positive</span>
              <span className="sw neg"/><span>Negative</span>
              <span className="sw neu"/><span>Neutral</span>
            </div>
            <div className="lines-row">
              {Object.entries(LINE_COLORS).filter(([k]) => k.startsWith('U')).map(([ref,color]) => (
                <span key={ref} className="lbadge" style={{background:color}}>{ref}</span>
              ))}
              <span className="lbadge" style={{background:LINE_COLORS.tram}}>Tram</span>
            </div>
          </div>
        </div>
      </div>

      {(lightbox?.mode === 'welcome' || lightbox?.mode === 'help') && (
        <WelcomeLightbox
          helpOnly={lightbox.mode === 'help'}
          initialDest={dest}
          initialBudget={timeBudget}
          onClose={() => setLightbox(null)}
          onStart={handleWelcomeStart}
        />
      )}

      {(lightbox?.mode === 'export' || lightbox?.mode === 'import') && (
        <div className="lightbox-overlay" onClick={e => { if (e.target === e.currentTarget) setLightbox(null) }}>
          <div className="lightbox">
            <div className="lightbox-header">
              <span>{lightbox.mode === 'export' ? 'Export Session' : 'Import Session'}</span>
              <button className="lightbox-close" onClick={() => setLightbox(null)}>&#10005;</button>
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
              spellCheck={false} />
            <div className="lightbox-actions">
              {lightbox.mode === 'export'
                ? <button className="lightbox-btn primary" onClick={() => navigator.clipboard?.writeText(lightbox.text)}>Copy to clipboard</button>
                : <>
                    <button className="lightbox-btn" onClick={async () => {
                      const r = await fetch('/demo.json'); const txt = await r.text()
                      setLightbox(lb => ({ ...lb, text: txt }))
                    }}>Load demo data</button>
                    <button className="lightbox-btn primary" onClick={() => handleImport(lightbox.text)}>Import</button>
                  </>
              }
              <button className="lightbox-btn" onClick={() => setLightbox(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
