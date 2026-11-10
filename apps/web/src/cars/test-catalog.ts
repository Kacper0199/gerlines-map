const SLOTS = [
  "body",
  "upper_body",
  "lower_body",
  "window_band",
  "stripe",
  "doors",
  "accent",
  "window",
  "roof",
  "underframe",
  "bogie",
  "gangway",
  "light",
  "reveal",
  "mode",
  "skirt",
  "mask",
  "equipment",
  "housing",
  "glass",
  "sheen",
  "display",
  "tail",
];

function lods(prefix: string) {
  return [0, 1, 2].map((level) => ({ level, file: `models/${prefix}.lod${level}.glb` }));
}

/** Two cars of 20 m on their own bogies (inset 3 m), the second one turned round. */
function conventional(modelId: string) {
  return {
    modelId,
    generic: true,
    livery: { row: 0 },
    formation: [
      { carType: "end", reversed: false },
      { carType: "end", reversed: true },
    ],
    consist: {
      length: 40.5,
      bogieOffsets: [3, 17, 23.5, 37.5],
      pivots: [0, 1, 2, 3].map(() => ({ bogie: "bogie-a" })),
      cars: [
        { front: 0, rear: 1, centreFraction: 0.5 },
        { front: 2, rear: 3, centreFraction: 0.5 },
      ],
    },
    bogies: { "bogie-a": { lods: lods(`${modelId}/bogie-a`) } },
    carTypes: [{ carType: "end", lods: lods(`${modelId}/end`) }],
  };
}

/** Two articulated bodies of 15 m sharing a Jacobs bogie, end overhang 2 m. */
function articulated(modelId: string) {
  return {
    modelId,
    generic: true,
    livery: { row: 1 },
    formation: [
      { carType: "end", reversed: false },
      { carType: "end", reversed: true },
    ],
    consist: {
      length: 30,
      bogieOffsets: [2, 15, 28],
      pivots: [{ bogie: "bogie-a" }, { bogie: "bogie-j" }, { bogie: "bogie-a" }],
      cars: [
        { front: 0, rear: 1, centreFraction: 5.5 / 13 },
        { front: 1, rear: 2, centreFraction: 7.5 / 13 },
      ],
    },
    bogies: {
      "bogie-a": { lods: lods(`${modelId}/bogie-a`) },
      "bogie-j": { lods: lods(`${modelId}/bogie-j`) },
    },
    carTypes: [{ carType: "end", lods: lods(`${modelId}/end`) }],
  };
}

export function testManifest() {
  return {
    schema: 2,
    palette: {
      file: "palette.png",
      columns: 32,
      slots: SLOTS,
      rows: ["neutral", "sbahn-row"],
      modeSlot: "mode",
    },
    models: [
      conventional("generic-reg-emu"),
      conventional("generic-hsr"),
      articulated("generic-sbahn"),
    ],
  };
}

/** testManifest with series models: two of db-412 (the first one listed is drawn) and one of db-423. */
export function seriesManifest() {
  const manifest = testManifest();
  return {
    ...manifest,
    models: [
      ...manifest.models,
      { ...conventional("db-412-7"), generic: false, seriesId: "db-412" },
      { ...conventional("db-412-12"), generic: false, seriesId: "db-412" },
      { ...articulated("db-423"), generic: false, seriesId: "db-423" },
    ],
  };
}

/**
 * seriesManifest with two more palette rows and the livery rules of two series: the db-412 of
 * db-fernverkehr-ag is row 2, the db-423 of db-regio-ag-nrw row 3 (row 4 on line S1).
 */
export function liveryManifest() {
  const manifest = seriesManifest();
  return {
    ...manifest,
    palette: { ...manifest.palette, rows: ["neutral", "sbahn-row", "ice", "nrw", "nrw-s1"] },
    liveries: {
      groups: { db: ["db-fernverkehr-ag", "db-regio-ag-nrw", "db-regio-ag-bayern"] },
      rules: [
        { livery: "ice", row: 2, operator: "db-fernverkehr-ag", group: "db", series: ["db-412"] },
        { livery: "nrw", row: 3, operator: "db-regio-ag-nrw", series: ["db-423"] },
        {
          livery: "nrw-s1",
          row: 4,
          operator: "db-regio-ag-nrw",
          series: ["db-423"],
          lines: ["S1"],
        },
      ],
    },
  };
}
