"use client";

// ThemeToggle — cycles light -> dark -> system. Uses MoonIcon/SunIcon; the
// "system" state shows a monitor-style icon.

import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "./use-theme";

const ORDER: Theme[] = ["light", "dark", "system"];

const ICONS: Record<Theme, React.ReactNode> = {
  light: <Sun className="size-4" />,
  dark: <Moon className="size-4" />,
  system: <Monitor className="size-4" />,
};

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const cycle = () => {
    const i = ORDER.indexOf(theme);
    setTheme(ORDER[(i + 1) % ORDER.length]);
  };

  return (
    <Button
      aria-label={`Theme: ${theme}`}
      size="icon-sm"
      type="button"
      variant="ghost"
      onClick={cycle}
      title={`Theme: ${theme} (click to cycle)`}
    >
      {ICONS[theme]}
    </Button>
  );
}
