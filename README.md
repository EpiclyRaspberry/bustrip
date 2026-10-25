# TransitCorridor — Philippine Bus Trip Planner

**Plan the ride. Make time for breaks.**

**TransitCorridor** is a 100% client-side, mobile-first web application for planning Philippine bus trips, discovering mapped rest stops and terminals along the route corridor, and estimating arrival times with customizable layover breaks. It runs entirely in the browser with zero backend dependencies, user accounts, or analytics, and is ready for static hosting on GitHub Pages.

---

## ✨ Features

- **Flexible Route Endpoints (`A` → `B`)**:
  - Search towns, terminals, or landmarks via explicit search requests (powered by Photon by komoot).
  - Pick origin and destination pins directly on the interactive map (`Choose on map`).
  - Use device GPS (`My location`) on demand via the HTML5 Geolocation API.
  - One-click origin/destination swap and a built-in sample corridor (**PITX → Legazpi**).
- **Bus Profiles & Speed Customization**:
  - **Provincial coach** (`60 km/h`)
  - **A/C express** (`48 km/h`)
  - **City / ordinary** (`30 km/h`)
  - **Custom speed** (`15–100 km/h` slider)
- **Optional Stopovers & Suggested Breaks**:
  - Nothing is added to your ETA automatically—stopovers are **opt-in** so your baseline estimate starts as pure driving time.
  - **Suggested Breaks**: Automatically spaces recommended rest stops along your route (every `2`, `2½`, or `3` hours of driving) using live OpenStreetMap corridor data and a curated, source-linked starter guide for the Southern Luzon corridor.
  - **Purpose Filters & Search**: Filter corridor candidates by **All**, **Food**, **Toilets**, **Rest areas**, or **Terminals**, or search by place name.
  - **Manual Breaks**: Add custom stopovers and break durations (`1–240 min`) when a known operator stop isn't on the map.
- **Mobile-First Responsive Design**:
  - Full-viewport Leaflet map with an expandable/collapsible bottom sheet on mobile screens and a floating planner panel on desktop.
- **Privacy-First Architecture**:
  - Zero tracking cookies, analytics, or backend servers.
  - Temporary session caching (`sessionStorage`, up to 30 minutes) to minimize redundant API calls, with a one-click **Clear local data** control and a dedicated [Privacy Policy](privacy.html).

---

## 🧮 How the Estimate Works

$$\text{Total Trip Time} = \frac{\text{Road Distance}}{\text{Selected Average Speed}} + \sum \text{Selected Break Durations}$$

1. **Routing**: Queries OSRM's public driving profile between your origin and destination coordinates.
2. **Corridor Discovery**: Searches within your selected corridor radius (`200 m`, `450 m`, or `800 m` of the route) via the Overpass API (`overpass-api.de` with `overpass.private.coffee` fallback) alongside bundled corridor guide entries.
3. **Arrival Calculation**: Combines road travel duration at your chosen bus speed with any breaks you explicitly add, displaying total time on the road, break time, and estimated arrival clock time.

> **Note**: TransitCorridor provides a driving and break-planning estimate, not an official bus operator timetable. Traffic, passenger pickups, weather, RoRo ferries, and detours can add travel time.

---

## 📁 Project Structure

```text
.
├── index.html     # Main application markup & inline SVG icon sprite
├── privacy.html   # Plain-language privacy & external services disclosure
├── style.css      # Mobile-first responsive styles, bottom sheet, and print/theme rules
├── script.js      # Routing, corridor POI discovery, break spacing engine, and UI state
├── LICENSE        # MIT License
└── README.md      # Project documentation
```

---

## 🚀 Running Locally

Because the app is 100% static HTML, CSS, and vanilla JavaScript, you can serve it with any local HTTP server:

```bash
# Using Python 3
python3 -m http.server 8000

# Or using Node.js (npx serve)
npx serve .
```

Then open `http://localhost:8000` in your browser.

---

## 🌐 External Services Used

All external connections are made directly from the user's browser over HTTPS:
- **OpenStreetMap Tiles** — Basemap rendering (`© OpenStreetMap contributors`, ODbL)
- **Photon by komoot** — Place and landmark search
- **Project OSRM** — Road route geometry and distance calculation
- **Overpass API** — Corridor stopover and facility queries
- **unpkg** — Leaflet `v1.9.4` CSS and JavaScript delivery

See [privacy.html](privacy.html) for full details on how each service is contacted.

---

## 📄 License

Licensed under the [MIT License](LICENSE).
