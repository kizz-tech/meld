"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import ChatView from "@/components/chat/ChatView";
import Sidebar from "@/components/sidebar/Sidebar";
import NotePreview from "@/components/vault/NotePreview";
import StatusBar from "@/components/ui/StatusBar";
import {
  useAppStore,
  type Conversation,
  type Message,
  type ThinkingEntry,
  type TimelineStep,
} from "@/lib/store";
import type { VaultEntry } from "@/lib/tauri";

type PresskitScene = "hero" | "chat" | "note" | "workflow" | "onboarding";
type HeroVariant = "landing" | "platform" | "cinematic";

const SCENE_LABELS: Record<Exclude<PresskitScene, "onboarding">, string> = {
  hero: "Local-first AI knowledge workspace",
  chat: "Conversation with citations and run reasoning",
  note: "Note opened from chat citation",
  workflow: "Knowledge file opened, chat remains active",
};

const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: "conv-weekly",
    title: "Weekly Planning",
    createdAt: "2026-02-16T09:10:00.000Z",
    updatedAt: "2026-02-17T08:55:00.000Z",
    messageCount: 14,
    archived: false,
    pinned: true,
    sortOrder: 0,
  },
  {
    id: "conv-roadmap",
    title: "Roadmap Synthesis",
    createdAt: "2026-02-15T11:20:00.000Z",
    updatedAt: "2026-02-16T19:40:00.000Z",
    messageCount: 8,
    archived: false,
    pinned: false,
    sortOrder: 1,
  },
  {
    id: "conv-research",
    title: "User Research Highlights",
    createdAt: "2026-02-14T08:05:00.000Z",
    updatedAt: "2026-02-15T18:30:00.000Z",
    messageCount: 11,
    archived: false,
    pinned: false,
    sortOrder: 2,
  },
];

const TIMELINE_STEPS: TimelineStep[] = [
  {
    id: "tl-1",
    ts: "2026-02-17T08:40:19.000Z",
    phase: "tool_start",
    iteration: 1,
    tool: "kb_search",
    args_preview: { query: "weekly update onboarding churn trial" },
  },
  {
    id: "tl-2",
    ts: "2026-02-17T08:40:20.300Z",
    phase: "tool_result",
    iteration: 1,
    tool: "kb_search",
    args_preview: { query: "weekly update onboarding churn trial" },
    result_preview: "6 chunks matched across roadmap and metrics notes",
  },
  {
    id: "tl-3",
    ts: "2026-02-17T08:40:21.000Z",
    phase: "tool_start",
    iteration: 1,
    tool: "kb_read",
    args_preview: { path: "metrics/weekly-2026-07.md" },
  },
  {
    id: "tl-4",
    ts: "2026-02-17T08:40:21.900Z",
    phase: "tool_result",
    iteration: 1,
    tool: "kb_read",
    args_preview: { path: "metrics/weekly-2026-07.md" },
    result_preview: "Loaded KPI deltas and churn segments",
  },
  {
    id: "tl-5",
    ts: "2026-02-17T08:40:22.400Z",
    phase: "tool_start",
    iteration: 1,
    tool: "kb_read",
    args_preview: { path: "Research/interviews-q1.md" },
  },
  {
    id: "tl-6",
    ts: "2026-02-17T08:40:23.500Z",
    phase: "tool_result",
    iteration: 1,
    tool: "kb_read",
    args_preview: { path: "Research/interviews-q1.md" },
    result_preview: "Loaded retention pain points and onboarding quotes",
  },
];

const THINKING_TRAIL: ThinkingEntry[] = [
  {
    summary: "Compared KPI trend shifts against interview themes.",
    ts: "2026-02-17T08:40:20.900Z",
  },
  {
    summary: "Ranked sprint risks by impact and confidence.",
    ts: "2026-02-17T08:40:22.900Z",
  },
];

