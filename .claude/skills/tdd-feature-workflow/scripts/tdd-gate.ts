#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  classifyPath,
  decidePreToolUse,
  evaluateGreen,
  evaluateRed,
  type GatePhase,
  type WorkerRole,
} from "./tdd-gate-lib";

interface CommandEvidence {
  command: string[];
  exitCode: number;
  outputHash: string;
  outputExcerpt: string;
  verifiedAt: string;
}

interface CommandResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

interface GateState {
  version: 1;
  task: string;
  phase: GatePhase;
  startedAt: string;
  updatedAt: string;
  baselineHashes: Record<string, string>;
  agents: Partial<Record<Exclude<WorkerRole, "main">, string>>;
  red?: CommandEvidence & {
    expectedPattern: string;
    testFiles: string[];
    testHashes: Record<string, string>;
  };
  green?: CommandEvidence;
  verification?: Array<CommandEvidence & { name: string }>;
  blocked?: {
    role: Exclude<WorkerRole, "main">;
    reason: string;
    reportedAt: string;
  };
}

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
  };
  last_assistant_message?: string;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const statePath = join(projectDir, ".claude", "tdd-state.json");
const action = process.argv[2] ?? "help";
const args = process.argv.slice(3);

switch (action) {
  case "start":
    startWorkflow(args);
    break;
  case "status":
    showStatus();
    break;
  case "red":
    proveRed(args);
    break;
  case "green":
    proveGreen(args);
    break;
  case "verify":
    verifyWorkflow();
    break;
  case "abort":
    abortWorkflow(args);
    break;
  case "resume":
    resumeWorkflow();
    break;
  case "hook-pre-tool":
    await handlePreToolHook();
    break;
  case "hook-post-tool":
    await handlePostToolHook();
    break;
  case "hook-subagent-start":
    await handleSubagentStartHook();
    break;
  case "hook-subagent-stop":
    await handleSubagentStopHook();
    break;
  case "hook-stop":
    handleStopHook();
    break;
  default:
    printHelp();
}

function startWorkflow(commandArgs: string[]): void {
  const task = optionValues(commandArgs, "--task").at(0)?.trim();
  if (!task) fail('Usage: tdd-gate.ts start --task "feature summary"');

  const existing = readState();
  if (existing && existing.phase !== "complete") {
    fail(
      `A TDD workflow is already active for "${existing.task}" at phase ${existing.phase}. Resume it or abort it explicitly.`
    );
  }

  const now = new Date().toISOString();
  const state: GateState = {
    version: 1,
    task,
    phase: "awaiting_red",
    startedAt: now,
    updatedAt: now,
    baselineHashes: collectChangedHashes(),
    agents: {},
  };

  writeState(state);
  console.log(`TDD workflow started: ${task}`);
  console.log("Phase: awaiting_red");
}

function showStatus(): void {
  const state = readState();
  if (!state) {
    console.log("No active TDD workflow.");
    return;
  }

  console.log(JSON.stringify(state, null, 2));
}

function proveRed(commandArgs: string[]): void {
  const state = requireState();
  if (state.phase !== "awaiting_red") {
    fail(`RED requires phase awaiting_red; current phase is ${state.phase}.`);
  }

  const expectedPattern = optionValues(commandArgs, "--expect").at(0) ?? "";
  const testFiles = optionValues(commandArgs, "--test").map(normalizeProjectPath);
  const command = commandAfterSeparator(commandArgs);

  if (!expectedPattern)
    fail("RED requires --expect with the failing test name or marker.");
  if (testFiles.length === 0) fail("RED requires at least one --test path.");
  if (command.length === 0) fail("RED requires a focused test command after --.");

  const invalidTestPath = testFiles.find((path) => classifyPath(path) !== "test");
  if (invalidTestPath)
    fail(`RED test path is not recognized as a test: ${invalidTestPath}`);

  const currentHashes = collectChangedHashes();
  const productionChanges = changedSinceBaseline(
    state.baselineHashes,
    currentHashes
  ).filter((path) => classifyPath(path) === "production");
  const changedTests = testFiles.filter(
    (path) => hashPath(path) !== state.baselineHashes[path]
  );
  const result = runCommand(command);
  if (result.timedOut) {
    fail(`RED rejected: focused test command timed out.\n\n${excerpt(result.output)}`);
  }

  const decision = evaluateRed({
    exitCode: result.exitCode,
    output: result.output,
    expectedPattern,
    changedTests,
    productionChanges,
  });

  if (!decision.allowed) {
    fail(`${decision.reason}\n\n${excerpt(result.output)}`);
  }

  state.phase = "red_verified";
  state.red = {
    ...evidence(command, result),
    expectedPattern,
    testFiles,
    testHashes: Object.fromEntries(testFiles.map((path) => [path, hashPath(path)])),
  };
  delete state.green;
  delete state.verification;
  delete state.blocked;
  writeState(state);

  console.log("RED verified: focused tests failed for the expected behavioral reason.");
  console.log(excerpt(result.output));
}

