"use client";

import { PanelLeft, PanelRight } from "lucide-react";
import { useLayoutState } from "./LayoutState";

// Sidebar collapse toggles, rendered in the single existing header bar
// (app/layout.tsx) alongside the ThemeToggle. No duplicate header.
// The left toggle lives on the left side of the header; the right toggle is
// right-aligned (sits with the ThemeToggle) so it's reachable near where the
// panel opens.

const btn =
  "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground";

export function LeftSidebarToggle() {
  const { leftOpen, toggleLeft } = useLayoutState();
  return (
    <button
      type="button"
      onClick={toggleLeft}
      title={leftOpen ? "Collapse conversations" : "Expand conversations"}
      aria-pressed={leftOpen}
      className={btn}
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
}

export function RightSidebarToggle() {
  const { rightOpen, toggleRight } = useLayoutState();
  return (
    <button
      type="button"
      onClick={toggleRight}
      title={rightOpen ? "Collapse processes" : "Expand processes"}
      aria-pressed={rightOpen}
      className={btn}
    >
      <PanelRight className="h-4 w-4" />
    </button>
  );
}

// Kept for any older importers; both toggles in one left group (used before
// the right toggle was right-aligned).
export function SidebarControls() {
  return (
    <div className="flex items-center gap-1">
      <LeftSidebarToggle />
      <RightSidebarToggle />
    </div>
  );
}
