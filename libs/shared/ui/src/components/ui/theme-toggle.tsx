"use client";

import { Button } from "./button";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const THEMES = ["light", "dark", "system"] as const;

type Theme = (typeof THEMES)[number];

const ICONS: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

function ThemeToggle({ labels }: { labels: Record<Theme, string> }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <Button aria-hidden size="icon-sm" variant="ghost" disabled />;
  }

  const current = (THEMES.find((item) => item === theme) ?? "system") as Theme;
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length] as Theme;
  const Icon = ICONS[current];

  return (
    <Button
      aria-label={labels[next]}
      onClick={() => setTheme(next)}
      size="icon-sm"
      title={labels[current]}
      variant="ghost"
    >
      <Icon />
    </Button>
  );
}

export { ThemeToggle };
