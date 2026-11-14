import { appendEvent, buildEvent, byTime, EVENT_TYPES } from "@/lib/events";

describe("buildEvent", () => {
  it("keeps a search and trims the text", () => {
    expect(buildEvent({ type: "search", text: "  oat milk latte  " })).toEqual({
      type: "search",
      text: "oat milk latte",
    });
  });

  it("requires a drink on save, order, dismiss, and open", () => {
    expect(() => buildEvent({ type: "purchase", text: "cortado" })).toThrow(/drink/);
    const event = buildEvent({
      type: "purchase",
      cafeId: "demo-barbaras",
      itemId: "cortado",
      itemName: "Cortado",
    });
    expect(event).toMatchObject({
      type: "purchase",
      cafeId: "demo-barbaras",
      itemId: "cortado",
      itemName: "Cortado",
    });
  });

  it("rejects an unknown type", () => {
    expect(() => buildEvent({ type: "html", text: "nope" })).toThrow(/Unknown event/);
  });

  it("covers the six types the rules allow", () => {
    expect(EVENT_TYPES).toEqual(["search", "save", "unsave", "purchase", "dismiss", "open"]);
  });
});

describe("appendEvent", () => {
  it("appends without changing the log it was given", () => {
    const log = [];
    const next = appendEvent(log, { type: "search", text: "cortado" });
    expect(log).toEqual([]);
    expect(next).toHaveLength(1);
    expect(next[0].text).toBe("cortado");
  });
});

describe("byTime", () => {
  it("sorts oldest first so a later unsave wins", () => {
    const older = new Date("2026-11-01T00:00:00Z");
    const newer = new Date("2026-11-10T00:00:00Z");
    const sorted = byTime([
      { type: "unsave", createdAt: newer },
      { type: "save", createdAt: older },
    ]);
    expect(sorted.map((event) => event.type)).toEqual(["save", "unsave"]);
  });
});
