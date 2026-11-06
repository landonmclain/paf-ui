"use client";

// Minimal dark-mode hook: reads theme from localStorage (default "system"),
// resolves system pref, and toggles the `dark` class on <html>. AI Elements'
// Tailwind components use `dark:` variants keyed off the .dark class, so this
// is all that's needed to flip the whole app.

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "paf-ui-theme";

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function useTheme(): {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return "system";
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
  });

  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    typeof window === "undefined" ? "light" : resolveTheme(theme),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);

    // Follow OS theme changes while in "system" mode.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      setResolved(resolveTheme(theme));
      if (theme === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
  }, []);

  return { theme, resolved, setTheme };
}
