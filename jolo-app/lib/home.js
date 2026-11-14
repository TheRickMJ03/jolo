// Where a signed-in person lands. A café linked to this phone is the owner
// app. Everyone else is a customer. "loading" and "error" stay unresolved
// until the lookup finishes, so an owner is never flashed the customer tabs.

/** @returns {"owner" | "user" | null} */
export function destinationForCafe(status) {
  if (status === "ready") return "owner";
  if (status === "not-linked" || status === "no-phone") return "user";
  return null;
}
