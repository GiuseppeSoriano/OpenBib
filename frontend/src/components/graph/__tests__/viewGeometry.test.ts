import { describe, expect, it } from "vitest";
import { centreFor, freeArea } from "@/components/graph/viewGeometry";

const canvas = { left: 0, top: 0, right: 1000, bottom: 600 };

describe("freeArea", () => {
  it("is the whole canvas without overlays, or with ones outside it", () => {
    expect(freeArea(canvas, [])).toEqual(canvas);
    expect(freeArea(canvas, [{ left: 1100, top: 0, right: 1300, bottom: 200 }])).toEqual(canvas);
  });

  it("keeps clear of the selected-paper card in the top-right corner", () => {
    const card = { left: 684, top: 16, right: 984, bottom: 336 };
    expect(freeArea(canvas, [card])).toEqual({ left: 0, top: 0, right: 684, bottom: 600 });
  });

  it("keeps above a bottom sheet", () => {
    const sheet = { left: 0, top: 330, right: 390, bottom: 760 };
    expect(freeArea({ left: 0, top: 0, right: 390, bottom: 700 }, [sheet])).toEqual({
      left: 0,
      top: 0,
      right: 390,
      bottom: 330,
    });
  });

  it("falls back to the whole canvas when too little is left", () => {
    expect(freeArea(canvas, [{ left: 0, top: 50, right: 1000, bottom: 600 }])).toEqual(canvas);
  });
});

describe("centreFor", () => {
  it("centres the point itself when the free area is the canvas", () => {
    expect(centreFor({ x: 10, y: 20 }, 2, { width: 1000, height: 600 }, canvas)).toEqual({ x: 10, y: 20 });
  });

  it("shifts the view so the point lands in the middle of the free area", () => {
    const free = { left: 0, top: 0, right: 600, bottom: 600 };
    // The free middle is 200px left of the canvas's: the centre moves right by 200 / k.
    expect(centreFor({ x: 10, y: 20 }, 2, { width: 1000, height: 600 }, free)).toEqual({ x: 110, y: 20 });
  });
});
