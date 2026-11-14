// Firebase auth error codes are not user-facing; map the ones our screens can hit.
const MESSAGES = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/email-already-in-use": "An account already exists for that email.",
  "auth/weak-password": "Passwords need to be at least 8 characters.",
  "auth/missing-password": "Enter your password.",
  "auth/too-many-requests": "Too many attempts. Try again in a few minutes.",
  "auth/network-request-failed": "No connection. Check your internet and try again.",
  // A sign-in method is switched off in the Firebase console.
  "auth/operation-not-allowed": "That sign-in method isn't enabled for this app yet.",
  "auth/configuration-not-found": "That sign-in method isn't enabled for this app yet.",
  // Phone sign-in
  "auth/invalid-phone-number": "That phone number doesn't look right.",
  "auth/missing-phone-number": "Enter your phone number.",
  "auth/quota-exceeded": "Too many codes were sent. Try again later.",
  "auth/invalid-verification-code": "That code isn't right. Check the text and try again.",
  "auth/missing-verification-code": "Enter the 6-digit code from the text.",
  "auth/code-expired": "That code has expired. Send a new one.",
  "auth/session-expired": "That code has expired. Send a new one.",
  "auth/missing-verification-id": "Send yourself a code first.",
  "auth/captcha-check-failed": "Verification didn't finish. Try sending the code again.",
};

export function authErrorMessage(error) {
  // The friendly text hides which Firebase error it was; keep the real code and
  // message in the Metro log so setup problems can be told apart.
  if (__DEV__ && process.env.NODE_ENV !== "test") {
    console.warn(`[auth] ${error?.code ?? "no code"}: ${error?.message ?? error}`);
  }
  return MESSAGES[error?.code] ?? "Something went wrong. Please try again.";
}
