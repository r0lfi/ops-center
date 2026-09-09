import * as THREE from "three";
import land from "./land.json";
import { TUX_URL } from "../Tux";
import type { AgentVisual } from "@/lib/opsFloorTypes";

/**
 * Procedural CanvasTextures for everything that shows "content" - monitor
 * screens, the wall sign, wall displays, the floor. Drawn with the 2D
 * canvas API so the scene has no network/font/asset dependency (drei's
 * Text fetches a font from a CDN; this app runs on a LAN).
 */

const TITLE: Record<string, string> = {
  monitoring: "METRICS",
  linux: "example-web-01 — bash",
  security: "CVE SCAN",
  container: "CONTAINERS",
  patching: "UPDATES",
  network: "NETWORK",
  automation: "ANSIBLE",
  general: "OPS LOG",
  chat: "CHAT",
};

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function finish(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function drawChart(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, seed: number) {
  const rnd = seeded(seed);
  g.strokeStyle = "#1e3358";
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    g.beginPath();
    g.moveTo(x, y + (h / 4) * i);
    g.lineTo(x + w, y + (h / 4) * i);
    g.stroke();
  }
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.shadowColor = color;
  g.shadowBlur = 8;
  g.beginPath();
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const px = x + (w / n) * i;
    const py = y + h - h * (0.25 + rnd() * 0.5);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
  g.shadowBlur = 0;
}

function drawBars(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, seed: number) {
  const rnd = seeded(seed);
  const n = 10;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const bh = h * (0.2 + rnd() * 0.75);
    g.fillStyle = color;
    g.globalAlpha = 0.85;
    g.fillRect(x + i * bw + 2, y + h - bh, bw - 4, bh);
  }
  g.globalAlpha = 1;
}

function drawLines(g: CanvasRenderingContext2D, x: number, y: number, lines: [string, string][], size: number) {
  g.font = `${size}px monospace`;
  lines.forEach(([text, color], i) => {
    g.fillStyle = color;
    g.fillText(text, x, y + i * (size * 1.45));
  });
}

