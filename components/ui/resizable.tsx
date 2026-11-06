"use client";

// Modified from shadcn/ui (MIT, Copyright (c) 2023 shadcn); see NOTICE.

// Wraps react-resizable-panels v4 (Group/Panel/Separator) under the familiar
// shadcn-style names. v4 diverges from the old v3 template API:
//   - PanelGroup -> Group, PanelResizeHandle -> Separator, direction -> orientation
//   - sizes are a defaultLayout map ({panelId: percent}) on the Group, not
//     per-panel defaultSize; persistence is usePersistentLayout() below
//   - v4 renders NO data-orientation attribute: a Group renders data-group and a
//     Separator reports aria-orientation (the SEPARATOR's own orientation, which
//     is the inverse of the group's: horizontal group -> "vertical"). The handle
//     styles below therefore hook on [aria-orientation=horizontal] to detect a
//     vertical group's (horizontal bar) separator.

import { useCallback, useEffect, useRef } from "react";
import { GripVertical } from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  useGroupRef,
  type Layout,
} from "react-resizable-panels";

import { cn } from "@/lib/utils";

type GroupProps = React.ComponentProps<typeof Group>;
type PanelProps = React.ComponentProps<typeof Panel>;
type SeparatorProps = React.ComponentProps<typeof Separator>;

function ResizablePanelGroup({
  orientation = "horizontal",
  className,
  ...props
}: GroupProps) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={orientation}
      className={cn(
        "flex h-full w-full",
        orientation === "vertical" && "flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({ className, ...props }: PanelProps) {
  return (
    <Panel
      data-slot="resizable-panel"
      className={cn("min-h-0 min-w-0", className)}
      {...props}
    />
  );
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: SeparatorProps & { withHandle?: boolean }) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-ring/50 [&[aria-orientation=horizontal]]:h-px [&[aria-orientation=horizontal]]:w-full [&[aria-orientation=horizontal]]:after:left-0 [&[aria-orientation=horizontal]]:after:h-1 [&[aria-orientation=horizontal]]:after:w-full [&[aria-orientation=horizontal]]:after:-translate-y-1/2 [&[aria-orientation=horizontal]]:after:translate-x-0 [&[aria-orientation=horizontal]]>div:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
          <GripVertical className="size-2.5" />
        </div>
      )}
    </Separator>
  );
}

// Layout persistence. Not useDefaultLayout: it reads localStorage during render,
// which throws on the server (GET / -> 500), and even guarded, a restored
// layout differs from the server HTML and React doesn't patch mismatched
// styles on hydration (the saved sizes are silently lost). Instead the saved
// layout is applied imperatively after mount.
//
// `onLayout` sees every settled layout: the restored one, then each change
// (drags, collapse/expand). Panel onResize does NOT fire for setLayout, so
// this is the hook for syncing state off the layout.
//
// Re-runs when `id` changes. Panels mounted in the same commit (e.g. sidebars
// coming back when leaving mobile) aren't registered with the Group yet, so
// the restore waits for the Group's first layout report that includes them.
function usePersistentLayout(id: string, onLayout?: (layout: Layout) => void) {
  const key = `react-resizable-panels:${id}`;
  const groupRef = useGroupRef();
  const restored = useRef(false);
  const onLayoutRef = useRef(onLayout);
  useEffect(() => {
    onLayoutRef.current = onLayout;
  });
  const tryRestore = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    let saved: Layout | null = null;
    try {
      const raw = localStorage.getItem(key);
      saved = raw ? (JSON.parse(raw) as Layout) : null;
    } catch {
      /* corrupt layout or storage unavailable — keep defaults */
    }
    const current = group.getLayout();
    if (saved && !Object.keys(saved).every((p) => p in current)) return;
    // Set before setLayout: it reports back through onLayoutChanged.
    restored.current = true;
    if (saved) {
      try {
        group.setLayout(saved);
      } catch {
        /* saved layout no longer fits these panels — keep defaults */
      }
    }
    onLayoutRef.current?.(group.getLayout());
  }, [key, groupRef]);
  useEffect(() => {
    restored.current = false;
    tryRestore();
  }, [tryRestore]);
  const onLayoutChanged = (layout: Layout) => {
    // Until restored, layouts are mount-time defaults: don't save or sync
    // them; retry the restore now that more panels may be registered.
    if (!restored.current) {
      tryRestore();
      return;
    }
    onLayoutRef.current?.(layout);
    try {
      localStorage.setItem(key, JSON.stringify(layout));
    } catch {
      /* ignore persistence failures */
    }
  };
  return { groupRef, onLayoutChanged };
}

/** Two stacked panes with a drag handle between them; the split is persisted
 *  under `id`. Fills its parent's height, so the parent must be a flex column
 *  (or otherwise give it a height). */
function VerticalSplit({
  id,
  top,
  bottom,
  topMinSize = "80px",
  bottomMinSize = "80px",
}: {
  id: string;
  top: React.ReactNode;
  bottom: React.ReactNode;
  topMinSize?: string;
  bottomMinSize?: string;
}) {
  const layout = usePersistentLayout(id);
  return (
    <ResizablePanelGroup
      id={id}
      orientation="vertical"
      {...layout}
      className="min-h-0 flex-1"
    >
      <ResizablePanel id="top" minSize={topMinSize} className="flex flex-col">
        {top}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        id="bottom"
        minSize={bottomMinSize}
        className="flex flex-col"
      >
        {bottom}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  VerticalSplit,
  usePersistentLayout,
};
export type { Layout };