function proveGreen(commandArgs: string[]): void {
  const state = requireState();
  if (state.phase !== "red_verified" || !state.red) {
    fail(`GREEN requires phase red_verified; current phase is ${state.phase}.`);
  }

  const command = commandAfterSeparator(commandArgs);
  if (command.length === 0) fail("GREEN requires the focused test command after --.");

  if (!commandsMatch(command, state.red.command)) {
    fail(`GREEN requires the exact focused RED command: ${state.red.command.join(" ")}`);
  }

  const testsUnchanged = testHashesMatch(state.red.testHashes);
  if (!testsUnchanged) {
    invalidateRed(state);
    fail("GREEN rejected: tests changed after RED. State reset to awaiting_red.");
  }

  const result = runCommand(command);
  const decision = evaluateGreen({ exitCode: result.exitCode, testsUnchanged });
  if (!decision.allowed) fail(`${decision.reason}\n\n${excerpt(result.output)}`);

  state.phase = "green_verified";
  state.green = evidence(command, result);
  delete state.verification;
  delete state.blocked;
  writeState(state);

  console.log("GREEN verified: the unchanged RED tests now pass.");
  console.log(excerpt(result.output));
}

function verifyWorkflow(): void {
  const state = requireState();
  if (state.phase !== "green_verified" || !state.red || !state.green) {
    fail(`VERIFY requires phase green_verified; current phase is ${state.phase}.`);
  }

  if (!testHashesMatch(state.red.testHashes)) {
    invalidateRed(state);
    fail("VERIFY rejected: tests changed after RED. State reset to awaiting_red.");
  }

  const checks: Array<{ name: string; command: string[] }> = [
    { name: "format", command: ["bun", "run", "format"] },
  ];
  const verification: GateState["verification"] = [];

  for (const check of checks) {
    const result = runCommand(check.command);
    verification.push({ name: check.name, ...evidence(check.command, result) });
    if (result.exitCode !== 0) {
      state.verification = verification;
      writeState(state);
      fail(`Verification failed at ${check.name}.\n\n${excerpt(result.output)}`);
    }
  }

  state.red.testHashes = Object.fromEntries(
    state.red.testFiles.map((path) => [path, hashPath(path)])
  );
  const focusedResult = runCommand(state.green.command);
  verification.push({
    name: "focused-green-after-format",
    ...evidence(state.green.command, focusedResult),
  });
  if (focusedResult.exitCode !== 0) {
    state.phase = "red_verified";
    delete state.green;
    state.verification = verification;
    writeState(state);
    fail(
      `Focused tests failed after formatting. Resume feature-engineer.\n\n${excerpt(focusedResult.output)}`
    );
  }

  const remainingChecks: Array<{ name: string; command: string[] }> = [
    { name: "lint", command: ["bun", "run", "lint"] },
    { name: "typecheck", command: ["bun", "run", "typecheck"] },
    { name: "test", command: ["bun", "test"] },
    { name: "build", command: ["bun", "run", "build"] },
  ];

  for (const check of remainingChecks) {
    const result = runCommand(check.command);
    verification.push({ name: check.name, ...evidence(check.command, result) });
    if (result.exitCode !== 0) {
      state.verification = verification;
      writeState(state);
      fail(`Verification failed at ${check.name}.\n\n${excerpt(result.output)}`);
    }
  }

  state.phase = "complete";
  state.verification = verification;
  delete state.blocked;
  writeState(state);
  console.log(
    "TDD workflow complete: RED, GREEN, and the full quality suite are verified."
  );
}

function abortWorkflow(commandArgs: string[]): void {
  const reason = optionValues(commandArgs, "--reason").at(0)?.trim();
  if (!reason) fail("Abort requires --reason so cancellation is explicit.");
  if (existsSync(statePath)) unlinkSync(statePath);
  console.log(`TDD workflow aborted: ${reason}`);
}