export function makeScreenTexture(slug: string, accent: string, kind: "main" | "side"): THREE.CanvasTexture {
  const w = kind === "main" ? 512 : 256;
  const h = kind === "main" ? 320 : 176;
  const c = makeCanvas(w * 2, h * 2);
  const g = c.getContext("2d")!;
  g.scale(2, 2);

  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#0a1830");
  bg.addColorStop(1, "#050c19");
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  const bar = Math.round(h * 0.1);
  g.fillStyle = accent;
  g.globalAlpha = 0.9;
  g.fillRect(0, 0, w, bar);
  g.globalAlpha = 1;
  g.fillStyle = "#06101f";
  g.font = `bold ${Math.round(bar * 0.6)}px monospace`;
  g.fillText(TITLE[slug] ?? slug.toUpperCase(), 10, Math.round(bar * 0.72));

  const px = 12;
  const py = bar + 10;
  const cw = w - 24;
  const ch = h - bar - 22;
  const fs = kind === "main" ? 15 : 11;

  if (kind === "side") {
    if (slug === "linux") {
      const texture = finish(c), penguin = new Image();
      penguin.onload = () => { g.drawImage(penguin, w/2-36, py, 72, 81); texture.needsUpdate=true; };
      penguin.src=TUX_URL;
      g.fillStyle="#C8E5D2";g.font="11px monospace";g.fillText("LINUX · SYSTEM OPERATIONS",18,h-18);
      return texture;
    } else if (slug === "automation" || slug === "general") {
      drawLines(g, px, py + fs, [["$ systemctl status", "#9fd1ff"], ["● active (running)", "#4ade80"], ["mem 41% cpu 12%", "#93a4c4"], ["$ _", "#9fd1ff"]], fs);
    } else {
      drawChart(g, px, py, cw, ch, accent, slug.length * 7);
    }
    return finish(c);
  }

  switch (slug) {
    case "monitoring":
      drawChart(g, px, py, cw, ch * 0.55, accent, 11);
      drawBars(g, px, py + ch * 0.62, cw, ch * 0.38, "#7cc4ff", 5);
      break;
    case "linux":
      drawLines(
        g,
        px,
        py + fs,
        [
          ["root@example-web-01:~# uptime", "#9fd1ff"],
          [" 14:02 up 41 days, load 0.42 0.38 0.35", "#cbd5e1"],
          ["root@example-web-01:~# df -h /", "#9fd1ff"],
          ["/dev/sda2  98G  61G  37G  63% /", "#cbd5e1"],
          ["root@example-web-01:~# systemctl is-active nginx", "#9fd1ff"],
          ["active", "#4ade80"],
          ["root@example-web-01:~# _", "#9fd1ff"],
        ],
        fs,
      );
      break;
    case "security":
      drawLines(
        g,
        px,
        py + fs,
        [
          ["CVE-2026-2441  chromium   HIGH  KEV", "#f87171"],
          ["CVE-2026-5281  chromium   HIGH  KEV", "#f87171"],
          ["CVE-2026-1183  openssl    MED", "#fbbf24"],
          ["CVE-2026-0912  curl       LOW", "#93a4c4"],
          ["scan: 4 hosts, 44 containers", "#9fd1ff"],
          ["fix available: 10196", "#4ade80"],
        ],
        fs,
      );
      break;
    case "container":
      drawLines(
        g,
        px,
        py + fs,
        [
          ["homeassistant     running  healthy", "#4ade80"],
          ["nginx-proxy       running  healthy", "#4ade80"],
          ["ring-mqtt         running  healthy", "#4ade80"],
          ["autopatch-mgr     exited   unhealthy", "#f87171"],
          ["ops-center-api    running  healthy", "#4ade80"],
          ["68 containers / 3 hosts", "#9fd1ff"],
        ],
        fs,
      );
      break;
    case "patching": {
      const pkgs: [string, number][] = [["kernel", 0.9], ["openssl", 0.6], ["glibc", 0.35], ["systemd", 0.75], ["curl", 0.5]];
      g.font = `${fs}px monospace`;
      pkgs.forEach(([name, p], i) => {
        const y = py + 14 + i * 38;
        g.fillStyle = "#cbd5e1";
        g.fillText(name, px, y);
        g.fillStyle = "#1e3358";
        g.fillRect(px + 110, y - 12, cw - 120, 14);
        g.fillStyle = accent;
        g.fillRect(px + 110, y - 12, (cw - 120) * p, 14);
      });
      break;
    }
    case "network": {
      const rnd = seeded(3);
      const nodes = Array.from({ length: 7 }, () => [px + 20 + rnd() * (cw - 40), py + 20 + rnd() * (ch - 60)]);
      g.strokeStyle = accent;
      g.globalAlpha = 0.6;
      g.lineWidth = 1.5;
      nodes.forEach((a, i) => {
        const b = nodes[(i + 2) % nodes.length];
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
      });
      g.globalAlpha = 1;
      nodes.forEach((n) => {
        g.fillStyle = accent;
        g.shadowColor = accent;
        g.shadowBlur = 10;
        g.beginPath();
        g.arc(n[0], n[1], 6, 0, Math.PI * 2);
        g.fill();
      });
      g.shadowBlur = 0;
      drawLines(g, px, h - 14, [["latency 3.1ms  loss 0%  suspicious 0", "#9fd1ff"]], fs - 1);
      break;
    }
    case "automation":
      drawLines(
        g,
        px,
        py + fs,
        [
          ["PLAY [patch-security] ***********", "#cbd5e1"],
          ["TASK [Gathering Facts]      ok", "#4ade80"],
          ["TASK [dnf update security]  changed", "#fbbf24"],
          ["TASK [reboot-check]         ok", "#4ade80"],
          ["example-dns-02 : ok=3 changed=1 failed=0", "#9fd1ff"],
        ],
        fs,
      );
      break;
    case "chat": {
      const bubbles: [string, boolean][] = [
        ["Check disk usage on all docker hosts", false],
        ["On it — dispatching to Linux Ops…", true],
        ["ops-host: 61G/98G used (63%)", true],
      ];
      let by = py;
      bubbles.forEach(([text, mine]) => {
        const bw = Math.min(cw - 20, text.length * (fs * 0.56) + 24);
        const bx = mine ? px + (cw - bw) : px;
        g.fillStyle = mine ? accent : "#22314f";
        g.globalAlpha = mine ? 0.35 : 1;
        g.beginPath();
        g.roundRect(bx, by, bw, fs + 16, 8);
        g.fill();
        g.globalAlpha = 1;
        g.fillStyle = "#e6f0ff";
        g.font = `${fs - 1}px monospace`;
        g.fillText(text, bx + 10, by + fs + 2);
        by += fs + 26;
      });
      break;
    }
    default:
      drawLines(
        g,
        px,
        py + fs,
        [
          ["14:01 approval ACT-2026-… pending", "#fbbf24"],
          ["14:02 dispatch → patching agent", "#9fd1ff"],
          ["14:02 host example-dns-02 reachable", "#4ade80"],
          ["14:03 result: 120 pending patches", "#cbd5e1"],
        ],
        fs,
      );
  }
  return finish(c);
}

