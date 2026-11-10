const TABLE = (() => {
  const table = new Uint32Array(256 * 4);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = table[n] as number;
    for (let slice = 1; slice < 4; slice++) {
      c = (table[c & 0xff] as number) ^ (c >>> 8);
      table[slice * 256 + n] = c >>> 0;
    }
  }
  return table;
})();

/**
 * Continues a CRC-32 (ISO-HDLC, as in zlib and PNG) over bytes[start, end). Start a new checksum
 * with crc 0.
 */
export function crc32Update(crc: number, bytes: Uint8Array, start: number, end: number): number {
  let c = ~crc >>> 0;
  let i = start;
  for (; i + 4 <= end; i += 4) {
    c ^=
      (bytes[i] as number) |
      ((bytes[i + 1] as number) << 8) |
      ((bytes[i + 2] as number) << 16) |
      ((bytes[i + 3] as number) << 24);
    c =
      (TABLE[768 + (c & 0xff)] as number) ^
      (TABLE[512 + ((c >>> 8) & 0xff)] as number) ^
      (TABLE[256 + ((c >>> 16) & 0xff)] as number) ^
      (TABLE[c >>> 24] as number);
  }
  for (; i < end; i++) c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  return crc32Update(0, bytes, 0, bytes.length);
}
