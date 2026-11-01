# Vienna Transit Map

Interactive map showing walkable zones around Vienna transit stops, based on a time budget to CEU (Quellenstraße 51).

## Setup

### 1. Get a Mapbox token
Sign up at https://mapbox.com (free tier is enough).
Copy your public token (starts with `pk.`).

### 2. Add environment variable
```
cp .env.example .env
# Edit .env and paste your token:
# VITE_MAPBOX_TOKEN=pk.your_token_here
```

### 3. Add districts GeoJSON
The map needs `public/vienna_districts.geojson`. Get it by running this Overpass query at overpass-turbo.eu:

```
[out:json][timeout:90];
relation["boundary"="administrative"]["admin_level"="9"](48.1,16.2,48.3,16.5);
out geom;
```

Export as GeoJSON and save to `public/vienna_districts.geojson`.

The property used for district number should be `BEZNR`, `BEZ`, or `district` - check your file and update the line in `App.jsx`:
```js
const num = f.properties.BEZNR || f.properties.district || f.properties.BEZ
```

### 4. Edit district sentiment
In `src/App.jsx`, find `DISTRICT_SENTIMENT` and set each district 1 (positive), -1 (negative), or 0 (neutral).

### 5. Run locally
```
npm install
npm run dev
```

### 6. Deploy to Vercel
```
npm install -g vercel
vercel
# Add VITE_MAPBOX_TOKEN as environment variable in Vercel dashboard
```
Or connect your GitHub repo at vercel.com and add the env var there.

## How it works

- **Slider**: Sets total time budget (transit + walk to CEU)
- **Blue circles**: Walking radius from each stop, given remaining time after transit
- **Green districts**: Marked positive in DISTRICT_SENTIMENT
- **Red districts**: Marked negative
- **Click any stop**: See transit time breakdown and walk radius

## Data files in /public
- `wiener_linien_stops.geojson` - U-Bahn + tram stops from OSM
- `wiener_linien_lines.geojson` - U-Bahn + tram lines from OSM
- `stop_times.json` - computed transit times from each stop to CEU (path-distance based on avg speeds: U-Bahn 35 km/h, tram 15 km/h)
- `vienna_districts.geojson` - you need to add this (see step 3)

## Updating transit times with real GTFS data
Run this script locally to replace stop_times.json with schedule-accurate times:
```
node scripts/gtfs_times.js
```
(Script not yet included - uses Wiener Linien GTFS feed at wienerlinien.at/ogd_realtime)