const CHAT_MESSAGES: Message[] = [
  {
    id: "m-1",
    role: "user",
    content: "Summarize the weekly update from my notes over the past 7 days.",
    timestamp: Date.parse("2026-02-17T08:40:00.000Z"),
  },
  {
    id: "m-2",
    role: "assistant",
    content:
      "Three key shifts this week: onboarding speed improved by 22%, trial churn rose by 4 pp, and users are opening linked notes from agent responses more often.",
    timestamp: Date.parse("2026-02-17T08:40:08.000Z"),
    sources: ["metrics/weekly-2026-07.md", "Research/interviews-q1.md"],
  },
  {
    id: "m-3",
    role: "user",
    content: "Draft the sprint plan with tasks and risks.",
    timestamp: Date.parse("2026-02-17T08:40:40.000Z"),
  },
  {
    id: "m-4",
    role: "assistant",
    content:
      "Sprint plan: 1) speed up first-response in chat, 2) simplify onboarding to 3 steps, 3) add quick actions to the sidebar. Risks: growth in invalid queries and a drop in source ranking quality.",
    timestamp: Date.parse("2026-02-17T08:40:48.000Z"),
    sources: ["Projects/Meld/Roadmap.md", "Research/interviews-q1.md"],
    runId: "run-weekly-2401",
    timelineSteps: TIMELINE_STEPS,
    thinkingEntries: THINKING_TRAIL,
  },
  {
    id: "m-5",
    role: "user",
    content: "Open the note with UI recommendations for the next sprint.",
    timestamp: Date.parse("2026-02-17T08:41:00.000Z"),
  },
  {
    id: "m-6",
    role: "assistant",
    content:
      "Opened `Projects/Meld/UI-Iteration.md`. Pulled out 5 priorities: empty states, quick actions, status bar contrast, more visible history, onboarding CTA.",
    timestamp: Date.parse("2026-02-17T08:41:09.000Z"),
    sources: ["Projects/Meld/UI-Iteration.md"],
  },
];

const WORKFLOW_MESSAGES: Message[] = [
  ...CHAT_MESSAGES,
  {
    id: "m-7",
    role: "user",
    content: "Keep the chat open and draft a commit summary.",
    timestamp: Date.parse("2026-02-17T08:41:25.000Z"),
  },
  {
    id: "m-8",
    role: "assistant",
    content:
      "Draft ready: `feat: refine onboarding and citation discovery flow` + 3 bullet points from the changed notes. I can save it to `Projects/Meld/Release Notes.md`.",
    timestamp: Date.parse("2026-02-17T08:41:33.000Z"),
    sources: ["Projects/Meld/Release Notes.md", "Projects/Meld/UI-Iteration.md"],
    runId: "run-weekly-2402",
    timelineSteps: [
      {
        id: "tlw-1",
        ts: "2026-02-17T08:41:27.000Z",
        phase: "tool_start",
        iteration: 2,
        tool: "kb_read",
        args_preview: { path: "Projects/Meld/UI-Iteration.md" },
      },
      {
        id: "tlw-2",
        ts: "2026-02-17T08:41:28.100Z",
        phase: "tool_result",
        iteration: 2,
        tool: "kb_read",
        args_preview: { path: "Projects/Meld/UI-Iteration.md" },
        result_preview: "Loaded sprint priorities and acceptance targets",
      },
      {
        id: "tlw-3",
        ts: "2026-02-17T08:41:29.000Z",
        phase: "tool_start",
        iteration: 2,
        tool: "kb_create",
        args_preview: { path: "Projects/Meld/Release Notes.md" },
        file_changes: [{ path: "Projects/Meld/Release Notes.md", action: "create", bytes: 2480 }],
      },
      {
        id: "tlw-4",
        ts: "2026-02-17T08:41:30.100Z",
        phase: "tool_result",
        iteration: 2,
        tool: "kb_create",
        args_preview: { path: "Projects/Meld/Release Notes.md" },
        file_changes: [{ path: "Projects/Meld/Release Notes.md", action: "create", bytes: 2480 }],
        result_preview: "Created markdown draft with commit summary",
      },
    ],
    thinkingEntries: [
      {
        summary: "Mapped note priorities to concise release language.",
        ts: "2026-02-17T08:41:28.800Z",
      },
    ],
  },
];

