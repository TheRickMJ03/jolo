import { render, screen } from "@testing-library/react-native";
import OwnerLayout from "@/app/owner/_layout";

let mockStatus = "not-linked";
const mockUser = { uid: "u1", phoneNumber: "+19085551234" };

jest.mock("@/lib/auth", () => ({ useAuth: () => ({ user: mockUser, signOut: jest.fn() }) }));
jest.mock("@/hooks/useOwnerCafe", () => ({
  useOwnerCafe: () => ({ status: mockStatus, cafe: null }),
}));
jest.mock("expo-router", () => {
  // Only the not-ready states are rendered here; the tabs themselves need a navigator.
  function Tabs() {
    return null;
  }
  Tabs.Screen = function Screen() {
    return null;
  };
  return { Tabs };
});

it("tells a phone user whose number isn't linked what to do", async () => {
  mockStatus = "not-linked";
  await render(<OwnerLayout />);
  expect(screen.getByText("No café linked yet")).toBeTruthy();
  expect(screen.getByText(/couldn't find a café linked to \(908\) 555-1234/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
});

it("tells an email user to sign in with the café's phone", async () => {
  mockStatus = "no-phone";
  await render(<OwnerLayout />);
  expect(screen.getByText("Sign in with your café's phone")).toBeTruthy();
});

it("shows a spinner while looking up the café", async () => {
  mockStatus = "loading";
  await render(<OwnerLayout />);
  expect(screen.getByLabelText("Finding your café")).toBeTruthy();
});
