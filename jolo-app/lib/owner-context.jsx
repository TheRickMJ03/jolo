import { createContext, useContext } from "react";

// The signed-in owner's café, found once in app/owner/_layout.jsx and shared
// with every tab.
const OwnerCafeContext = createContext(null);

export const OwnerCafeProvider = OwnerCafeContext.Provider;

export function useCafe() {
  const cafe = useContext(OwnerCafeContext);
  if (!cafe) throw new Error("useCafe must be used inside the owner layout");
  return cafe;
}