const MOCK_VAULT_ENTRIES: VaultEntry[] = [
  {
    kind: "folder",
    path: "~/notes/Projects",
    relative_path: "Projects",
  },
  {
    kind: "file",
    path: "~/notes/Projects/Meld/UI-Iteration.md",
    relative_path: "Projects/Meld/UI-Iteration.md",
  },
  {
    kind: "file",
    path: "~/notes/Projects/Meld/Roadmap.md",
    relative_path: "Projects/Meld/Roadmap.md",
  },
  {
    kind: "file",
    path: "~/notes/Projects/Meld/Release Notes.md",
    relative_path: "Projects/Meld/Release Notes.md",
  },
  {
    kind: "folder",
    path: "~/notes/Research",
    relative_path: "Research",
  },
  {
    kind: "file",
    path: "~/notes/Research/interviews-q1.md",
    relative_path: "Research/interviews-q1.md",
  },
  {
    kind: "file",
    path: "~/notes/metrics/weekly-2026-07.md",
    relative_path: "metrics/weekly-2026-07.md",
  },
];

const NOTE_MARKDOWN = `---
title: UI Iteration Plan
tags: [meld, ui, sprint]
owner: design
---

# UI Iteration Plan

## Sprint priorities

- Improve empty chat state clarity
- Make knowledge panel easier to discover
- Keep history close to conversation context
- Add faster "Open source note" actions in responses

## Candidate experiments

1. Compact toolbar in the chat header
2. Higher contrast status indicators
3. Faster note previews with cached rendering
4. Keep citation cards visible while scrolling

## Acceptance targets

- Reduce time-to-first-meaningful-action by 20%
- Increase opened citation notes by 15%
- Keep response latency under 2.5s p95
`;

function normalizeScene(scene: string | null): PresskitScene {
  switch ((scene || "hero").toLowerCase()) {
    case "chat":
      return "chat";
    case "note":
      return "note";
    case "workflow":
      return "workflow";
    case "onboarding":
      return "onboarding";
    default:
      return "hero";
  }
}

function normalizeHeroVariant(variant: string | null): HeroVariant {
  switch ((variant || "landing").toLowerCase()) {
    case "platform":
      return "platform";
    case "cinematic":
      return "cinematic";
    default:
      return "landing";
  }
}

function configureScene(scene: PresskitScene) {
  const state = useAppStore.getState();
  const showNote = scene === "note" || scene === "workflow";
  const isKnowledgeView = scene === "workflow";

  state.setConversations(MOCK_CONVERSATIONS);
  state.setActiveConversation(isKnowledgeView ? "conv-roadmap" : "conv-weekly");
  state.setMessages(scene === "workflow" ? WORKFLOW_MESSAGES : CHAT_MESSAGES);
  state.setVaultPath("~/notes", 428);
  state.setChatProvider("anthropic");
  state.setChatModel("claude-opus-4-6");
  state.setEmbeddingProvider("openai");
  state.setViewMode(isKnowledgeView ? "files" : "chats");

  useAppStore.setState({
    isOnboarded: scene !== "onboarding",
    showSettings: false,
    showHistory: false,
    activeNote: showNote ? "Projects/Meld/UI-Iteration.md" : null,
    noteHistory: showNote ? ["Projects/Meld/Roadmap.md", "Projects/Meld/UI-Iteration.md"] : [],
    noteHistoryIndex: showNote ? 1 : -1,
    isIndexing: false,
    indexProgress: null,
    agentActivity: null,
    isStreaming: false,
    streamingContent: "",
    latestThinkingSummary: null,
    thinkingLog: [],
    toolCallLog: [],
    toolResultsLog: [],
    timelineSteps: [],
  });
}

