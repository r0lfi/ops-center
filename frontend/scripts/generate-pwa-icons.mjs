import { mkdir, writeFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ShieldCheck } from "lucide-react";
import sharp from "sharp";

// Reuse the existing header/Sidebar ShieldCheck mark and UI colors.
// The mark stays inside the central 80% maskable safe zone.
const mark = renderToStaticMarkup(createElement(ShieldCheck, {
  x: 116, y: 116, width: 280, height: 280, color: "#0ea5e9", strokeWidth: 1.8,
}));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0b0e14"/>${mark}</svg>`;
const directory = new URL("../public/icons/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("favicon.svg", directory), svg);
for (const [name, size] of [["icon-192", 192], ["icon-512", 512], ["maskable-512", 512], ["apple-touch-icon", 180], ["favicon-32", 32]]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(new URL(name + ".png", directory).pathname);
}
