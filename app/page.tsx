"use client";

import { useEffect, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import PafChat from "@/components/chat/PafChat";
import { ConversationList } from "@/components/chat/ConversationList";
import { ProjectDialog } from "@/components/chat/ProjectDialog";
import { ProcessesPanel } from "@/components/chat/ProcessesPanel";
import { useIsMobile, useLayoutState } from "@/components/layout/LayoutState";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistentLayout,
} from "@/components/ui/resizable";
import {
  PAF_AGENTS,
  createConversation,
  createProject,
  fetchConversations,
  isWatching,
  listConversations,
  reportPresence,
  listProjects,
  renameConversation,
  subscribeProcesses,
  updateConversation,
  updateProject,
} from "@/lib/paf";
import type {
  Conversation,
  ConversationPatch,
  ProcessFrame,
  PlanItem,
  Project,
} from "@/lib/paf";

/** Drive a collapsible sidebar Panel from its header toggle: collapse/expand
 *  only when `open` actually changes, so StrictMode's double effect run and a
 *  restored layout (synced back into `open` via the group's onLayout) don't
 *  bounce the panel. Panels mount expanded (defaultSize), hence `true`. While
 *  `mounted` is false (mobile: no panels) the last state is unknown (`null`):
 *  a re-mounted panel takes the restored desktop layout, and `open` follows it
 *  rather than the other way round. */
function useSidebarPanel(open: boolean, mounted: boolean) {
  const panelRef = usePanelRef();
  const lastOpen = useRef<boolean | null>(true);
  useEffect(() => {
    if (!mounted) {
      lastOpen.current = null;
      return;
    }
    if (lastOpen.current === null) {
      lastOpen.current = open;
      return;
    }
    if (lastOpen.current === open) return;
    lastOpen.current = open;
    if (open) panelRef.current?.expand();
    else panelRef.current?.collapse();
  }, [open, mounted, panelRef]);
  return panelRef;
}

