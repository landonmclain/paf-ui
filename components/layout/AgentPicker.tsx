"use client";

// Agent (profile) selector — dropdown in the header bar.
//
// The backend namespaces every conversation lane by `{agent}:{conversation_id}`
// and a single SSE server already serves all agents
// (agent is chosen per-request). This picker just changes which agent id the
// UI sends on every call, re-scoping the whole page (chat, sidebar lanes,
// processes, plan) to that agent's lanes. Selection persists to localStorage
// (via LayoutState) so a refresh keeps your chosen agent.
//
// The list is the hardcoded PAF_AGENTS; it could instead come from a backend
// agents endpoint.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PAF_AGENTS, PAF_AGENT } from "@/lib/paf/config";
import { useLayoutState } from "./LayoutState";

// Compact display labels (agent *id* is sent to the backend; label is UI-only).
const AGENT_LABELS: Record<string, string> = {
  demo_assistant: "demo",
  assistant: "assistant",
  secure_assistant: "secure",
};

const labelFor = (a: string) => AGENT_LABELS[a] ?? a;

export function AgentPicker() {
  const { agent, setAgent } = useLayoutState();
  // If the configured default isn't in the known list (custom env), still show
  // it as the active option rather than an empty selector.
  const agents = PAF_AGENTS.includes(PAF_AGENT)
    ? PAF_AGENTS
    : [PAF_AGENT, ...PAF_AGENTS];

  return (
    <Select
      value={agent}
      onValueChange={(v) => {
        // Base UI fires null on clear; we never clear, so ignore it.
        if (v) setAgent(v);
      }}
    >
      <SelectTrigger
        className="h-7 gap-1.5 px-2 text-xs"
        aria-label="Agent"
        title="Select agent (profile) — each has its own conversation lanes"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {agents.map((a) => (
          <SelectItem key={a} value={a}>
            {labelFor(a)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