function resumeWorkflow(): void {
  const state = requireState();
  if (!state.blocked) fail("The active TDD workflow is not waiting on a blocker.");
  const previous = state.blocked;
  delete state.blocked;
  writeState(state);
  console.log(`TDD workflow resumed after ${previous.role} blocker: ${previous.reason}`);
}

async function handlePreToolHook(): Promise<void> {
  const state = readState();
  if (!state || state.phase === "complete") return;

  const input = await readHookInput();
  const role = roleForAgent(state, input.agent_id);
  const decision = decidePreToolUse({
    phase: state.phase,
    role,
    toolName: input.tool_name ?? "",
    filePath: input.tool_input?.file_path
      ? normalizeProjectPath(input.tool_input.file_path)
      : undefined,
    command: input.tool_input?.command,
  });

  if (!decision.allowed) blockHook(decision.reason ?? "Blocked by TDD gate.");
}

async function handlePostToolHook(): Promise<void> {
  const state = readState();
  if (!state || state.phase === "complete") return;

  const input = await readHookInput();
  const role = roleForAgent(state, input.agent_id);
  const currentHashes = collectChangedHashes();
  const changes = changedSinceBaseline(state.baselineHashes, currentHashes);
  const productionChanges = changes.filter((path) => classifyPath(path) === "production");

  if (
    productionChanges.length > 0 &&
    (state.phase === "awaiting_red" || role === "test-engineer")
  ) {
    blockHook(
      `Production changes are not allowed for ${role} during ${state.phase}: ${productionChanges.join(", ")}`
    );
  }

  if (state.red && !testHashesMatch(state.red.testHashes)) {
    invalidateRed(state);
    blockHook("Test files changed after RED; TDD state reset to awaiting_red.");
  }
}

async function handleSubagentStartHook(): Promise<void> {
  const state = readState();
  if (!state || state.phase === "complete") return;

  const input = await readHookInput();
  const role = roleFromAgentType(input.agent_type);
  if (!role || !input.agent_id) return;

  const registered = state.agents[role];
  if (!registered) {
    state.agents[role] = input.agent_id;
    writeState(state);
  }

  const additionalContext =
    registered && registered !== input.agent_id
      ? `A ${role} is already registered as ${registered}. Do not take ownership; tell the main agent to resume the registered worker.`
      : role === "test-engineer"
        ? "You own tests only. Do not edit production code. You may stop only after tdd-gate RED succeeds."
        : "You own production code only. Do not edit tests. You may stop only after tdd-gate GREEN succeeds.";

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext,
      },
    })
  );
}

async function handleSubagentStopHook(): Promise<void> {
  const state = readState();
  if (!state || state.phase === "complete") return;

  const input = await readHookInput();
  const role = roleFromAgentType(input.agent_type);
  if (!role) return;

  const registered = state.agents[role];
  if (registered && input.agent_id && registered !== input.agent_id) return;

  const blockedReason = input.last_assistant_message
    ?.split("TDD_BLOCKED:", 2)
    .at(1)
    ?.trim();
  if (blockedReason) {
    state.blocked = {
      role,
      reason: blockedReason,
      reportedAt: new Date().toISOString(),
    };
    writeState(state);
    return;
  }

  if (role === "test-engineer" && state.phase !== "red_verified") {
    blockHook(
      "RED is not verified. Keep working on tests and run the tdd-gate red command before stopping."
    );
  }

  if (
    role === "feature-engineer" &&
    state.phase !== "green_verified" &&
    state.phase !== "complete"
  ) {
    blockHook(
      "GREEN is not verified. Keep the RED tests unchanged, finish the minimum implementation, and run the tdd-gate green command before stopping."
    );
  }
}

function handleStopHook(): void {
  const state = readState();
  if (!state || state.phase === "complete" || state.blocked) return;

  blockHook(
    `TDD workflow "${state.task}" is still at ${state.phase}. Continue orchestration, resume the registered worker when needed, or explicitly abort with a reason if the user cancels.`
  );
}

function invalidateRed(state: GateState): void {
  state.phase = "awaiting_red";
  delete state.red;
  delete state.green;
  delete state.verification;
  delete state.blocked;
  writeState(state);
}

function roleForAgent(state: GateState, agentId?: string): WorkerRole {
  if (agentId && state.agents["test-engineer"] === agentId) return "test-engineer";
  if (agentId && state.agents["feature-engineer"] === agentId) return "feature-engineer";
  return "main";
}