export default function Home() {
  // Sidebar open/closed state is shared with the header (ThemeToggle row) via
  // LayoutState, so there is exactly ONE header bar. `agent` is also shared —
  // set by the header's AgentPicker — and re-scopes the whole page when changed.
  // The horizontal (left | center | right) layout is a resizable PanelGroup;
  // left/right collapse via LayoutState (header toggles or drag), and sizes are
  // persisted per-group by usePersistentLayout. v4 sizes: bare numbers are PIXELS,
  // so every size below carries an explicit unit.
  const { leftOpen, rightOpen, agent, setAgent, setLeftOpen, setRightOpen } =
    useLayoutState();
  // On mobile the sidebars take no width: they open as overlay drawers and the
  // Group holds only the chat (its own layout key, so the desktop one is kept).
  const isMobile = useIsMobile();
  const leftPanel = useSidebarPanel(leftOpen, !isMobile);
  const rightPanel = useSidebarPanel(rightOpen, !isMobile);
  // Persists toggle collapses too (not just drags), so a closed sidebar stays
  // closed across reloads; a drag (or restore) that collapses/expands a
  // sidebar flips its header toggle to match. A layout without a sidebar
  // (mobile, or read before re-mounted panels register) says nothing about it.
  const layout = usePersistentLayout(
    isMobile ? "paf-ui-main-mobile" : "paf-ui-main",
    isMobile
      ? undefined
      : (l) => {
          if ("left" in l) setLeftOpen(l.left > 0);
          if ("right" in l) setRightOpen(l.right > 0);
        },
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [agentProcesses, setAgentProcesses] = useState<ProcessFrame[]>([]);
  const [conversationProcesses, setConversationProcesses] = useState<
    ProcessFrame[]
  >([]);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  // Projects are global (the user's), not per-agent — loaded once.
  const [projects, setProjects] = useState<Project[]>([]);
  // Shared project editor; `assignTo` optionally assigns a newly created project.
  const [projectDialog, setProjectDialog] = useState<{
    open: boolean;
    assignTo?: string;
    project?: Project;
  }>({
    open: false,
  });

  useEffect(() => {
    let alive = true;
    void listProjects().then((list) => {
      if (alive) setProjects(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Switching conversations re-scopes the plan sidebar: clear the previous
  // lane's plan the moment we leave it, otherwise the panel shows the prior
  // conversation's plan under the new lane's header until the async
  // /plan fetch resolves (the "cross-threaded plan" effect).
  useEffect(() => {
    setPlan([]);
  }, [activeConversationId]);

  // Switching agents re-scopes everything: the sidebar, the active lane, and the
  // side panels all belong to one agent at a time. Clear the active lane on a
  // switch so the new agent's most-recent conversation auto-selects (the list
  // effect below) instead of pointing at the other agent's lane id.
  const [prevAgent, setPrevAgent] = useState(agent);
  if (prevAgent !== agent) {
    setPrevAgent(agent);
    setActiveConversationId(null);
    setAgentProcesses([]);
    setConversationProcesses([]);
    setPlan([]);
  }

  // Deep links (push notifications): `/?agent=<agent>&c=<conversation_id>`.
  // Opened from a cold start the params are in the URL (read once on mount);
  // opened while the app is running, the service worker posts `paf-open`
  // instead, so we switch in place with no reload. An agent switch clears the
  // active lane (above), so the target conversation waits in `pendingOpen`
  // until the agent has actually changed, then is applied. Handlers here are
  // stateless (they only call stable setters / read refs) because the mount
  // effect's closure outlives the render that created it.
  const [pendingOpen, setPendingOpen] = useState<{
    agent: string | null;
    cid: string;
  } | null>(null);
  // Latest values for the mount-only effect below (`setAgent` is recreated
  // every render by LayoutState, so it can't be a dependency).
  const isMobileRef = useRef(isMobile);
  const setAgentRef = useRef(setAgent);
  useEffect(() => {
    isMobileRef.current = isMobile;
    setAgentRef.current = setAgent;
  });
  // Declared before the URL-sync effect below: on mount this must read the
  // incoming params before the sync effect rewrites the URL.
  useEffect(() => {
    const open = (target: string | null, cid: string | null) => {
      if (!cid) return;
      const known = target && PAF_AGENTS.includes(target) ? target : null;
      if (known) setAgentRef.current(known); // no-op when it is already the agent
      setPendingOpen({ agent: known, cid });
      if (isMobileRef.current) setLeftOpen(false);
    };
    const p = new URLSearchParams(window.location.search);
    // Reading the URL is a one-shot sync from an external system (hydration
    // forbids doing it in a state initializer).
    open(p.get("agent"), p.get("c"));
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; agent?: string; cid?: string };
      if (d?.type === "paf-open") open(d.agent ?? null, d.cid ?? null);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [setLeftOpen]); // setLeftOpen is a useState setter (stable)
  useEffect(() => {
    if (pendingOpen && (pendingOpen.agent === null || pendingOpen.agent === agent)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveConversationId(pendingOpen.cid);
      setPendingOpen(null);
    }
  }, [pendingOpen, agent]);
  // Keep the URL on the open conversation: it is the deep-link target, survives
  // a refresh, and is how the service worker knows which conversation a window
  // is showing (it suppresses a push for the one you're looking at).
  useEffect(() => {
    if (!activeConversationId) return;
    const q = new URLSearchParams({ agent, c: activeConversationId });
    window.history.replaceState(null, "", `/?${q}`);
  }, [agent, activeConversationId]);

  // Load the selected agent's conversation list, and auto-select its most-recent
  // lane so history loads without an explicit click. Re-runs when the agent
  // changes (new lanes) — `updated_at` is last-activity; backend sends
  // newest-first, and we sort here too so auto-select is unambiguous.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listConversations(agent);
      if (!alive) return;
      setConversations(list);
      // Hidden lanes aren't in the sidebar, so never auto-select one.
      const sorted = list
        .filter((c) => !c.hidden)
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
      const newest = sorted[0]?.conversation_id;
      // Only auto-select if nothing is active yet (e.g. after an agent switch or
      // first load). A user click elsewhere wins until the next agent change.
      setActiveConversationId((cur) => cur ?? newest);
    })();
    return () => {
      alive = false;
    };
  }, [agent]);

  // Presence: tell paf which conversation this device is looking at, so it doesn't
  // push a notification to a phone/desktop that is already watching the answer.
  // A heartbeat every 10s while watching, an immediate report when visibility or
  // focus changes, and "stopped" on leaving the conversation. Reports expire
  // server-side (~30s), so a killed or backgrounded app drops out on its own.
  useEffect(() => {
    if (!activeConversationId) return;
    const cid = activeConversationId;
    const beat = () => {
      const watching = isWatching();
      void reportPresence(agent, cid, watching, { keepalive: !watching });
    };
    beat();
    const timer = window.setInterval(() => {
      if (isWatching()) beat();
    }, 10_000);
    document.addEventListener("visibilitychange", beat);
    window.addEventListener("focus", beat);
    window.addEventListener("blur", beat);
    window.addEventListener("pagehide", beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
      window.removeEventListener("focus", beat);
      window.removeEventListener("blur", beat);
      window.removeEventListener("pagehide", beat);
      void reportPresence(agent, cid, false, { keepalive: true });
    };
  }, [agent, activeConversationId]);

  // Keep the list live across devices: a conversation started (or a turn running)
  // on another device appears here without a reload. The server already reports
  // every active lane plus a `running` flag, so this just re-asks: every few
  // seconds while the page is visible, and immediately on return/focus. Only the
  // latest request may apply (a slow, older response can't overwrite a newer
  // one), and a failed request leaves the list as is. The active selection is
  // never touched here.
  useEffect(() => {
    let alive = true;
    let latest = 0;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      const mine = ++latest;
      const next = await fetchConversations(agent);
      if (!alive || mine !== latest || next === null) return;
      setConversations((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    const onWake = () => void refresh();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [agent]);

  // Agent-lane process feed: the shared per-agent lane (memory consolidation +
  // review), keyed by agent ONLY — it does NOT change on conversation switch,
  // only when the agent changes. Opens once per agent, independent of any turn.
  useEffect(() => {
    let disconnected = false;
    const disconnect = subscribeProcesses({
      agent,
      lane: "agent",
      onProcesses: (next) => {
        if (!disconnected) setAgentProcesses(next);
      },
    });
    return () => {
      disconnected = true;
      disconnect();
      setAgentProcesses([]);
    };
  }, [agent]);

  // Conversation-lane process feed: one conversation's lane (thread
  // summarizer), keyed by active conversation + agent. Re-subscribes on
  // conversation switch; a fresh row list is restored by the backend's history
  // replay on connect. Background/maintenance frames never ride the turn's
  // /api/chat stream.
  useEffect(() => {
    if (!activeConversationId) return;
    let disconnected = false;
    const disconnect = subscribeProcesses({
      conversationId: activeConversationId,
      agent,
      lane: "conversation",
      onProcesses: (next) => {
        if (!disconnected) setConversationProcesses(next);
      },
    });
    return () => {
      disconnected = true;
      disconnect();
      // Clear the panel when leaving a lane so we never show another
      // conversation's processes under the new lane's header.
      setConversationProcesses([]);
    };
  }, [activeConversationId, agent]);

  const handleCreate = async (project: string | null) => {
    const cid = await createConversation(agent, project);
    if (!cid) return;
    setConversations((prev) => [
      {
        conversation_id: cid,
        agent,
        title: "New conversation",
        updated_at: Date.now() / 1000, // epoch seconds, like the backend
        project,
        hidden: false,
      },
      ...prev,
    ]);
    setActiveConversationId(cid);
  };

  // Apply a title/project/hidden change and reflect what the backend saved.
  const patchConversation = async (id: string, patch: ConversationPatch) => {
    const saved = await updateConversation(id, patch, agent);
    if (!saved) return;
    setConversations((prev) =>
      prev.map((c) =>
        c.conversation_id === id
          ? { ...c, project: saved.project, hidden: saved.hidden }
          : c,
      ),
    );
  };

  const handleSaveProject = async (
    name: string,
    description: string,
    root: string,
  ) => {
    const res = projectDialog.project
      ? await updateProject(projectDialog.project.slug, {
          name,
          description,
          root,
        })
      : await createProject(name, description, root);
    if (!res.ok) return res.error;
    setProjects((prev) =>
      [...prev.filter((p) => p.slug !== res.project.slug), res.project].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    );
    if (projectDialog.assignTo) {
      await patchConversation(projectDialog.assignTo, {
        project: res.project.slug,
      });
    }
    return null;
  };

  const handleRename = async (id: string, title: string) => {
    const next = await renameConversation(id, title, agent);
    // `next` is null on a clear (empty title) — the backend restores the
    // derived title, which we reflect by nulling it locally so the sidebar
    // re-derives from the conversation. `next` is also null on failure.
    setConversations((prev) =>
      prev.map((c) =>
        c.conversation_id === id
          ? { ...c, title: next !== null ? next : null }
          : c,
      ),
    );
    return next;
  };

  const conversationList = (
    <ConversationList
      open={leftOpen}
      conversations={conversations}
      activeId={activeConversationId}
      onSelect={(id) => {
        setActiveConversationId(id);
        if (isMobile) setLeftOpen(false);
      }}
      projects={projects}
      onCreate={(project) => void handleCreate(project)}
      onRename={handleRename}
      onAssign={(id, project) => void patchConversation(id, { project })}
      onHide={(id, hidden) => void patchConversation(id, { hidden })}
      onNewProject={(assignTo) => setProjectDialog({ open: true, assignTo })}
      onEditProject={(project) => setProjectDialog({ open: true, project })}
      processes={conversationProcesses}
    />
  );
  const processesPanel = (
    <ProcessesPanel
      open={rightOpen}
      agentProcesses={agentProcesses}
      plan={plan}
    />
  );
  const closeDrawers = () => {
    setLeftOpen(false);
    setRightOpen(false);
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      <ResizablePanelGroup
        orientation="horizontal"
        id="paf-ui-main"
        {...layout}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {/* Keyed so the chat panel keeps its state when the sidebars drop out
            on mobile. */}
        {!isMobile && (
          <ResizablePanel
            key="left"
            id="left"
            defaultSize="256px"
            minSize="200px"
            maxSize="40%"
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            panelRef={leftPanel}
          >
            {conversationList}
          </ResizablePanel>
        )}
        {!isMobile && <ResizableHandle key="left-handle" withHandle />}
        <ResizablePanel key="center" id="center" minSize="30%">
          <div className="h-full min-w-0">
            <PafChat
              conversationId={activeConversationId}
              agent={agent}
              onPlan={setPlan}
            />
          </div>
        </ResizablePanel>
        {!isMobile && <ResizableHandle key="right-handle" withHandle />}
        {!isMobile && (
          <ResizablePanel
            key="right"
            id="right"
            defaultSize="288px"
            minSize="220px"
            maxSize="45%"
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            panelRef={rightPanel}
          >
            {processesPanel}
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
      {isMobile && (leftOpen || rightOpen) && (
        <div
          className="absolute inset-0 z-30 bg-black/40"
          onClick={closeDrawers}
          aria-hidden
        />
      )}
      {isMobile && leftOpen && (
        <div className="absolute inset-y-0 left-0 z-40 w-[85%] max-w-xs bg-background shadow-lg">
          {conversationList}
        </div>
      )}
      {isMobile && rightOpen && (
        <div className="absolute inset-y-0 right-0 z-40 w-[85%] max-w-xs bg-background shadow-lg">
          {processesPanel}
        </div>
      )}
      {/* Outside the Group: only Panels/Separators may be its children. */}
      <ProjectDialog
        key={projectDialog.project ? `edit:${projectDialog.project.slug}` : "new"}
        project={projectDialog.project}
        open={projectDialog.open}
        onOpenChange={(open) => {
          if (!open) setProjectDialog({ open: false });
        }}
        onSave={handleSaveProject}
      />
    </div>
  );
}
