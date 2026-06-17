/**
 * Public surface of the orchestrator. Phase-07's CLI imports from here to
 * wire docker (phase-04) + manifest store + config into `runDriver`.
 */

export {
  runDriver,
  routeExit,
  selectEligible,
  selectTerminal,
  manifestStore,
  type DriverDeps,
  type DriverInput,
  type ExitDecision,
  type TerminalDecision,
  type ManifestStore,
} from "./driver.js";

export {
  prepareWorktree,
  setCapturePaths,
  launch,
  killWorker,
  cleanup,
  workerPromptSuffix,
  workerPromptSuffixIsolated,
  type WorkerDeps,
  type LaunchOptions,
  type PrepareWorktreeOptions,
  type PrepareWorktreeResult,
} from "./worker.js";

export {
  branchHasDone,
  commitBuildLog,
  markResume,
  mergePhase,
  resolveDerivedConflicts,
  supervise,
  type SupervisorContext,
  type SupervisorMode,
  type SuperviseOutcome,
  type MergeResult,
} from "./supervisor.js";

export {
  listControlRequests,
  consumeControlFile,
  processControl,
  checkStuck,
  type ControlAction,
  type ControlRequest,
  type ControlContext,
  type StuckContext,
} from "./control.js";

export type {
  DockerLike,
  DockerMount,
  DockerRunOpts,
  DockerRunResult,
  WorkerRecord,
  WorkerExit,
  EligibilityState,
} from "./types.js";
