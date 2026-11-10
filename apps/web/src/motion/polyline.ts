const CHUNK_CONTINUES = 0x20;
const CHUNK_MASK = 0x1f;
const ASCII_OFFSET = 63;

export const POLYLINE_PRECISION = 5;

export function decodePolyline(encoded: string, precision = POLYLINE_PRECISION): Float64Array {
  const factor = 10 ** precision;
  const coordinates: number[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  function readDelta(): number | undefined {
    let result = 0;
    let shift = 0;
    let chunk: number;
    do {
      if (index >= encoded.length) {
        return undefined;
      }
      chunk = encoded.charCodeAt(index++) - ASCII_OFFSET;
      result |= (chunk & CHUNK_MASK) << shift;
      shift += 5;
    } while (chunk >= CHUNK_CONTINUES);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }

  while (index < encoded.length) {
    const latDelta = readDelta();
    const lonDelta = readDelta();
    if (latDelta === undefined || lonDelta === undefined) {
      break;
    }
    lat += latDelta;
    lon += lonDelta;
    coordinates.push(lon / factor, lat / factor);
  }
  return Float64Array.from(coordinates);
}
