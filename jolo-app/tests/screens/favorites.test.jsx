import { render, screen } from "@testing-library/react-native";
import FavoritesView from "@/app/user/favorites";

jest.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { uid: "u1" } }),
}));
jest.mock("@/hooks/useUserActivity", () => ({
  useUserActivity: () => ({ loading: false, error: null, events: [] }),
}));
jest.mock("@/hooks/useCafes", () => ({
  useCafes: () => ({ cafes: [] }),
}));
jest.mock("@/hooks/useUserLocation", () => ({
  useUserLocation: () => ({ coords: null }),
}));

describe("Trending now", () => {
  it("shows the sample drink trends", async () => {
    await render(<FavoritesView />);
    expect(screen.getByText("Trending now")).toBeTruthy();
    expect(screen.getByText("Brown sugar oat latte")).toBeTruthy();
    expect(screen.getByText("Lavender oat latte")).toBeTruthy();
    expect(screen.getByText("Lavender latte")).toBeTruthy();
    expect(screen.getByText("Oat cortado")).toBeTruthy();
    expect(screen.getByText("Iced matcha")).toBeTruthy();
    expect(screen.getByText("Cold brew")).toBeTruthy();
    expect(screen.getAllByText("Rising")).toHaveLength(3);
    expect(screen.getAllByText("Steady")).toHaveLength(3);
    expect(screen.queryByText("Marcus T.")).toBeNull();
  });
});
