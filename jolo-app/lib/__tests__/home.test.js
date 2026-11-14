import { destinationForCafe } from "@/lib/home";

describe("destinationForCafe", () => {
  it("sends a linked phone to the owner tabs", () => {
    expect(destinationForCafe("ready")).toBe("owner");
  });

  it("sends everyone else who is signed in to For you", () => {
    expect(destinationForCafe("not-linked")).toBe("user");
    expect(destinationForCafe("no-phone")).toBe("user");
  });

  it("waits while the lookup is still running or has failed", () => {
    expect(destinationForCafe("loading")).toBeNull();
    expect(destinationForCafe("error")).toBeNull();
    expect(destinationForCafe("signed-out")).toBeNull();
  });
});
