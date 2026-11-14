// Screen tests live outside app/, which Expo Router would treat as routes.
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import PhoneSignInScreen from "@/app/(login)/phone";

const mockAuth = { sendPhoneCode: jest.fn(), confirmPhoneCode: jest.fn() };
jest.mock("@/lib/auth", () => ({ useAuth: () => mockAuth }));
jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn() } }));

beforeEach(() => {
  mockAuth.sendPhoneCode.mockReset().mockResolvedValue(undefined);
  mockAuth.confirmPhoneCode.mockReset().mockResolvedValue(undefined);
});

it("texts a code to the E.164 number, then signs in with the code", async () => {
  await render(<PhoneSignInScreen />);
  await fireEvent.changeText(screen.getByLabelText("Phone number"), "(908) 555-1234");
  await fireEvent.press(screen.getByRole("button", { name: "Text me a code" }));

  await waitFor(() => expect(mockAuth.sendPhoneCode).toHaveBeenCalledWith("+19085551234"));
  expect(await screen.findByText("We texted a 6-digit code to (908) 555-1234.")).toBeTruthy();

  await fireEvent.changeText(screen.getByLabelText("6-digit code"), "12a3456");
  await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(mockAuth.confirmPhoneCode).toHaveBeenCalledWith("123456"));
});

it("explains an unreadable number without calling Firebase", async () => {
  await render(<PhoneSignInScreen />);
  await fireEvent.changeText(screen.getByLabelText("Phone number"), "555-1234");
  await fireEvent.press(screen.getByRole("button", { name: "Text me a code" }));
  expect(screen.getByText(/Enter a 10-digit US number/)).toBeTruthy();
  expect(mockAuth.sendPhoneCode).not.toHaveBeenCalled();
});

it("turns Firebase error codes into plain words", async () => {
  mockAuth.confirmPhoneCode.mockRejectedValue({ code: "auth/invalid-verification-code" });
  await render(<PhoneSignInScreen />);
  await fireEvent.changeText(screen.getByLabelText("Phone number"), "9085551234");
  await fireEvent.press(screen.getByRole("button", { name: "Text me a code" }));
  await fireEvent.changeText(await screen.findByLabelText("6-digit code"), "000000");
  await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
  expect(
    await screen.findByText("That code isn't right. Check the text and try again."),
  ).toBeTruthy();
});
