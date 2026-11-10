import { describe, expect, it } from "vitest";
import { mirrorDay, parseDayFolders, parseSnapshots } from "./mirror.ts";

const rootIndex = `<html><body><pre><a href="../">../</a>
<a href="2026-10-24/">2026-10-24/</a>                                        24-Oct-2026 21:59                   -
<a href="2026-10-25/">2026-10-25/</a>                                        25-Oct-2026 09:13                   -
<a href="2026-04-10T18%3A09%3A01%2B02%3A00.gtfs-rt.pbf">2026-04-10T18:09:01+02:00.gtfs-rt.pbf</a>
<a href="latest.original.gtfs-rt.pbf">latest.original.gtfs-rt.pbf</a>
</pre></body></html>`;

const dstDay = `<pre><a href="../">../</a>
<a href="2026-10-25T02%3A59%3A01%2B02%3A00.gtfs-rt.pbf">x</a>
<a href="2026-10-25T02%3A00%3A01%2B01%3A00.gtfs-rt.pbf">x</a>
<a href="2026-10-25T10%3A13%3A01%2B01%3A00.gtfs-rt.pbf">x</a>
</pre>`;

describe("mirror listings", () => {
  it("finds the day folders", () => {
    expect(parseDayFolders(rootIndex)).toEqual(["2026-10-24", "2026-10-25"]);
  });

  it("maps snapshot names with a local offset to UTC across the DST switch", () => {
    expect(parseSnapshots(dstDay).map((s) => new Date(s.at).toISOString())).toEqual([
      "2026-10-25T00:59:01.000Z",
      "2026-10-25T01:00:01.000Z",
      "2026-10-25T09:13:01.000Z",
    ]);
    expect(parseSnapshots(dstDay)[1]?.href).toBe("2026-10-25T02%3A00%3A01%2B01%3A00.gtfs-rt.pbf");
  });

  it("skips an entry with a malformed percent escape instead of failing", () => {
    const listing = `<pre><a href="2026-10-25T10%3A0%ZZ.gtfs-rt.pbf">x</a>
<a href="2026-10-25T10%3A13%3A01%2B01%3A00.gtfs-rt.pbf">x</a><a href="2026-10-%E0%A4%A/">x</a></pre>`;
    expect(parseSnapshots(listing).map((s) => new Date(s.at).toISOString())).toEqual([
      "2026-10-25T09:13:01.000Z",
    ]);
    expect(parseDayFolders(listing)).toEqual([]);
  });

  it("names the folder by the German local date", () => {
    expect(mirrorDay(Date.parse("2026-10-24T22:30:00Z"))).toBe("2026-10-25");
    expect(mirrorDay(Date.parse("2026-10-25T22:30:00Z"))).toBe("2026-10-25");
    expect(mirrorDay(Date.parse("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
  });
});
