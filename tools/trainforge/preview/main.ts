import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

interface LodEntry {
  level: number;
  file: string;
  bodyTriangles: number;
  bytes: number;
}
interface CarEntry {
  carType: string;
  lengthM: number;
  estimated: string[];
  lods: LodEntry[];
}
interface BogieEntry {
  lods: { level: number; file: string; triangles: number; bytes: number }[];
}
interface ModelEntry {
  modelId: string;
  name: string;
  category: string;
  seriesId: string | null;
  livery: { id: string };
  formation: { carType: string; reversed: boolean }[];
  consist: {
    length: number;
    bogieOffsets: number[];
    pivots: { offset: number; kind: string; bogie: string }[];
    cars: { front: number; rear: number; centreFraction: number }[];
  };
  bogies: Record<string, BogieEntry>;
  carTypes: CarEntry[];
}
interface Manifest {
  palette: { file: string; rows: string[]; slots: string[]; columns: number; modeSlot: string };
  models: ModelEntry[];
}

/** Category colours of DESIGN.md per theme: what the colour mode Category paints on the roof band. */
const CATEGORY = {
  dark: {
    hsr: "#EDE6D6",
    ld: "#B9AF98",
    night: "#EDE6D6",
    rfast: "#9CC5F6",
    reg: "#5F97DE",
    sbahn: "#5FC08A",
    foreign: "#8F87A8",
  },
  light: {
    hsr: "#26231E",
    ld: "#6A604C",
    night: "#26231E",
    rfast: "#3F83D6",
    reg: "#1F5EB0",
    sbahn: "#17814C",
    foreign: "#6F6790",
  },
} as const;

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
const view = params.get("view") ?? "overview";
const LAND = theme === "light" ? 0xedebe5 : 0x1a1b1d;
const BALLAST = theme === "light" ? 0xc9c4b8 : 0x323336;
const RAIL = theme === "light" ? 0x5f5b54 : 0x8d8a84;
const RADIUS = params.get("straight") === "1" ? 1e6 : 260;
const TRACK_SPACING = 9;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(LAND);
scene.add(new THREE.HemisphereLight(0xffffff, theme === "light" ? 0x8c877d : 0x2c2e32, 1.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-60, 120, 80);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.5, 4000);

/** Track centre line: arc length s along a circle bending to the right of travel. */
function trackPoint(s: number, offset: number): THREE.Vector3 {
  const r = RADIUS + offset;
  const phi = s / RADIUS;
  return new THREE.Vector3(r * Math.sin(phi), 0, RADIUS - r * Math.cos(phi));
}

function trackYaw(s: number): number {
  return -s / RADIUS;
}

function addTrack(offset: number, from: number, to: number) {
  const ballast = new THREE.MeshLambertMaterial({ color: BALLAST });
  const rail = new THREE.LineBasicMaterial({ color: RAIL });
  const steps = 160;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = from + ((to - from) * i) / steps;
    for (const side of [-1.6, 1.6]) {
      const p = trackPoint(s, offset + side);
      positions.push(p.x, 0.01, p.z);
    }
    if (i < steps) indices.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  scene.add(new THREE.Mesh(geometry, ballast));
  for (const side of [-0.7175, 0.7175]) {
    const points = Array.from({ length: steps + 1 }, (_, i) =>
      trackPoint(from + ((to - from) * i) / steps, offset + side).setY(0.03),
    );
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), rail));
  }
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<THREE.Object3D>>();
let bandColour = "#8c877d";
let modeColumn = 14;
let columns = 32;
let liveryRow: { atlas: HTMLImageElement; row: number } | null = null;

/** Paints the roof band cell of a loaded palette, as WP-5.2 does per instance. */
function paintBand(object: THREE.Object3D) {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial | undefined;
    const image = material?.map?.image as ImageBitmap | HTMLImageElement | undefined;
    if (!material?.map || !image) return;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d") as CanvasRenderingContext2D;
    context.drawImage(image, 0, 0);
    if (liveryRow) {
      context.imageSmoothingEnabled = false;
      context.drawImage(
        liveryRow.atlas,
        0,
        liveryRow.row,
        columns,
        1,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    }
    context.fillStyle = bandColour;
    context.fillRect((modeColumn / columns) * image.width, 0, image.width / columns, image.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = material.map.flipY;
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
    material.needsUpdate = true;
  });
}