function noop() {
  return undefined;
}

async function noopAsync() {
  return undefined;
}

function WorkspaceFrame({ scene }: { scene: Exclude<PresskitScene, "onboarding"> }) {
  const modelId = "anthropic:claude-opus-4-6";
  const showNoteAside = scene === "note" || scene === "workflow";

  return (
    <div className="relative flex h-full bg-bg [filter:brightness(1.08)_contrast(1.08)]">
      <Sidebar
        conversations={MOCK_CONVERSATIONS}
        activeConversationId={scene === "workflow" ? "conv-roadmap" : "conv-weekly"}
        vaultEntries={MOCK_VAULT_ENTRIES}
        loadingVaultFiles={false}
        activeNotePath={showNoteAside ? "Projects/Meld/UI-Iteration.md" : null}
        onSelectConversation={noop}
        onSelectNote={noop}
        onNewChat={noop}
        onRenameConversation={noopAsync}
        onReorderConversations={noopAsync}
        onArchiveConversation={noopAsync}
        onUnarchiveConversation={noopAsync}
        onPinConversation={noopAsync}
        onUnpinConversation={noopAsync}
        onCreateKbNote={noopAsync}
        onCreateKbFolder={noopAsync}
        onArchiveKbEntry={noopAsync}
        onMoveKbEntry={noopAsync}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(56%_46%_at_50%_18%,rgba(241,231,198,0.08)_0%,rgba(232,228,220,0)_74%)]"
        />

        <header className="relative z-10 flex items-center justify-between border-b border-border/20 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-accent/14 text-xs font-semibold text-accent">
              M
            </span>
            <h1 className="font-display text-[15px] italic tracking-tight text-text">meld</h1>
            <span className="max-w-[260px] truncate text-xs text-text-muted">~/notes</span>
          </div>
          <div className="text-xs text-text-muted">{SCENE_LABELS[scene]}</div>
        </header>

        <div className="relative z-10 flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <ChatView
              onSendMessage={noop}
              onRegenerateLastResponse={noop}
              onEditMessage={noop}
              onDeleteMessage={noop}
              onOpenNote={noop}
            />
          </div>

          {showNoteAside && (
            <aside className="w-[460px] overflow-y-auto border-l border-border/20 bg-bg-secondary/55">
              <NotePreview
                notePath="Projects/Meld/UI-Iteration.md"
                content={NOTE_MARKDOWN}
                loading={false}
                canGoBack
                canGoForward={false}
                onGoBack={noop}
                onGoForward={noop}
                onOpenNote={noop}
                onOpenInEditor={noop}
              />
            </aside>
          )}
        </div>

        <StatusBar
          vaultPath="~/notes"
          fileCount={428}
          modelId={modelId}
          isIndexing={false}
          indexProgress={null}
          onReindex={noop}
        />
      </div>
    </div>
  );
}

