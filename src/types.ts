/**
 * Shared type vocabulary for the TypeScript engine port.
 *
 * Every other phase (02–08) imports from here; renaming or re-shaping a type
 * in this file is a cross-cutting change. See phase-01 doc for the rationale.
 */

import type { ChildProcess } from "node:child_process";

// ── Manifest model ──────────────────────────────────────────────────────────

export type PhaseState =
  | "pending"
  | "running"
  | "merged"
  | "failed"
  | "blocked";

export interface PhaseEntry {
  id: string;
  state: PhaseState;
  title: string;
  deps: string[];
}

export interface ManifestModel {
  status: string;
  phases: PhaseEntry[];
}

// ── Config (mirrors claudopilot.config.sh + run-loop.sh env knobs) ──────────

export interface Config {
  repoRoot: string;
  configPath: string;

  roadmapDir: string;
  manifest: string;

  agentDriver: string;
  agentModel: string;

  promptFile: string;
  supervisorPromptFile: string;
  workerProjectPrompt: string;
  supervisorProjectPrompt: string;

  isolated: boolean;
  workerImage: string;

  maxParallel: number;
  pollSeconds: number;
  maxIter: number;
  maxSupervisorAttemptsPerPhase: number;

  keepGoing: boolean;
  gateCmd: string;
  worktreePrepareCmd: string;
  bootstrapCmd: string;
  buildCmd: string;

  usageWindowSeconds: number;
  maxTicksPerWindow: number;
  usageThresholdPct: number;
  defaultRateLimitSleep: number;

  ignoreLoopCheckpoints: boolean;

  retryTransientApi: boolean;
  transientApiMaxRetries: number;
  stuckTimeout: number;

  runDir: string;
  worktreesDir: string;
  controlDir: string;
  logFile: string;
}

// ── Agent stream events (subset of `claude -p --output-format stream-json`) ─

export type AgentEventType = "system" | "assistant" | "user" | "result";

export interface AgentSystemEvent {
  type: "system";
  subtype?: string;
  session_id?: string;
  model?: string;
  tools?: unknown[];
  cwd?: string;
}

export interface AgentTextBlock {
  type: "text";
  text?: string;
}

export interface AgentThinkingBlock {
  type: "thinking";
  thinking?: string;
}

export interface AgentToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AgentToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export type AgentContentBlock =
  | AgentTextBlock
  | AgentThinkingBlock
  | AgentToolUseBlock
  | AgentToolResultBlock
  | { type: string; [k: string]: unknown };

export interface AgentMessageEvent {
  type: "assistant" | "user";
  message?: { content?: AgentContentBlock[] };
}

export interface AgentResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
}

export type AgentEvent =
  | AgentSystemEvent
  | AgentMessageEvent
  | AgentResultEvent
  | { type: string; [k: string]: unknown };

// ── Rendered transcript blocks (what render-stream emits) ──────────────────

export type RenderBlockKind =
  | "session"
  | "assistantText"
  | "userText"
  | "thinking"
  | "toolUse"
  | "toolResult"
  | "result";

export interface RenderBlock {
  kind: RenderBlockKind;
  /** Pre-formatted text body — what would land in the .transcript.md file. */
  text: string;
  /** Optional metadata for clients that want structure (web transcript). */
  meta?: Record<string, unknown>;
}

// ── Per-phase capture artifacts on disk ────────────────────────────────────

export interface CapturePaths {
  log: string;
  stream: string;
  transcript: string;
}

// ── Worker handle (in-process) ─────────────────────────────────────────────

export interface WorkerHandle {
  id: string;
  pid?: number;
  child?: ChildProcess;
}

// ── Progress snapshot model (superset used by progress.mjs + web) ──────────

export interface ProgressSliceEntry {
  id: string;
  title: string;
  checked: boolean;
  sha?: string | null;
}

export interface ProgressStep {
  label: string;
  detail: string | null;
  since: number;
}

export interface ProgressPhase extends PhaseEntry {
  branch: string;
  hasBranch: boolean;
  hasWorktree: boolean;
  docSource: string | null;
  doneDoc: boolean;
  checklistSeeded: boolean;
  slices: ProgressSliceEntry[];
  slicesDone: number;
  slicesTotal: number;
  lastCommit: string | null;
  step: ProgressStep | null;
  activity: string | null;
}

export interface ProgressSummary {
  total: number;
  merged: number;
  running: number;
  pending: number;
  blocked: number;
  failed: number;
  slicesDone: number;
  slicesTotal: number;
  pctPhases: number;
  pctSlices: number;
}

export interface ProgressSnapshot {
  manifest: string;
  manifestStatus: string;
  container: string | null;
  lastDriverEvent: string | null;
  summary: ProgressSummary;
  phases: ProgressPhase[];
  error?: string;
}
