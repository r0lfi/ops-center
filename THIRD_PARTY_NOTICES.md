# Third-party notices

The application license does not replace dependency licenses. Python requirements, the npm lockfile and Dockerfiles identify the dependencies and base images used by each component. Preserve their license notices when distributing built images.

`frontend/src/components/ops-floor/three/land.json` identifies itself as Natural Earth's `ne_110m_land` geographic dataset. Natural Earth publishes its map data in the public domain: https://www.naturalearthdata.com/about/terms-of-use/

The optional GeoIP database is not included. Obtain an appropriate database separately and follow its provider's redistribution and attribution requirements.

Traffic Map's basemap uses OpenStreetMap tiles and shows attribution in the UI.
Operators should follow the tile service's usage policy. Client geolocation uses
a separately supplied local MMDB and does not send observed client IPs to a lookup API.

The PWA icons are generated from the same Lucide shield/check geometry already
used by the interface. Lucide's ISC license applies to that icon geometry. The
build includes Workbox and vite-plugin-pwa; preserve their dependency notices.
