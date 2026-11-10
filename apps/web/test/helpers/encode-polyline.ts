function encodeValue(value: number): string {
  let remaining = value < 0 ? ~(value << 1) : value << 1;
  let encoded = "";
  while (remaining >= 0x20) {
    encoded += String.fromCharCode((0x20 | (remaining & 0x1f)) + 63);
    remaining >>= 5;
  }
  return encoded + String.fromCharCode(remaining + 63);
}

export function encodePolyline(
  points: readonly (readonly [lon: number, lat: number])[],
  precision = 5,
): string {
  const factor = 10 ** precision;
  let previousLon = 0;
  let previousLat = 0;
  let encoded = "";
  for (const [lon, lat] of points) {
    const roundedLat = Math.round(lat * factor);
    const roundedLon = Math.round(lon * factor);
    encoded += encodeValue(roundedLat - previousLat) + encodeValue(roundedLon - previousLon);
    previousLat = roundedLat;
    previousLon = roundedLon;
  }
  return encoded;
}
