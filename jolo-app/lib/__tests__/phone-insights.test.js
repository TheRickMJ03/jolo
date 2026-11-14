import { countRows, humanizeKey, relativeDay, weekLabel } from "@/lib/insights";
import { formatPhone, toE164 } from "@/lib/phone";

describe("toE164", () => {
  it("reads the ways people type US numbers", () => {
    for (const input of [
      "(908) 555-1234",
      "908.555.1234",
      "908 555 1234",
      "1-908-555-1234",
      "+1 908 555 1234",
    ]) {
      expect(toE164(input)).toBe("+19085551234");
    }
  });

  it("keeps international numbers that start with +", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("rejects what it can't read", () => {
    for (const input of ["", "555-1234", "call me", "+12", undefined, null]) {
      expect(toE164(input)).toBeNull();
    }
  });
});

describe("formatPhone", () => {
  it("formats US numbers and leaves others in E.164", () => {
    expect(formatPhone("+19085551234")).toBe("(908) 555-1234");
    expect(formatPhone("+442079460958")).toBe("+442079460958");
    expect(formatPhone(null)).toBe("");
  });
});

describe("insights", () => {
  it("labels known counts in order and still shows new ones", () => {
    expect(
      countRows({ oatMilkRequests: 5, menuUpdates: 2, customerQuestions: 42, note: "x" }),
    ).toEqual([
      { key: "customerQuestions", label: "Customer questions", value: 42 },
      { key: "menuUpdates", label: "Menu updates", value: 2 },
      { key: "oatMilkRequests", label: "Oat milk requests", value: 5 },
    ]);
    expect(countRows(undefined)).toEqual([]);
    expect(humanizeKey("top_items_count")).toBe("Top items count");
  });

  it("labels weeks", () => {
    expect(weekLabel("2026-11-09")).toBe("Week of Nov 9");
    expect(weekLabel("not a date")).toBe("not a date");
  });

  it("says how long ago, in days", () => {
    const now = new Date(2026, 10, 10, 15, 0);
    expect(relativeDay(new Date(2026, 10, 10, 8, 0), now)).toBe("today");
    expect(relativeDay(new Date(2026, 10, 9, 23, 0), now)).toBe("yesterday");
    expect(relativeDay(new Date(2026, 10, 7), now)).toBe("3 days ago");
    expect(relativeDay(new Date(2026, 9, 2), now)).toBe("Oct 2");
    expect(relativeDay(null, now)).toBe("");
  });
});
