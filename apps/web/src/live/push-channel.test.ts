import { describe, expect, it } from "vitest";
import {
  FRAMES_CHANNEL,
  type FrameNotice,
  MAX_RECONNECT_MS,
  PushChannel,
  type PushSocket,
  RESET_AFTER_MS,
  SILENCE_MS,
} from "./push-channel.ts";

class FakeSocket implements PushSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }

  serverSays(...lines: unknown[]): void {
    this.onmessage?.({ data: lines.map((line) => JSON.stringify(line)).join("\n") });
  }

  serverCloses(code: number): void {
    this.closed = true;
    this.onclose?.({ code });
  }
}

function setup(random = 1) {
  let wall = 0;
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { callback: () => void; atMs: number }>();
  let nextTimer = 1;
  const notices: FrameNotice[] = [];
  const states: boolean[] = [];
  const channel = new PushChannel(
    {
      open: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback, ms) => {
        const id = nextTimer++;
        timers.set(id, { callback, atMs: wall + ms });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      random: () => random,
      now: () => wall,
    },
    "wss://gerlines.example/connection/websocket",
    { notice: (notice) => notices.push(notice), state: (up) => states.push(up) },
  );
  const advance = (ms: number) => {
    wall += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].atMs - b[1].atMs)) {
      if (timer.atMs <= wall && timers.has(id)) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  const last = () => sockets.at(-1) as FakeSocket;
  const subscribe = () => {
    last().onopen?.();
    last().serverSays({ id: 1, connect: { client: "c", ping: 25, pong: true } });
    last().serverSays({ id: 2, subscribe: {} });
  };
  return { channel, sockets, notices, states, advance, last, subscribe, timers };
}

const NOTICE = { seq: 41, keyframe: 30, oldest: 1, tv: 7 };

