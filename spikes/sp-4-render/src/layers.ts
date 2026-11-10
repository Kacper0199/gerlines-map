import type { Layer } from "@deck.gl/core";
import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { CubeGeometry } from "@luma.gl/engine";
import type { ChannelPayload, TierPayload } from "./protocol.ts";

export const LABEL_LAYER_ID = "highway_name_other";

const TRAIN_WIDTH_METRES = 3;

const carMesh = new CubeGeometry();

function chevronAtlas(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d canvas unavailable");
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.moveTo(60, 32);
  context.lineTo(8, 6);
  context.lineTo(22, 32);
  context.lineTo(8, 58);
  context.closePath();
  context.fill();
  return canvas.toDataURL("image/png");
}

const ICON_ATLAS = chevronAtlas();
const chevronIcon = (): string => "chevron";
const ICON_MAPPING = { chevron: { x: 0, y: 0, width: 64, height: 64, mask: true } };

function view(channel: ChannelPayload | undefined) {
  if (!channel) throw new Error("missing channel");
  switch (channel.kind) {
    case "f64":
      return new Float64Array(channel.buffer, 0, channel.length);
    case "f32":
      return new Float32Array(channel.buffer, 0, channel.length);
    case "u8":
      return new Uint8Array(channel.buffer, 0, channel.length);
    case "u32":
      return new Uint32Array(channel.buffer, 0, channel.length);
  }
}

function f64(channel: ChannelPayload | undefined): Float64Array {
  return view(channel) as Float64Array;
}

function f32(channel: ChannelPayload | undefined): Float32Array {
  return view(channel) as Float32Array;
}

function u8(channel: ChannelPayload | undefined): Uint8Array {
  return view(channel) as Uint8Array;
}

function u32(channel: ChannelPayload | undefined): Uint32Array {
  return view(channel) as Uint32Array;
}

export function dotsLayer(payload: TierPayload, opacity: number): Layer {
  return new ScatterplotLayer({
    id: "trains-dots",
    beforeId: LABEL_LAYER_ID,
    data: {
      length: payload.count,
      attributes: {
        getPosition: { value: f64(payload.channels.position), size: 3 },
        getFillColor: { value: u8(payload.channels.color), size: 4, normalized: true },
      },
    },
    getRadius: 3,
    radiusUnits: "pixels",
    radiusMinPixels: 2,
    opacity,
    antialiasing: true,
    pickable: false,
  });
}

export function iconsLayer(payload: TierPayload, opacity: number): Layer {
  return new IconLayer({
    id: "trains-icons",
    beforeId: LABEL_LAYER_ID,
    data: {
      length: payload.count,
      attributes: {
        getPosition: { value: f64(payload.channels.position), size: 3 },
        getAngle: { value: f32(payload.channels.angle), size: 1 },
        getColor: { value: u8(payload.channels.color), size: 4, normalized: true },
      },
    },
    iconAtlas: ICON_ATLAS,
    iconMapping: ICON_MAPPING,
    getIcon: chevronIcon,
    getSize: 18,
    sizeUnits: "pixels",
    opacity,
    pickable: false,
  });
}

export function slicesLayer(payload: TierPayload, opacity: number): Layer {
  return new PathLayer({
    id: "trains-slices",
    beforeId: LABEL_LAYER_ID,
    data: {
      length: payload.count,
      startIndices: u32(payload.channels.startIndices),
      attributes: {
        getPath: { value: f64(payload.channels.position), size: 3 },
        getColor: { value: u8(payload.channels.color), size: 4, normalized: true },
      },
    },
    _pathType: "open",
    getWidth: TRAIN_WIDTH_METRES,
    widthUnits: "meters",
    widthMinPixels: 3,
    capRounded: false,
    jointRounded: false,
    opacity,
    pickable: false,
  });
}

export function carsLayer(payload: TierPayload, opacity: number): Layer {
  return new SimpleMeshLayer({
    id: "trains-cars",
    beforeId: LABEL_LAYER_ID,
    data: {
      length: payload.count,
      attributes: {
        getPosition: { value: f64(payload.channels.position), size: 3 },
        instanceModelMatrix: { value: f32(payload.channels.matrix), size: 12 },
        getColor: { value: u8(payload.channels.color), size: 4, normalized: true },
      },
    },
    mesh: carMesh,
    opacity,
    pickable: false,
  });
}

export function buildLayer(payload: TierPayload, opacity: number): Layer {
  switch (payload.tier) {
    case "dots":
      return dotsLayer(payload, opacity);
    case "icons":
      return iconsLayer(payload, opacity);
    case "slices":
      return slicesLayer(payload, opacity);
    case "cars":
      return carsLayer(payload, opacity);
  }
}
