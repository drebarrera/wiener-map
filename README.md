# Vienna Transit Map

![Example Map](example.webp)

The Wiener Linien Transmission Map visualises transit reach from a fixed origin using Wiener Linien U-Bahn and Tram services: every stop reachable within the assigned time budget is shown with a walking radius circle, indicating the approximate radial distance you could cover on foot after exiting at that stop. The map assumes direct service with no transfers.

I built this map originally to keep track of available apartments and Wohnheime in proximity to [Central European University](ceu.edu) when searching for a place to live as a Master's student. Select **Import Demo Data** on the **Import Session** lightbox to import the demo data I was working with.

**Use cases**:
* Apartment hunting — find every transit stop reachable from your workplace within your commute budget
* Event dispersal — approximate the zone attendees re-enter as they leave a venue at a given time
* Transmission spread — trace a plausible dispersal radius from a known patient-zero origin
* 15-minute city analysis — set any residential address as origin and see which destinations fall within a self-sufficient neighbourhood radius by transit and foot

## Use

📍 Origin & time budget
Set your origin in the left panel. Drag the blue pin on the map to adjust. The **Time Budget** slider controls maximum total minutes (transit + walk back from the stop). The map assumes no transfers.

🚏 Click any stop
Select any stop to see the transit line, transit and walk to boarding station times, and walk range around the destination station.

⭕ Walking circles
Every transit stop reachable within your budget shows a circle. Its radius is the walking distance you would have left over after riding to the nearest stop to your destination.

🏠 Saving pins
Search for an address in the top bar and click **Save**. Pins appear in the left panel where you can rename them, add a listing link, and colour-code by preference. Use the chevron to expand a pin's settings, and the trash icon inside to delete it.

🗺 Districts
Use the **Districts** panel to mark districts as preferred (**+**) or to avoid (**-**). The map shades them green or red. Your preferences export with your session.

💾 Export / Import
Export saves your pins and district preferences as JSON you can paste back into any future session. Select **Import Demo Data** to import apartment and Wohnheim listing data in proximity to CEU.


## Setup

To set up the app locally, use the below steps.

### 1. Get a Mapbox token
Sign up at https://mapbox.com (free tier is enough).
Copy your public token (starts with `pk.`).

### 2. Add environment variable
```
echo "VITE_MAPBOX_TOKEN=<your variable here>" > .env
# Replace <your variable here> with your Mapbox token and run the above command in the terminal.
```

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