export function makeSignTexture(text: string, tagline?: string): THREE.CanvasTexture {
  const c = makeCanvas(1024, 224);
  const g = c.getContext("2d")!;
  g.fillStyle = "#050b16";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = "#1c2e4d";
  g.lineWidth = 6;
  g.strokeRect(6, 6, c.width - 12, c.height - 12);
  const titleY = tagline ? c.height / 2 - 26 : c.height / 2 + 6;
  g.font = tagline ? "bold 92px monospace" : "bold 118px monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "#3fb5ff";
  g.shadowBlur = 40;
  g.fillStyle = "#8fd3ff";
  g.fillText(text, c.width / 2, titleY);
  g.shadowBlur = 0;
  g.fillStyle = "#e6f6ff";
  g.fillText(text, c.width / 2, titleY);
  if (tagline) {
    g.font = "26px monospace";
    g.fillStyle = "#5a89c9";
    g.letterSpacing = "3px";
    g.fillText(tagline.toUpperCase(), c.width / 2, c.height / 2 + 58);
    g.letterSpacing = "0px";
  }
  return finish(c);
}

export function makeWallDisplayTexture(seed: number): THREE.CanvasTexture {
  const c = makeCanvas(512, 256);
  const g = c.getContext("2d")!;
  g.fillStyle = "#06101f";
  g.fillRect(0, 0, c.width, c.height);
  drawChart(g, 20, 30, 472, 110, "#3fb5ff", seed);
  drawBars(g, 20, 150, 472, 90, "#3987e5", seed + 7);
  return finish(c);
}

/** Dark industrial floor: charcoal panels with faint rectangular seams
 * and a little grain. Low contrast on purpose - the lit paths, not the
 * floor pattern, should be what the eye lands on. */
export function makeFloorTexture(): THREE.CanvasTexture {
  const c = makeCanvas(1024, 1024);
  const g = c.getContext("2d")!;
  g.fillStyle = "#0c1119";
  g.fillRect(0, 0, 1024, 1024);
  const rnd = seeded(42);
  const img = g.getImageData(0, 0, 1024, 1024);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n + 2;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = "rgba(60, 80, 110, 0.35)";
  g.lineWidth = 2;
  const panel = 128;
  for (let x = 0; x <= 1024; x += panel) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 1024);
    g.stroke();
  }
  for (let y = 0; y <= 1024; y += panel) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(1024, y);
    g.stroke();
  }
  g.fillStyle = "rgba(90, 120, 160, 0.18)";
  for (let x = 0; x < 1024; x += panel) {
    for (let y = 0; y < 1024; y += panel) {
      g.fillRect(x + 6, y + 6, 4, 4);
      g.fillRect(x + panel - 10, y + panel - 10, 4, 4);
    }
  }
  const t = finish(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  return t;
}

/** Natural Earth 1:110m land, public domain; bundled locally (no map service). */
export function makeGlobeTexture(): THREE.CanvasTexture {
  const c=makeCanvas(2048,1024), g=c.getContext('2d')!;
  g.fillStyle='#031421';g.fillRect(0,0,2048,1024);
  g.strokeStyle='#087D9B';g.lineWidth=1;
  for(let x=0;x<=2048;x+=2048/24){g.beginPath();g.moveTo(x,0);g.lineTo(x,1024);g.stroke();}
  for(let y=0;y<=1024;y+=1024/12){g.beginPath();g.moveTo(0,y);g.lineTo(2048,y);g.stroke();}
  g.fillStyle='#63CDE8';g.strokeStyle='#BDEFFF';g.lineWidth=1.2;
  for(const feature of land.features){
    const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
    for(const polygon of polygons as number[][][][]){
      g.beginPath();
      for(const ring of polygon)ring.forEach(([lon,lat],i)=>{const x=(lon+180)/360*2048,y=(90-lat)/180*1024;i?g.lineTo(x,y):g.moveTo(x,y);});
      g.closePath();g.fill('evenodd');g.stroke();
    }
  }
  return finish(c);
}