describe("the push channel", () => {
  it("connects, subscribes to the frame notices and is up once subscribed", () => {
    const t = setup();
    t.channel.start();
    expect(t.last().url).toBe("wss://gerlines.example/connection/websocket");
    t.last().onopen?.();
    expect(JSON.parse(t.last().sent[0] as string)).toMatchObject({ id: 1, connect: {} });
    expect(t.channel.up).toBe(false);
    t.last().serverSays({ id: 1, connect: { client: "c", ping: 25, pong: true } });
    expect(JSON.parse(t.last().sent[1] as string)).toEqual({
      id: 2,
      subscribe: { channel: FRAMES_CHANNEL },
    });
    t.last().serverSays({ id: 2, subscribe: {} });
    expect(t.channel.up).toBe(true);
    expect(t.states).toEqual([true]);
  });

  it("hands on each frame notice and answers the server's ping", () => {
    const t = setup();
    t.channel.start();
    t.subscribe();
    t.last().serverSays({ push: { channel: FRAMES_CHANNEL, pub: { data: NOTICE } } }, {});
    expect(t.notices).toEqual([NOTICE]);
    expect(t.last().sent.at(-1)).toBe("{}");
  });

  it("drops notices of other channels and notices that are not whole sequences", () => {
    const t = setup();
    t.channel.start();
    t.subscribe();
    t.last().serverSays(
      { push: { channel: "live:probe", pub: { data: NOTICE } } },
      { push: { channel: FRAMES_CHANNEL, pub: { data: { ...NOTICE, seq: "41" } } } },
      { push: { channel: FRAMES_CHANNEL, pub: { data: { ...NOTICE, seq: 1.5 } } } },
      { push: { channel: FRAMES_CHANNEL, pub: { data: { ...NOTICE, tv: -1 } } } },
    );
    t.last().onmessage?.({ data: "not json" });
    expect(t.notices).toEqual([]);
    expect(t.channel.up).toBe(true);
  });

  it("is down when the socket closes and connects again after a growing wait", () => {
    const t = setup();
    t.channel.start();
    t.subscribe();
    t.last().serverCloses(1006);
    expect(t.channel.up).toBe(false);
    expect(t.states).toEqual([true, false]);
    expect(t.sockets).toHaveLength(1);
    t.advance(999);
    expect(t.sockets).toHaveLength(1);
    t.advance(1);
    expect(t.sockets).toHaveLength(2);
    t.last().serverCloses(1006);
    t.advance(1999);
    expect(t.sockets).toHaveLength(2);
    t.advance(1);
    expect(t.sockets).toHaveLength(3);
  });

  it("waits at most the longest wait and starts from the shortest again once subscribed", () => {
    const t = setup();
    t.channel.start();
    for (let i = 0; i < 12; i++) {
      t.last().serverCloses(1006);
      t.advance(MAX_RECONNECT_MS);
    }
    expect(t.sockets).toHaveLength(13);
    t.subscribe();
    t.last().serverCloses(1006);
    t.advance(1000);
    expect(t.sockets).toHaveLength(14);
  });

  it("spreads the waits of many clients with jitter", () => {
    const t = setup(0);
    t.channel.start();
    t.last().serverCloses(1006);
    t.advance(499);
    expect(t.sockets).toHaveLength(1);
    t.advance(1);
    expect(t.sockets).toHaveLength(2);
  });

  it("waits the longest wait after a refusal the server marks as final", () => {
    const t = setup();
    t.channel.start();
    t.last().onopen?.();
    t.last().serverCloses(3501);
    t.advance(MAX_RECONNECT_MS - 1);
    expect(t.sockets).toHaveLength(1);
    t.advance(1);
    expect(t.sockets).toHaveLength(2);
  });

  it("closes and connects again on an error reply to connect or subscribe", () => {
    const t = setup();
    t.channel.start();
    t.last().onopen?.();
    t.last().serverSays({ id: 1, error: { code: 101, message: "unauthorized" } });
    expect(t.sockets[0]?.closed).toBe(true);
    expect(t.channel.up).toBe(false);
    t.advance(1000);
    expect(t.sockets).toHaveLength(2);
    t.last().onopen?.();
    t.last().serverSays({ id: 1, connect: { ping: 25, pong: true } });
    t.last().serverSays({ id: 2, error: { code: 103, message: "permission denied" } });
    expect(t.sockets[1]?.closed).toBe(true);
    expect(t.states).toEqual([]);
  });

  it("gives up a connection that never opens or that falls silent", () => {
    const t = setup();
    t.channel.start();
    t.advance(SILENCE_MS);
    expect(t.sockets[0]?.closed).toBe(true);
    t.advance(1000);
    t.subscribe();
    t.advance(SILENCE_MS - 1);
    expect(t.channel.up).toBe(true);
    t.last().serverSays({});
    t.advance(SILENCE_MS - 1);
    expect(t.channel.up).toBe(true);
    t.advance(1);
    expect(t.channel.up).toBe(false);
    expect(t.sockets[1]?.closed).toBe(true);
  });

  it("stops without connecting again and starts once more on request", () => {
    const t = setup();
    t.channel.start();
    t.subscribe();
    t.channel.stop();
    expect(t.last().closed).toBe(true);
    expect(t.states).toEqual([true, false]);
    expect(t.timers.size).toBe(0);
    t.advance(MAX_RECONNECT_MS * 2);
    expect(t.sockets).toHaveLength(1);
    t.channel.start();
    t.channel.start();
    expect(t.sockets).toHaveLength(2);
  });

  it("connects at once when started again but keeps its backoff within a minute", () => {
    const t = setup();
    t.channel.start();
    t.last().serverCloses(1006);
    t.advance(1000);
    t.last().serverCloses(1006);
    t.advance(2000);
    t.last().serverCloses(1006);
    for (let i = 0; i < 3; i++) {
      t.channel.stop();
      t.advance(5000);
      t.channel.start();
    }
    expect(t.sockets).toHaveLength(6);
    t.last().serverCloses(1006);
    t.advance(7999);
    expect(t.sockets).toHaveLength(6);
    t.advance(1);
    expect(t.sockets).toHaveLength(7);
  });

  it("starts from the shortest wait again a minute after its last failure", () => {
    const t = setup();
    t.channel.start();
    t.last().serverCloses(1006);
    t.advance(1000);
    t.last().serverCloses(1006);
    t.channel.stop();
    t.advance(RESET_AFTER_MS);
    t.channel.start();
    t.last().serverCloses(1006);
    t.advance(1000);
    expect(t.sockets).toHaveLength(4);
  });

  it("is down when the socket cannot be made at all", () => {
    const t = setup();
    const failing = new PushChannel(
      {
        open: () => {
          throw new SyntaxError("bad url");
        },
        setTimeout: () => 1,
        clearTimeout: () => {},
        random: () => 1,
        now: () => 0,
      },
      "nonsense",
      { notice: () => {}, state: () => {} },
    );
    failing.start();
    expect(failing.up).toBe(false);
    expect(t.channel.up).toBe(false);
  });
});
