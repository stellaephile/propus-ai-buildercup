/**
 * Demo vs live is fixed at build time (NEXT_PUBLIC_MODE). Read it here once so
 * the empty-state copy, the top bar and the query runner cannot disagree.
 */
export const APP_MODE: "demo" | "live" =
  process.env.NEXT_PUBLIC_MODE === "live" && process.env.NEXT_PUBLIC_API_URL ? "live" : "demo";