function roleFromAgentType(agentType?: string): Exclude<WorkerRole, "main"> | undefined {
  if (agentType === "test-engineer" || agentType === "feature-engineer") {
    return agentType;
  }
  return undefined;
}

function collectChangedHashes(): Record<string, string> {
  const commands = [
    ["git", "diff", "--name-only", "-z"],
    ["git", "diff", "--cached", "--name-only", "-z"],
    ["git", "ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const paths = new Set<string>();

  for (const command of commands) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: projectDir,
      encoding: "utf8",
    });
    if (result.status !== 0) fail(`Unable to inspect git working tree: ${result.stderr}`);
    for (const path of (result.stdout ?? "").split("\0").filter(Boolean)) paths.add(path);
  }

  return Object.fromEntries([...paths].sort().map((path) => [path, hashPath(path)]));
}

function changedSinceBaseline(
  baseline: Record<string, string>,
  current: Record<string, string>
): string[] {
  const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  return [...paths].filter((path) => hashPath(path) !== baseline[path]);
}

function testHashesMatch(expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([path, hash]) => hashPath(path) === hash);
}

function hashPath(path: string): string {
  const absolutePath = join(projectDir, path);
  if (!existsSync(absolutePath)) return "<missing>";

  if (lstatSync(absolutePath).isSymbolicLink()) {
    return createHash("sha256")
      .update(`symlink\0${readlinkSync(absolutePath)}`)
      .digest("hex");
  }

  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

function normalizeProjectPath(path: string): string {
  const normalized = isAbsolute(path) ? relative(projectDir, path) : path;
  if (normalized === ".." || normalized.startsWith("../")) {
    fail(`Path is outside the project: ${path}`);
  }
  return normalized.replaceAll("\\", "/").replace(/^\.\//, "");
}

function runCommand(command: string[]): CommandResult {
  const timeoutMs = gateCommandTimeoutMs();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: projectDir,
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
  });
  const timedOut =
    (isErrnoException(result.error) && result.error.code === "ETIMEDOUT") ||
    exitedDueToTimeout(result);
  const timeoutOutput = timedOut
    ? `\nTDD gate command timed out after ${timeoutMs} ms.\n`
    : "";
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${timeoutOutput}`;
  return { exitCode: timedOut ? 1 : (result.status ?? 1), output, timedOut };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function exitedDueToTimeout(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "exitedDueToTimeout" in result &&
    result.exitedDueToTimeout === true
  );
}

function gateCommandTimeoutMs(): number {
  const override = Number(process.env.TDD_GATE_COMMAND_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 10 * 60 * 1000;
}

function evidence(
  command: string[],
  result: { exitCode: number; output: string }
): CommandEvidence {
  return {
    command,
    exitCode: result.exitCode,
    outputHash: createHash("sha256").update(result.output).digest("hex"),
    outputExcerpt: excerpt(result.output),
    verifiedAt: new Date().toISOString(),
  };
}

function excerpt(output: string): string {
  const limit = 4000;
  return output.length <= limit ? output.trim() : output.slice(-limit).trim();
}

function optionValues(commandArgs: string[], option: string): string[] {
  const values: string[] = [];
  const separator = commandArgs.indexOf("--");
  const options = separator === -1 ? commandArgs : commandArgs.slice(0, separator);
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === option && options[index + 1]) {
      values.push(options[index + 1]);
      index += 1;
    }
  }
  return values;
}

function commandAfterSeparator(commandArgs: string[]): string[] {
  const separator = commandArgs.indexOf("--");
  return separator === -1 ? [] : commandArgs.slice(separator + 1);
}

function commandsMatch(actual: string[], expected: string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function readHookInput(): Promise<HookInput> {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    blockHook("TDD hook received invalid JSON input.");
  }
}

function readState(): GateState | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as GateState;
  } catch {
    blockHook(`TDD state is unreadable: ${statePath}`);
  }
}

function requireState(): GateState {
  const state = readState();
  if (!state) fail("No active TDD workflow. Run start first.");
  return state;
}

function writeState(state: GateState): void {
  state.updatedAt = new Date().toISOString();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function blockHook(message: string): never {
  console.error(message);
  process.exit(2);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printHelp(): void {
  console.log(`TDD gate commands:
  start --task "summary"
  status
  red --test path [--test path] --expect "test name" -- bun test path
  green -- bun test path
  verify
  resume
  abort --reason "why the workflow was cancelled"`);
}
