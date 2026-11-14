import { createContext, useContext, useState } from "react";
import { useForYou } from "@/hooks/useForYou";
import { pickVariant } from "@/lib/recommendations";

const ForYouContext = createContext(null);

/**
 * One fetch for For you, Saved, and Account. The variant is chosen once per
 * launch: half of sessions stay on the popular list, so saves and order marks
 * can be compared with the personal cards.
 */
export function UserSession({ user, children }) {
  const [variant] = useState(() => pickVariant());
  const value = useForYou(user, variant);
  return <ForYouContext.Provider value={value}>{children}</ForYouContext.Provider>;
}

export function useForYouState() {
  const value = useContext(ForYouContext);
  if (!value) throw new Error("useForYouState must be used inside UserSession");
  return value;
}