function HeroScene({ variant }: { variant: HeroVariant }) {
  const heroTheme =
    variant === "platform"
      ? {
          containerClass:
            "relative h-screen overflow-hidden bg-[radial-gradient(circle_at_18%_16%,rgba(196,226,255,0.30),transparent_44%),radial-gradient(circle_at_80%_12%,rgba(183,205,255,0.24),transparent_42%),linear-gradient(180deg,#141a2a,#0f131d)] px-8 py-7",
          overlayClass:
            "pointer-events-none absolute inset-0 bg-[linear-gradient(108deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0)_34%)]",
          heading:
            "Knowledge Platform for your markdown workspace",
          subheading:
            "A product-style landing hero: one place for AI conversations, source-backed answers, and safe note automation with git rollback.",
          badge: "Platform landing concept",
          chips: [
            "Unified knowledge + assistant",
            "Source-backed responses",
            "Git-safe writes and rollback",
          ],
          frameClass:
            "min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/16 bg-[#11182a]/86 shadow-[0_28px_80px_rgba(0,0,0,0.50)] backdrop-blur",
        }
      : variant === "cinematic"
        ? {
            containerClass:
              "relative h-screen overflow-hidden bg-[radial-gradient(circle_at_12%_8%,rgba(255,175,104,0.18),transparent_35%),radial-gradient(circle_at_86%_18%,rgba(147,125,255,0.22),transparent_36%),linear-gradient(180deg,#151118,#0d1018)] px-8 py-7",
            overlayClass:
              "pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.07)_0%,rgba(255,255,255,0)_38%)]",
            heading: "AI Workspace for Deep Note-Driven Work",
            subheading:
              "Designed for long-form knowledge workflows: ask, inspect reasoning, open notes inline, and keep every AI change reviewable.",
            badge: "Cinematic dark concept",
            chips: ["Reasoning timeline", "Split note workflow", "Desktop-first velocity"],
            frameClass:
              "min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/14 bg-[#141927]/84 shadow-[0_30px_90px_rgba(0,0,0,0.56)] backdrop-blur",
          }
        : {
            containerClass:
              "relative h-screen overflow-hidden bg-[radial-gradient(circle_at_15%_15%,rgba(163,198,255,0.32),transparent_42%),radial-gradient(circle_at_85%_12%,rgba(236,179,255,0.24),transparent_38%),linear-gradient(180deg,#131c2f,#0f1219)] px-8 py-7",
            overlayClass:
              "pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0)_36%)]",
            heading:
              "Local-first AI for markdown knowledge bases",
            subheading:
              "Ask questions, cite source notes, update files, and keep every AI edit reversible through automatic git commits.",
            badge: "Rust core • Next.js UI • Offline-first workflow",
            chips: ["Citations from notes", "Tool timeline in answers", "Auto-commit on every write"],
            frameClass:
              "min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/18 bg-[#121a29]/84 shadow-[0_28px_80px_rgba(0,0,0,0.48)] backdrop-blur",
          };

  return (
    <div className={heroTheme.containerClass}>
      <div
        aria-hidden
        className={heroTheme.overlayClass}
      />

      <div className="relative mx-auto flex h-full max-w-[1640px] flex-col gap-5">
        <div className="rounded-2xl border border-white/14 bg-black/12 px-7 py-5 backdrop-blur-xl">
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#e6ecff]/70">Meld Desktop</p>
              <h2 className="mt-2 text-5xl font-semibold tracking-tight text-white">
                {heroTheme.heading}
              </h2>
              <p className="mt-3 max-w-4xl text-[15px] leading-relaxed text-[#e4e9f6]/85">
                {heroTheme.subheading}
              </p>
            </div>
            <div className="shrink-0 rounded-full border border-white/24 bg-white/10 px-4 py-2 text-xs text-white/90">
              {heroTheme.badge}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-white/80">
            {heroTheme.chips.map((chip) => (
              <span key={chip} className="rounded-full border border-white/18 bg-white/7 px-3 py-1">
                {chip}
              </span>
            ))}
          </div>
        </div>

        <div className={heroTheme.frameClass}>
          <WorkspaceFrame scene="hero" />
        </div>
      </div>
    </div>
  );
}

function PresskitScene() {
  const searchParams = useSearchParams();
  const scene = normalizeScene(searchParams.get("scene"));
  const heroVariant = normalizeHeroVariant(
    searchParams.get("heroStyle") ?? searchParams.get("hero"),
  );

  useEffect(() => {
    configureScene(scene);
  }, [scene]);

  if (scene === "onboarding") {
    return <OnboardingFlow />;
  }

  if (scene === "hero") {
    return <HeroScene variant={heroVariant} />;
  }

  return (
    <div className="h-screen bg-bg">
      <WorkspaceFrame scene={scene} />
    </div>
  );
}

export default function PresskitPage() {
  return (
    <Suspense fallback={<div className="h-screen bg-bg" />}>
      <PresskitScene />
    </Suspense>
  );
}