function load(file: string): Promise<THREE.Object3D> {
  let found = cache.get(file);
  if (!found) {
    found = loader.loadAsync(`./${file}`).then((gltf) => {
      paintBand(gltf.scene);
      return gltf.scene;
    });
    cache.set(file, found);
  }
  return found.then((object) => object.clone());
}

/** The leading car of the first unit drawn, whose frame the matched camera is given in. */
let leadCar: THREE.Object3D | null = null;

async function placeUnit(model: ModelEntry, level: number, offset: number, head: number) {
  const { consist } = model;
  const carIndex = new Map(model.carTypes.map((c) => [c.carType, c]));
  const pivots = consist.bogieOffsets.map((o) => head - o);
  await Promise.all(
    model.formation.map(async (slot, i) => {
      const car = carIndex.get(slot.carType) as CarEntry;
      const lod = car.lods.find((l) => l.level === level) as LodEntry;
      const placement = consist.cars[i] as { front: number; rear: number; centreFraction: number };
      const pf = trackPoint(pivots[placement.front] as number, offset);
      const pr = trackPoint(pivots[placement.rear] as number, offset);
      const object = await load(lod.file);
      object.position.copy(pf.clone().lerp(pr, placement.centreFraction));
      const d = pf.clone().sub(pr).normalize();
      object.rotation.y = Math.atan2(-d.z, d.x) + (slot.reversed ? Math.PI : 0);
      if (i === 0 && !leadCar) leadCar = object;
      scene.add(object);
    }),
  );
  await Promise.all(
    consist.pivots.map(async (pivot, index) => {
      const file = model.bogies[pivot.bogie]?.lods.find((l) => l.level === level)?.file;
      if (!file) return;
      const s = pivots[index] as number;
      const object = await load(file);
      object.position.copy(trackPoint(s, offset));
      object.rotation.y = trackYaw(s);
      scene.add(object);
    }),
  );
}

function label(text: string, at: THREE.Vector3) {
  const el = document.createElement("div");
  el.className = "label";
  el.textContent = text;
  document.body.appendChild(el);
  const p = at.clone().project(camera);
  el.style.left = `${((p.x + 1) / 2) * window.innerWidth}px`;
  el.style.top = `${((1 - p.y) / 2) * window.innerHeight}px`;
}

function lodTotals(model: ModelEntry, level: number) {
  const byType = new Map(model.carTypes.map((c) => [c.carType, c]));
  let triangles = 0;
  const files = new Map<string, number>();
  for (const slot of model.formation) {
    const lod = byType.get(slot.carType)?.lods.find((l) => l.level === level) as LodEntry;
    triangles += lod.bodyTriangles;
    files.set(lod.file, lod.bytes);
  }
  for (const pivot of model.consist.pivots) {
    const lod = model.bogies[pivot.bogie]?.lods.find((l) => l.level === level);
    if (!lod) continue;
    triangles += lod.triangles;
    files.set(lod.file, lod.bytes);
  }
  const bytes = [...files.values()].reduce((a, b) => a + b, 0);
  return { triangles, bytes };
}

function panel(model: ModelEntry, levels: number[]) {
  const rows = levels
    .map((level) => {
      const t = lodTotals(model, level);
      return `<tr><td>LOD ${level}</td><td>${t.triangles.toLocaleString("en")}</td><td>${t.bytes.toLocaleString("en")}</td></tr>`;
    })
    .join("");
  const estimated = new Set(model.carTypes.flatMap((c) => c.estimated));
  const el = document.getElementById("panel") as HTMLElement;
  if (params.get("panel") === "0") el.style.display = "none";
  el.innerHTML = `<h1>${model.name}</h1>
    <div class="muted">${model.modelId}, livery ${model.livery.id}, ${model.formation.length} cars, ${model.consist.length.toFixed(1)} m</div>
    <table><tr><th>Level</th><th>Triangles</th><th>Bytes</th></tr>${rows}</table>
    <div class="muted">Estimated ${[...estimated].sort().join(", ") || "none"}</div>`;
}

type Placement = (half: number, middleOffset: number) => void;

