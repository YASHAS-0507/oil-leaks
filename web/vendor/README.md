# Vendored libraries

| File | What | License |
| --- | --- | --- |
| `sql-wasm.js`, `sql-wasm.wasm` | sql.js (SQLite in the browser) | MIT |
| `leaflet.js`, `leaflet.css`, `images/` | Leaflet maps | BSD-2-Clause |
| `globe-bundle.min.js` | globe.gl + the parts of three.js used for the 3D ships | MIT |
| `topojson-client.min.js` | topojson-client | ISC |
| `countries-50m.json` | world-atlas country borders (Natural Earth, public domain) | ISC |

`globe-bundle.min.js` is built from `build/entry.js` so the page gets one copy of three.js shared by the globe and the ship models:

```
npm install globe.gl three esbuild
npx esbuild build/entry.js --bundle --minify --format=iife --outfile=globe-bundle.min.js
```
