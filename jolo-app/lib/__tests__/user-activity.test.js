import { recentCafes, recentRequests } from "@/lib/user-activity";

const older = new Date("2026-11-14T12:00:00Z");
const newer = new Date("2026-11-15T12:00:00Z");

const dunkin = { id: "dunkin", name: "Dunkin'" };
const dunkinSummit = { id: "dunkin-summit", name: "Dunkin' Summit" };
const coffeeBox = { id: "box", name: "The Coffee Box" };
const cafes = [dunkinSummit, coffeeBox, dunkin];

describe("recentRequests", () => {
  it("puts the latest request first and skips a repeated one", () => {
    const requests = recentRequests([
      { id: "1", type: "search", text: "oat milk latte", createdAt: older },
      { id: "2", type: "search", text: "chai tea", createdAt: newer },
      { id: "3", type: "search", text: "  Chai tea ", createdAt: new Date("2026-11-15T13:00:00Z") },
    ]);
    expect(requests.map((request) => request.text)).toEqual(["Chai tea", "oat milk latte"]);
  });

  it("keeps an iMessage question, and the cafés that question found", () => {
    const requests = recentRequests([
      { id: "1", type: "search", text: "oat milk latte", createdAt: older },
      {
        id: "2",
        type: "search",
        text: "chai tea",
        cafeIds: ["dunkin"],
        historyOnly: true,
        createdAt: newer,
      },
      { id: "3", type: "search", text: "can I get a chai tea", createdAt: newer },
    ]);
    expect(requests.map((request) => request.text)).toEqual(["can I get a chai tea", "oat milk latte"]);

    const history = recentCafes(
      [
        {
          id: "2",
          type: "search",
          text: "chai tea",
          cafeIds: ["box", "missing"],
          historyOnly: true,
          createdAt: newer,
        },
      ],
      cafes,
    );
    expect(history.map((cafe) => cafe.name)).toEqual(["The Coffee Box", "Café"]);
  });
});

describe("recentCafes", () => {
  it("lists cafés that matched a search, and not a drink request", () => {
    const history = recentCafes(
      [
        { id: "1", type: "search", text: "chai tea", createdAt: newer },
        { id: "2", type: "search", text: "dunkin", createdAt: older },
      ],
      [...cafes, { id: "tea", name: "Tea Room" }, { id: "chai", name: "Chai" }],
    );
    expect(history.map((cafe) => cafe.id)).toEqual(["dunkin", "dunkin-summit"]);
  });

  it("keeps a café the person opened, newest first", () => {
    const history = recentCafes(
      [
        { id: "1", type: "search", text: "dunkin", createdAt: older },
        { id: "2", type: "search", text: "The Coffee Box", cafeId: "box", createdAt: newer },
      ],
      cafes,
    );
    expect(history.map((cafe) => cafe.id)).toEqual(["box", "dunkin", "dunkin-summit"]);
  });

  it("still names a café that is no longer in the list", () => {
    const history = recentCafes(
      [{ id: "1", type: "search", text: "Barbara's", cafeId: "barbaras", createdAt: newer }],
      [],
    );
    expect(history).toEqual([{ id: "barbaras", name: "Barbara's" }]);
  });
});
