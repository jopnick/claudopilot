/**
 * The production `WorkerAgentRunner` for the in-container entrypoint.
 *
 * `workerEntry.ts` is intentionally agnostic about *how* an agent runs — it
 * delegates to a `WorkerAgentRunner` (the phase-04 DI seam). This module wires
 * that seam to `agent/capture.ts`, the in-process `claude`/`opencode` capture
 * pipeline (raw NDJSON + rendered transcript + log), replacing the bash
 *
 *     claude -p … | tee … | node render-stream.mjs | tee …
 *
 * pipeline that `worker-entry.sh` used. Driver/model/supervisor are read from
 * the env the orchestrator forwarded into the container (AGENT_DRIVER,
 * AGENT_MODEL, SUPERVISOR_MODE) so a single `claudopilot __worker` invocation
 * needs no flags.
 */

import type { spawn as nodeSpawn } from "node:child_process";
import { captureAgent, type AgentDriver } from "../agent/capture.js";
import type {
  AgentRunFreshInput,
  AgentRunResumeInput,
  WorkerAgentRunner,
} from "./workerEntry.js";

/**
 * @param env    Forwarded container env (AGENT_DRIVER, AGENT_MODEL, SUPERVISOR_MODE).
 * @param spawn  Test seam — forwarded to `captureAgent`; production omits it.
 */
export function makeCaptureRunner(
  env: NodeJS.ProcessEnv = process.env,
  spawn?: typeof nodeSpawn,
): WorkerAgentRunner {
  const driver: AgentDriver = env["AGENT_DRIVER"] === "opencode" ? "opencode" : "claude";
  const model = env["AGENT_MODEL"] ?? "";
  const supervisorMode = !!env["SUPERVISOR_MODE"] && env["SUPERVISOR_MODE"] !== "";

  return {
    async runFresh(input: AgentRunFreshInput): Promise<number> {
      const r = await captureAgent({
        driver,
        id: input.phaseId,
        prompt: input.prompt,
        cwd: input.workdir,
        paths: input.paths,
        ...(model ? { model } : {}),
        supervisorMode,
        ...(spawn ? { spawn } : {}),
      });
      return r.code ?? 1;
    },
    async runResume(input: AgentRunResumeInput): Promise<number> {
      const r = await captureAgent({
        driver,
        id: input.phaseId,
        prompt: input.resumeMessage,
        resumeSid: input.sessionId,
        cwd: input.workdir,
        paths: input.paths,
        ...(model ? { model } : {}),
        supervisorMode,
        ...(spawn ? { spawn } : {}),
      });
      return r.code ?? 1;
    },
  };
}
