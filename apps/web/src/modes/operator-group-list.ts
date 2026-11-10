/**
 * The groups that have a colour of their own, in legend order: the five largest after Deutsche Bahn that
 * keep every pair of colours apart (see operator-colours.ts). A group is the top parent organisation the
 * catalogue names (Wikidata item `qid`); every other operator falls into Other.
 */
export const COLOURED_GROUPS = [
  { id: "db", name: "Deutsche Bahn", qid: "Q9322" },
  { id: "transdev", name: "Transdev", qid: "Q104185516" },
  { id: "netinera", name: "Netinera", qid: "Q558401" },
  { id: "kvvh", name: "KVVH", qid: "Q15822360" },
  { id: "hlb", name: "Hessische Landesbahn", qid: "Q896102" },
  { id: "sweg", name: "SWEG", qid: "Q2381732" },
] as const;

export type ColouredGroup = (typeof COLOURED_GROUPS)[number]["id"];
