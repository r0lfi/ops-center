// Shared Web Mercator projection math for the app's native (non-Grafana)
// maps. Callers pick their own zoom (a fixed whole-world grid, never
// panned/zoomed, so a handful of tile requests total - not the kind of
// bulk tile-scraping OSM's usage policy is about).
export const TILE_SIZE = 256;

export function mapSizeForZoom(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

export function project(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const size = mapSizeForZoom(zoom);
  const x = ((lon + 180) / 360) * size;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * size;
  return { x, y };
}
