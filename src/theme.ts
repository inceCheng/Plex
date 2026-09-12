export type Theme = "light" | "dark";

export const DEFAULT_THEME: Theme = "light";

export function resolveTheme(stored: string | null): Theme {
  return stored === "dark" ? "dark" : DEFAULT_THEME;
}
