import { useState, useEffect } from "react";

export type Theme = "light" | "dark" | "sepia";

const STORAGE_KEY = "lapis-theme";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return { theme, setTheme };
}
