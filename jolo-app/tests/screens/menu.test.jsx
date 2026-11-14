import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import MenuScreen from "@/app/owner/index";

const mockCafe = {
  id: "cafe1",
  name: "Barbara's",
  currentMenuVersion: 3,
  menuUpdatedAt: new Date(),
};
const mockItems = [
  {
    id: "cortado",
    name: "Cortado",
    category: "Coffee",
    priceCents: 450,
    description: null,
    available: true,
  },
  {
    id: "muffin",
    name: "Muffin",
    category: "Bakery",
    priceCents: 325,
    description: null,
    available: true,
  },
];

jest.mock("@/lib/owner-context", () => ({ useCafe: () => mockCafe }));
jest.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { uid: "owner-uid", phoneNumber: "+19085551234" } }),
}));
jest.mock("@/hooks/useMenu", () => ({
  useCurrentMenu: () => ({
    loading: false,
    error: null,
    version: { version: 3, source: "imessage", items: mockItems },
  }),
}));
jest.mock("@/lib/menu-store", () => {
  class MenuConflictError extends Error {}
  return { MenuConflictError, saveMenuVersion: jest.fn() };
});
const { saveMenuVersion, MenuConflictError } = jest.requireMock("@/lib/menu-store");

beforeEach(() => {
  saveMenuVersion.mockReset().mockImplementation(async (_cafeId, next) => next.version);
});

it("shows the live menu grouped by category", async () => {
  await render(<MenuScreen />);
  expect(screen.getByText("Barbara's")).toBeTruthy();
  expect(screen.getByText(/Version 3 · updated today by text/)).toBeTruthy();
  expect(screen.getByText("Coffee")).toBeTruthy();
  expect(screen.getByLabelText("Cortado, $4.50")).toBeTruthy();
});

it("marks an item sold out and saves it as version 4", async () => {
  await render(<MenuScreen />);
  await fireEvent(screen.getByLabelText("Muffin available"), "valueChange", false);
  expect(screen.getByText("• Muffin: availability available → sold out")).toBeTruthy();

  await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saveMenuVersion).toHaveBeenCalledTimes(1));

  const [cafeId, next] = saveMenuVersion.mock.calls[0];
  expect(cafeId).toBe("cafe1");
  expect(next).toMatchObject({
    version: 4,
    basedOn: 3,
    source: "app",
    createdBy: { uid: "owner-uid", phone: "+19085551234" },
  });
  expect(next.items.find((item) => item.id === "muffin").available).toBe(false);
  expect(await screen.findByText("Saved as version 4. Customers see it now.")).toBeTruthy();
});

it("edits a price in the item editor", async () => {
  await render(<MenuScreen />);
  await fireEvent.press(screen.getByLabelText("Cortado, $4.50"));
  const price = await screen.findByLabelText("Price in dollars");
  await fireEvent.changeText(price, "4.75");
  await fireEvent.press(screen.getByRole("button", { name: "Save item" }));
  expect(await screen.findByText("• Cortado $4.50 → $4.75")).toBeTruthy();
});

it("rejects a bad price in the editor", async () => {
  await render(<MenuScreen />);
  await fireEvent.press(screen.getByLabelText("Cortado, $4.50"));
  await fireEvent.changeText(await screen.findByLabelText("Price in dollars"), "four dollars");
  await fireEvent.press(screen.getByRole("button", { name: "Save item" }));
  expect(screen.getByText("Enter a price like 4.75, or leave it empty.")).toBeTruthy();
});

it("adds a new item", async () => {
  await render(<MenuScreen />);
  await fireEvent.press(screen.getByRole("button", { name: "Add an item" }));
  await fireEvent.changeText(await screen.findByLabelText("Name"), "Oat Latte");
  await fireEvent.changeText(screen.getByLabelText("Price in dollars"), "5");
  await fireEvent.press(screen.getByRole("button", { name: "Add to menu" }));
  expect(await screen.findByText("+ Oat Latte")).toBeTruthy();
});

it("keeps the owner's edits when the menu changed by text meanwhile", async () => {
  saveMenuVersion.mockRejectedValue(new MenuConflictError());
  await render(<MenuScreen />);
  await fireEvent(screen.getByLabelText("Muffin available"), "valueChange", false);
  await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText(/Your edits are still here/)).toBeTruthy();
  expect(
    within(screen.getByRole("button", { name: "Save changes" })).getByText("Save changes"),
  ).toBeTruthy();
});
