import { sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { WebSocket } from "k6/websockets";
import { summaryOf } from "./summary.js";

const CENTRIFUGO = __ENV.CENTRIFUGO_ORIGIN || "http://centrifugo:8000";
const SOCKET_URL = `${CENTRIFUGO.replace(/^http/, "ws")}/connection/websocket`;
const CLIENTS = Number(__ENV.CLIENTS || 500);
const SOCKETS_PER_VU = Number(__ENV.SOCKETS_PER_VU || 100);
const RAMP_S = Number(__ENV.RAMP_S || 15);
const HOLD_S = Number(__ENV.HOLD_S || 60);
const PROBE_EVERY_MS = Number(__ENV.PROBE_EVERY_MS || 1000);
const PROBE_CHANNEL = "live:probe";
const FRAMES_CHANNEL = "live:frames";
const VUS = Math.ceil(CLIENTS / SOCKETS_PER_VU);
const SETTLE_S = 5;

const connectTime = new Trend("push_connect_ms", true);
const subscribeTime = new Trend("push_subscribe_ms", true);
const deliveryDelay = new Trend("push_delivery_ms", true);
const connected = new Counter("push_connected");
const subscribed = new Counter("push_subscribed");
const errors = new Counter("push_errors");
const closedEarly = new Counter("push_closed_early");
const probesSent = new Counter("push_probes_sent");
const probesFailed = new Counter("push_probes_failed");
const probesReceived = new Counter("push_probes_received");
const noticesReceived = new Counter("push_frame_notices");
const bytesReceived = new Counter("push_bytes_received");

export const options = {
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    clients: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: `${RAMP_S + HOLD_S + 60}s`,
      exec: "clients",
    },
    publisher: {
      executor: "constant-vus",
      vus: 1,
      duration: `${HOLD_S - SETTLE_S}s`,
      startTime: `${RAMP_S + SETTLE_S}s`,
      exec: "publisher",
    },
  },
};

function socketsOf(group) {
  const first = group * SOCKETS_PER_VU;
  return Math.max(0, Math.min(SOCKETS_PER_VU, CLIENTS - first));
}

const SUBSCRIBE = [PROBE_CHANNEL, FRAMES_CHANNEL]
  .map((channel, index) => JSON.stringify({ id: 2 + index, subscribe: { channel } }))
  .join("\n");

function onPush(push) {
  if (push.channel === PROBE_CHANNEL) {
    deliveryDelay.add(Date.now() - push.pub.data.t);
    probesReceived.add(1);
  } else if (push.channel === FRAMES_CHANNEL) {
    noticesReceived.add(1);
  }
}

function onReply(ws, client, reply) {
  if (reply.id === 1 && reply.connect) {
    client.connectedAt = Date.now();
    connectTime.add(client.connectedAt - client.startedAt);
    connected.add(1);
    client.subscribeSentAt = Date.now();
    ws.send(SUBSCRIBE);
  } else if (reply.id === 2 && reply.subscribe) {
    subscribeTime.add(Date.now() - client.subscribeSentAt);
    subscribed.add(1);
  } else if (reply.error) {
    errors.add(1, { kind: `reply_${reply.error.code}` });
  } else if (reply.push?.pub) {
    onPush(reply.push);
  }
}

function openClient(closeAt) {
  const client = { startedAt: Date.now(), connectedAt: 0, subscribeSentAt: 0, closing: false };
  const ws = new WebSocket(SOCKET_URL);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ id: 1, connect: { name: "gerlines-load" } }));
  });

  ws.addEventListener("message", (event) => {
    bytesReceived.add(event.data.length);
    for (const line of String(event.data).split("\n")) {
      if (line === "{}") ws.send("{}");
      else if (line !== "") onReply(ws, client, JSON.parse(line));
    }
  });

  ws.addEventListener("error", () => {
    errors.add(1, { kind: client.connectedAt === 0 ? "connect" : "socket" });
  });

  ws.addEventListener("close", () => {
    if (!client.closing) closedEarly.add(1);
  });

  setTimeout(() => {
    client.closing = true;
    ws.close();
  }, closeAt - Date.now());
}

export function clients() {
  const group = exec.scenario.iterationInTest;
  const count = socketsOf(group);
  const closeAt = Date.now() + (RAMP_S + HOLD_S) * 1000;
  for (let index = 0; index < count; index++) {
    const slot = (index * VUS + group) / (VUS * SOCKETS_PER_VU);
    setTimeout(() => openClient(closeAt), slot * RAMP_S * 1000);
  }
}

const publishParams = {
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": __ENV.CENTRIFUGO_HTTP_API_KEY || "change-me-locally",
  },
  tags: { name: "publish" },
};

let probeNumber = 0;

export function publisher() {
  const sentAt = Date.now();
  probeNumber++;
  const response = http.post(
    `${CENTRIFUGO}/api/publish`,
    JSON.stringify({ channel: PROBE_CHANNEL, data: { t: sentAt, n: probeNumber } }),
    publishParams,
  );
  if (response.status === 200 && !String(response.body).includes('"error"')) {
    probesSent.add(1);
  } else {
    probesFailed.add(1);
  }
  const wait = PROBE_EVERY_MS - (Date.now() - sentAt);
  if (wait > 0) sleep(wait / 1000);
}

export function handleSummary(data) {
  return summaryOf(data, "push", {
    clients: CLIENTS,
    socketsPerVu: SOCKETS_PER_VU,
    rampSeconds: RAMP_S,
    holdSeconds: HOLD_S,
    probeEveryMs: PROBE_EVERY_MS,
  });
}
