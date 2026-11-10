import { sleep } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { WebSocket } from "k6/websockets";
import { summaryOf } from "./summary.js";

const LIVE = `${__ENV.LIVE_ORIGIN || "http://host.docker.internal:8814"}/live/v1`;
const FOLLOWERS = Number(__ENV.FOLLOWERS || 20);
const DURATION_S = Number(__ENV.DURATION_S || 300);
const POLL_MS = Number(__ENV.POLL_MS || 1000);
const MODE = __ENV.MODE === "push" ? "push" : "poll";
const SOCKET_URL = `${(__ENV.CENTRIFUGO_ORIGIN || "http://centrifugo:8000").replace(/^http/, "ws")}/connection/websocket`;
const FRAMES_CHANNEL = "live:frames";
const SAFETY_MS = Number(__ENV.SAFETY_MS || 10000);
const WEBSOCKET_FRAME_BYTES = 2;
const HEAD_KIND = 3;
const HEAD_SECTION = 0x60;
const ENCODED = { "Accept-Encoding": "br, gzip" };

const wire = {
  head: new Counter("traffic_head_bytes"),
  keyframe: new Counter("traffic_keyframe_bytes"),
  delta: new Counter("traffic_delta_bytes"),
};
const fetched = {
  head: new Counter("traffic_heads"),
  keyframe: new Counter("traffic_keyframes"),
  delta: new Counter("traffic_deltas"),
};
const joinBytes = new Counter("traffic_join_bytes");
const steadyBytes = new Counter("traffic_steady_bytes");
const steadySeconds = new Counter("traffic_steady_seconds");
const errors = new Counter("traffic_errors");
const pushBytes = new Counter("traffic_push_bytes");
const notices = new Counter("traffic_notices");
const safetyReads = new Counter("traffic_safety_reads");
const headTime = new Trend("traffic_head_ms", true);
const frameTime = new Trend("traffic_frame_ms", true);

export const options = {
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    followers: {
      executor: "per-vu-iterations",
      vus: FOLLOWERS,
      iterations: 1,
      maxDuration: `${DURATION_S + 60}s`,
    },
  },
};

function headerBytes(response) {
  let total = 0;
  for (const name of Object.keys(response.headers)) {
    total += name.length + String(response.headers[name]).length + 4;
  }
  return total + 17;
}

function bodyBytes(response) {
  const length = Number(response.headers["Content-Length"]);
  return Number.isFinite(length) ? length : 0;
}

function decodeHead(buffer) {
  const view = new DataView(buffer);
  if (view.getUint8(6) !== HEAD_KIND) throw new Error("not a head");
  const headerLength = view.getUint16(8, true);
  const sections = view.getUint16(10, true);
  for (let index = 0; index < sections; index++) {
    const entry = headerLength + index * 12;
    if (view.getUint16(entry, true) !== HEAD_SECTION) continue;
    const offset = view.getUint32(entry + 4, true);
    return {
      timetableVersion: view.getUint32(28, true),
      keyframe: view.getUint32(offset, true),
      latest: view.getUint32(offset + 4, true),
      oldest: view.getUint32(offset + 8, true),
    };
  }
  throw new Error("head without its section");
}

function fetchObject(kind, sequence) {
  const response = http.get(`${LIVE}/${kind === "keyframe" ? "k" : "d"}/${sequence}.bin`, {
    headers: ENCODED,
    responseType: "none",
    tags: { name: kind },
  });
  frameTime.add(response.timings.duration);
  if (response.status !== 200) {
    errors.add(1, { kind });
    return -1;
  }
  const bytes = headerBytes(response) + bodyBytes(response);
  wire[kind].add(bytes);
  fetched[kind].add(1);
  return bytes;
}

function readHead() {
  const response = http.get(`${LIVE}/head`, {
    headers: ENCODED,
    responseType: "binary",
    tags: { name: "head" },
  });
  headTime.add(response.timings.duration);
  if (response.status !== 200) {
    errors.add(1, { kind: "head" });
    return null;
  }
  const bytes = headerBytes(response) + response.body.byteLength;
  wire.head.add(bytes);
  fetched.head.add(1);
  return { head: decodeHead(response.body), bytes };
}

