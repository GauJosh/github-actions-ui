// CRC32 (IEEE). An error-detecting code used for regression checks against fixture reference values.
// It is not a cryptographic hash and does not authenticate log content (docs/ARCHITECTURE.md §6.6).

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Continues a CRC32 from `previous` (0 to start) over `data`. */
export function crc32(previous: number, data: Uint8Array): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
