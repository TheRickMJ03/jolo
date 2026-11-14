jest.mock("@/FirebaseConfig", () => ({ db: {} }));
jest.mock("@react-native-firebase/firestore", () => ({
  collection: jest.fn(),
  getDocs: jest.fn(),
}));

const { toCafe } = require("@/hooks/useCafes");

const snapshot = (id, data) => ({ id, data: () => data });

describe("toCafe", () => {
  it("keeps the map pin for a café seeded from OpenStreetMap", () => {
    const cafe = toCafe(
      snapshot("osm-node-1", {
        name: "Coffee Culture Roastery",
        location: { latitude: 40.68, longitude: -74.44 },
        ratingSum: 9,
        ratingCount: 2,
      }),
    );
    expect(cafe.coordinate).toEqual({ latitude: 40.68, longitude: -74.44 });
    expect(cafe.rating).toBe(4.5);
  });

  it("has no pin for a café an owner created over iMessage", () => {
    const cafe = toCafe(
      snapshot("owner-19085905037", {
        name: "cafe g",
        address: "princeton",
        ownerPhone: "+19085905037",
      }),
    );
    expect(cafe.coordinate).toBeNull();
    expect(cafe.name).toBe("cafe g");
    expect(cafe.address).toBe("princeton");
    expect(cafe.rating).toBeNull();
    expect(cafe.ratingCount).toBe(0);
  });
});