/** Wide wall display: branding is a header, live agent state is the content. */
export function makeOperationsDisplayTexture(agents: AgentVisual[]): THREE.CanvasTexture {
  const c = makeCanvas(2800, 620);
  const g = c.getContext("2d")!;
  g.fillStyle = "#050B12"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#00D9FF"; g.fillRect(0, 0, c.width, 10);
  g.fillStyle = "#F3F7FB"; g.font = "700 72px system-ui, sans-serif"; g.fillText("Ops Center", 58, 94);
  g.fillStyle = "#AFC0D0"; g.font = "26px system-ui, sans-serif"; g.fillText("LIVE OPERATIONS · COORDINATOR ROUTING", 720, 92);
  g.strokeStyle = "#1C2D40"; g.lineWidth = 4; g.beginPath(); g.moveTo(50, 124); g.lineTo(2750, 124); g.stroke();
  const rows = agents.filter((agent) => agent.slug !== "coordinator").slice(0, 5);
  const fallback = [
    ["Coordinator", "Routing current request to Linux Ops"],
    ["Linux Ops", "Inspecting ops-host"],
    ["Containers", "Checking container CPU usage"],
    ["Monitoring", "Reviewing Prometheus metrics"],
    ["Security", "Watching vulnerability feed"],
  ];
  rows.forEach((agent, i) => {
    const y = 205 + i * 66;
    const line = agent.activity && agent.state !== "idle" ? agent.activity : (fallback[i]?.[1] ?? "Standing by for operations");
    g.fillStyle = "#20E69A"; g.beginPath(); g.arc(68, y - 9, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#C4D0DD"; g.font = "700 31px system-ui, sans-serif"; g.fillText(agent.name, 102, y);
    g.fillStyle = "#C4D0DD"; g.font = "25px monospace"; g.fillText(line.slice(0, 104), 470, y);
  });
  if (!rows.length) {
    fallback.forEach(([name, line], i) => { const y = 205 + i * 66; g.fillStyle = "#20E69A"; g.fillRect(58, y - 24, 18, 18); g.fillStyle = "#C4D0DD"; g.font = "700 31px system-ui"; g.fillText(name, 102, y); g.fillStyle = "#C4D0DD"; g.font = "25px monospace"; g.fillText(line, 470, y); });
  }
  g.fillStyle = "#268CFF"; g.fillRect(50, 555, 2700, 4); g.fillStyle = "#AFC0D0"; g.font = "21px monospace"; g.fillText("TASK ROUTING ONLINE   ·   9 AGENTS   ·   0 ERRORS", 58, 598);
  return finish(c);
}

/** Small, understated Linux platform board for the rear wall. */
export function makePlatformPanelTexture(): THREE.CanvasTexture {
  const c = makeCanvas(520, 240), g = c.getContext("2d")!;
  g.fillStyle = "#071019"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#C4D0DD"; g.font = "700 24px system-ui"; g.fillText("LINUX PLATFORMS", 24, 38);
  g.fillStyle = "#8799AD"; g.font = "14px monospace"; g.fillText("SUPPORTED HOST OPERATING SYSTEMS", 24, 62);
  [["RED HAT", "#D94352"], ["ALMALINUX", "#20E69A"], ["UBUNTU", "#FF7A1A"]].forEach(([label, color], i) => {
    const x = 24 + i * 164; g.fillStyle = color; g.beginPath(); g.arc(x + 18, 112, 14, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#F3F7FB"; g.font = "700 13px system-ui"; g.fillText(label, x - 4, 152);
  });
  g.fillStyle = "#586A7D"; g.font = "12px monospace"; g.fillText("kernel · shell · ssh · systemd", 24, 205);
  return finish(c);
}