function follow(state, head) {
  let bytes = 0;
  const fresh =
    state.sequence === null ||
    state.timetableVersion !== head.timetableVersion ||
    state.sequence > head.latest ||
    head.oldest > state.sequence + 1;
  let from = state.sequence + 1;
  if (fresh) {
    const got = fetchObject("keyframe", head.keyframe);
    if (got < 0) return { bytes, ok: false };
    bytes += got;
    from = head.keyframe + 1;
  }
  for (let sequence = from; sequence <= head.latest; sequence++) {
    const got = fetchObject("delta", sequence);
    if (got < 0) return { bytes, ok: false };
    bytes += got;
  }
  state.sequence = head.latest;
  state.timetableVersion = head.timetableVersion;
  return { bytes, ok: true };
}

function readAndFollow(state) {
  const read = readHead();
  if (!read) return;
  const step = follow(state, read.head);
  if (!step.ok) state.sequence = null;
  steadyBytes.add(read.bytes + step.bytes);
}

function onPushLine(ws, state, line) {
  if (line === "") return false;
  if (line === "{}") {
    ws.send("{}");
    return false;
  }
  const reply = JSON.parse(line);
  if (reply.id === 1 && reply.connect) {
    ws.send(JSON.stringify({ id: 2, subscribe: { channel: FRAMES_CHANNEL } }));
    return false;
  }
  if (reply.error) {
    errors.add(1, { kind: "push" });
    return false;
  }
  if (reply.id === 2 && reply.subscribe) return true;
  if (reply.push?.channel !== FRAMES_CHANNEL || !reply.push.pub) return false;
  notices.add(1);
  const notice = reply.push.pub.data;
  return state.sequence === null || notice.seq !== state.sequence;
}

/**
 * The web client with push: the head is read when the socket is subscribed, on each notice
 * of a new head, and after SAFETY_MS without a read; notices and pings count as steady bytes.
 */
function followPush(state) {
  const ws = new WebSocket(SOCKET_URL);
  let lastRead = Date.now();
  const read = () => {
    lastRead = Date.now();
    readAndFollow(state);
  };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, connect: {} })));
  ws.addEventListener("message", (event) => {
    const data = String(event.data);
    pushBytes.add(data.length + WEBSOCKET_FRAME_BYTES);
    steadyBytes.add(data.length + WEBSOCKET_FRAME_BYTES);
    let wanted = false;
    for (const line of data.split("\n")) wanted = onPushLine(ws, state, line) || wanted;
    if (wanted) read();
  });
  ws.addEventListener("error", () => errors.add(1, { kind: "push" }));
  const safety = setInterval(() => {
    if (Date.now() - lastRead < SAFETY_MS) return;
    safetyReads.add(1);
    read();
  }, 1000);
  setTimeout(() => {
    clearInterval(safety);
    ws.close();
    steadySeconds.add(DURATION_S);
  }, DURATION_S * 1000);
}

export default function () {
  sleep((Math.random() * POLL_MS) / 1000);
  const state = { sequence: null, timetableVersion: null };
  const first = readHead();
  if (!first) return;
  const joined = follow(state, first.head);
  joinBytes.add(first.bytes + joined.bytes);
  if (MODE === "push") {
    followPush(state);
    return;
  }
  const end = Date.now() + DURATION_S * 1000;
  let last = Date.now();
  while (Date.now() < end) {
    const wait = POLL_MS - (Date.now() - last);
    if (wait > 0) sleep(wait / 1000);
    last = Date.now();
    const read = readHead();
    if (!read) continue;
    const step = follow(state, read.head);
    if (!step.ok) state.sequence = null;
    steadyBytes.add(read.bytes + step.bytes);
  }
  steadySeconds.add(DURATION_S);
}

export function handleSummary(data) {
  return summaryOf(data, "traffic", {
    followers: FOLLOWERS,
    durationSeconds: DURATION_S,
    pollMs: POLL_MS,
    mode: MODE,
  });
}
