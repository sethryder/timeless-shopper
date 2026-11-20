// Reads Path of Building's timeless jewel lookup tables (MIT). Layout notes: PoB src/Modules/DataLegionLookUpTableHelper.lua.

export const inflate = async (bytes) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());

// -> Int32Array laid out [seedIdx * lutIdxs.length + i] = global id (see data.names), or -1 for no data.
export const lookup = (jewel, lut, lutIdxs) => {
  const { seedSize } = jewel;
  const toGlobal = (id) => jewel.localToGlobal?.[id] ?? id;
  const out = new Int32Array(seedSize * lutIdxs.length).fill(-1);

  if (!jewel.gvBlockStart) {
    // One byte per (notable, seed).
    lutIdxs.forEach((idx, i) => {
      for (let s = 0; s < seedSize; s++) out[s * lutIdxs.length + i] = toGlobal(lut[idx * seedSize + s]);
    });
    return out;
  }

  // Glorious Vanity: lut[idx * seedSize + s] is the entry length; entries for one node are packed in its block.
  lutIdxs.forEach((idx, i) => {
    let at = jewel.gvBlockStart[idx];
    for (let s = 0; s < seedSize; s++) {
      const len = lut[idx * seedSize + s];
      if (len === 2 || len === 3) {
        out[s * lutIdxs.length + i] = toGlobal(lut[at]); // replacement id, then stat rolls
      } else if (len === 6 || len === 8) {
        // Additions + rolls: PoB names these Might/Legacy of the Vaal by which addition ids dominate.
        let bias = 0;
        for (let k = 0; k < len / 2; k++) bias += toGlobal(lut[at + k]) <= 21 ? 1 : -1;
        out[s * lutIdxs.length + i] = bias >= 0 ? jewel.gvMight : jewel.gvLegacy;
      }
      at += len;
    }
  });
  return out;
};
