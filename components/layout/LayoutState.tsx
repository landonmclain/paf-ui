"use client";

// Shared state for the app shell layout: whether each sidebar is open/collapsed.
// The provider lives in app/layout.tsx (wrapping the header + page), so the
// header's collapse toggles (SidebarControls) and the page render the same state
// with exactly ONE header bar.

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { PAF_AGENT, PAF_AGENTS } from "@/lib/paf/config";

type LayoutStateValue = {
  leftOpen: boolean;
  rightOpen: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
  /** Direct setters, so drag-to-collapse can sync back to the header toggles. */
  setLeftOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
  /** Currently-selected agent (profile) driving the whole UI. */
  agent: string;
  setAgent: (agent: string) => void;
};

const LayoutStateContext = createContext<LayoutStateValue | null>(null);

/** Below Tailwind's `md` (>=768px) breakpoint. */
const MOBILE_QUERY = "(max-width: 767px)";

/** Prefer collapsed sidebars on small screens (mobile); open by default on
 *  larger screens. */
function prefersCollapsedSidebars(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

function subscribeMobile(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Live mobile-width flag. False on the server and during hydration, so the
 *  first client render matches the server HTML. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

const AGENT_STORAGE_KEY = "paf-ui-agent";

/** Restore the last-selected agent (or fall back to the configured default),
 *  validating against the known agent list so a stale/corrupt value can't
 *  point the UI at an unknown agent lane. */
function initialAgent(): string {
  if (typeof window === "undefined") return PAF_AGENT;
  try {
    const saved = localStorage.getItem(AGENT_STORAGE_KEY);
    if (saved && PAF_AGENTS.includes(saved)) return saved;
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return PAF_AGENT;
}

export function LayoutStateProvider({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpen] = useState(
    () => !prefersCollapsedSidebars(), // collapsed on mobile by default
  );
  const [rightOpen, setRightOpen] = useState(
    () => !prefersCollapsedSidebars(), // collapsed on mobile by default
  );
  const [agent, setAgentState] = useState<string>(() => initialAgent());
  const setAgent = (next: string) => {
    setAgentState(next);
    try {
      localStorage.setItem(AGENT_STORAGE_KEY, next);
    } catch {
      /* ignore persistence failures */
    }
  };
  return (
    <LayoutStateContext.Provider
      value={{
        leftOpen,
        rightOpen,
        toggleLeft: () => setLeftOpen((v) => !v),
        toggleRight: () => setRightOpen((v) => !v),
        setLeftOpen,
        setRightOpen,
        agent,
        setAgent,
      }}
    >
      {children}
    </LayoutStateContext.Provider>
  );
}

export function useLayoutState(): LayoutStateValue {
  const ctx = useContext(LayoutStateContext);
  if (!ctx) {
    throw new Error("useLayoutState must be used within LayoutStateProvider");
  }
  return ctx;
}