function mapCamera(half: number, middleOffset: number) {
  const top = view === "map-top";
  const distance = Number(params.get("dist") ?? 150);
  const pitch = top ? 0 : (Math.PI / 180) * Number(params.get("pitch") ?? 55);
  const target = trackPoint(half - 30, middleOffset).setY(1.5);
  const outward = new THREE.Vector3(0, 0, -1);
  camera.position
    .copy(target)
    .addScaledVector(outward, Math.sin(pitch) * distance)
    .setY(Math.cos(pitch) * distance + 1.5);
  camera.up.set(top ? 1 : 0, top ? 0 : 1, 0);
  camera.lookAt(target);
}

const CAMERAS: Readonly<Record<string, Placement>> = {
  photo: (half) => {
    const nose = trackPoint(half, 0);
    const tangent = trackPoint(half + 1, 0)
      .sub(nose)
      .normalize();
    const outward = new THREE.Vector3(tangent.z, 0, -tangent.x);
    camera.position.copy(nose).addScaledVector(tangent, 22).addScaledVector(outward, -13).setY(3.2);
    camera.lookAt(trackPoint(half - 13, 0).setY(1.9));
  },
  nose: (half) => {
    const target = trackPoint(half - 8, 0).setY(2.2);
    camera.position.copy(trackPoint(half + 14, -14)).setY(6.5);
    camera.lookAt(target);
  },
  side: (half) => {
    const target = trackPoint(half - 26, 0).setY(2.0);
    camera.position.copy(trackPoint(half - 26, -42)).setY(4.5);
    camera.lookAt(target);
  },
  profile: (half) => {
    const target = trackPoint(half - 6, 0).setY(2.0);
    camera.fov = 5;
    camera.position.copy(trackPoint(half - 6, -95)).setY(2.0);
    camera.updateProjectionMatrix();
    camera.lookAt(target);
  },
  front: (half) => {
    const nose = trackPoint(half, 0);
    const tangent = trackPoint(half + 1, 0)
      .sub(nose)
      .normalize();
    camera.fov = 12;
    camera.position.copy(nose).addScaledVector(tangent, 40).setY(2.2);
    camera.updateProjectionMatrix();
    camera.lookAt(nose.clone().setY(2.0));
  },
  cam: (half) => {
    const way = params.get("end") === "rear" ? -1 : 1;
    const head = way * half;
    const nose = trackPoint(head - way * Number(params.get("cx") ?? 0), 0);
    const tangent = trackPoint(head + way, 0)
      .sub(nose)
      .normalize();
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const az = (Math.PI / 180) * Number(params.get("az") ?? 30);
    const distance = Number(params.get("dist") ?? 25);
    camera.fov = Number(params.get("fov") ?? 30);
    camera.position
      .copy(nose)
      .addScaledVector(tangent, Math.cos(az) * distance)
      .addScaledVector(side, Math.sin(az) * distance)
      .setY(Number(params.get("h") ?? 2.0));
    camera.updateProjectionMatrix();
    const back = way * Number(params.get("tx") ?? 4);
    camera.lookAt(trackPoint(head - back, 0).setY(Number(params.get("ty") ?? 2.0)));
  },
  match: () => {
    /* Camera matched to a photo, given in the leading car's frame: x forward, y left, z up, metres. */
    const read = (key: string) => (params.get(key) ?? "0,0,0").split(",").map(Number);
    const toWorld = ([x, y, z]: number[]) => {
      leadCar?.updateMatrixWorld();
      const local = new THREE.Vector3(x ?? 0, z ?? 0, -(y ?? 0));
      return leadCar ? local.applyMatrix4(leadCar.matrixWorld) : local;
    };
    const position = toWorld(read("cam"));
    const target = toWorld(read("look"));
    camera.fov = Number(params.get("fov") ?? 35);
    camera.position.copy(position);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.rotateZ((Math.PI / 180) * -Number(params.get("roll") ?? 0));
    camera.updateProjectionMatrix();
  },
  exact: (half) => {
    const way = params.get("end") === "rear" ? -1 : 1;
    const nose = trackPoint(way * half, 0);
    const vec = (name: string) => {
      const [x = 0, y = 0, z = 0] = (params.get(name) ?? "").split(",").map(Number);
      return new THREE.Vector3(way * x, y, way * z);
    };
    camera.fov = Number(params.get("fov") ?? 30);
    camera.position.copy(nose).add(vec("cp"));
    camera.updateProjectionMatrix();
    camera.lookAt(nose.clone().add(vec("ct")));
  },
  "map-top": mapCamera,
  "map-oblique": mapCamera,
  top: (half, middleOffset) => {
    const target = trackPoint(0, middleOffset);
    camera.position.copy(target).add(new THREE.Vector3(0, half * 2.4 + 40, 1));
    camera.lookAt(target);
  },
  overview: (half, middleOffset) => {
    const target = trackPoint(half * 0.35, middleOffset).setY(1.5);
    camera.position.copy(trackPoint(half * 0.35 + 30, -half * 0.9 - 30)).setY(half * 0.55 + 18);
    camera.lookAt(target);
  },
};

function frame(model: ModelEntry, levels: number[]) {
  const half = model.consist.length / 2;
  const front = trackPoint(half, 0);
  const middleOffset = ((levels.length - 1) * TRACK_SPACING) / 2;
  (CAMERAS[view] ?? (CAMERAS.overview as Placement))(half, middleOffset);
  camera.updateMatrixWorld();
  if (!view.startsWith("map-") && params.get("panel") !== "0") {
    for (const [i, level] of levels.entries()) {
      label(`LOD ${level}`, trackPoint(half + 6, i * TRACK_SPACING).setY(2));
    }
  }
  return front;
}

function renderOrtho(half: number) {
  const at = (params.get("c") ?? "0,2,0").split(",").map(Number);
  const scale = Number(params.get("scale") ?? 200);
  const nose = trackPoint(half, 0).add(new THREE.Vector3(at[0], at[1], at[2]));
  const w = window.innerWidth / (2 * scale);
  const h = window.innerHeight / (2 * scale);
  const ortho = new THREE.OrthographicCamera(-w, w, h, -h, 0.1, 400);
  const axis = params.get("ortho");
  ortho.up.set(0, 1, 0);
  if (axis === "side") ortho.position.copy(nose).add(new THREE.Vector3(0, 0, 100));
  else if (axis === "front") ortho.position.copy(nose).add(new THREE.Vector3(100, 0, 0));
  else {
    ortho.up.set(0, 0, -1);
    ortho.position.copy(nose).add(new THREE.Vector3(0, 100, 0));
  }
  ortho.lookAt(nose);
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh || (node as THREE.Line).isLine) {
      if (params.get("sil") === "1") {
        mesh.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
        if ((node as THREE.Line).isLine) node.visible = false;
      }
    }
  });
  if (params.get("sil") === "1") scene.background = new THREE.Color(0x000000);
  renderer.render(scene, ortho);
}

async function main() {
  const manifest = (await (await fetch("./manifest.json")).json()) as Manifest;
  const model =
    manifest.models.find((m) => m.modelId === params.get("model")) ?? manifest.models[0];
  if (!model) return;
  const levels = (params.get("lods") ?? "0,1,2").split(",").map(Number);
  const half = model.consist.length / 2;
  const palette = CATEGORY[theme] as Record<string, string>;
  bandColour = params.get("band") ?? palette[model.category] ?? bandColour;
  columns = manifest.palette.columns;
  const livery = params.get("livery");
  const row = livery ? manifest.palette.rows.indexOf(livery) : -1;
  if (row >= 0) {
    const atlas = new Image();
    atlas.src = `./${manifest.palette.file}`;
    await atlas.decode();
    liveryRow = { atlas, row };
  }
  modeColumn = manifest.palette.slots.indexOf(manifest.palette.modeSlot);
  for (const [i, level] of levels.entries()) {
    if (params.get("sil") !== "1") addTrack(i * TRACK_SPACING, -half - 60, half + 60);
    await placeUnit(model, level, i * TRACK_SPACING, half);
  }
  if (params.get("ortho")) {
    renderOrtho(half);
    document.body.dataset.ready = "true";
    return;
  }
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: LAND }),
  );
  ground.position.y = -0.02;
  scene.add(ground);
  frame(model, levels);
  panel(model, levels);
  renderer.render(scene, camera);
  document.body.dataset.ready = "true";
}

void main();
