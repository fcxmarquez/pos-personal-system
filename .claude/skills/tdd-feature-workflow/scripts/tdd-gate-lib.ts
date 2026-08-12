export type GatePhase = "awaiting_red" | "red_verified" | "green_verified" | "complete";

export type WorkerRole = "test-engineer" | "feature-engineer" | "main";

export interface GateDecision {
  allowed: boolean;
  reason?: string;
}

export function classifyPath(path: string): "test" | "production" {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const filename = normalized.split("/").at(-1) ?? normalized;

  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
    filename.endsWith(".snap") ||
    /(^|\/)(__tests__|tests?|__fixtures__|fixtures?)(\/|$)/.test(normalized)
  ) {
    return "test";
  }

  return "production";
}

export function evaluateRed(input: {
  exitCode: number;
  output: string;
  expectedPattern: string;
  changedTests: string[];
  productionChanges: string[];
}): GateDecision {
  if (input.productionChanges.length > 0) {
    return {
      allowed: false,
      reason: `RED rejected: production files changed before the failing test was verified: ${input.productionChanges.join(", ")}`,
    };
  }

  if (input.changedTests.length === 0) {
    return {
      allowed: false,
      reason: "RED rejected: no test file changed after the workflow started.",
    };
  }

  if (input.exitCode === 0) {
    return {
      allowed: false,
      reason:
        "RED rejected: the focused test passed, so it does not prove missing behavior.",
    };
  }

  if (!input.expectedPattern || !input.output.includes(input.expectedPattern)) {
    return {
      allowed: false,
      reason:
        "RED rejected: test output did not contain the expected failing test or failure marker.",
    };
  }

  const infrastructureFailure =
    /(?:cannot find module|module not found|failed to resolve import|syntaxerror|enoent|no tests? found|filters did not match any test files)/i;

  if (infrastructureFailure.test(input.output)) {
    return {
      allowed: false,
      reason:
        "RED rejected: the command failed because of an infrastructure, import, syntax, or test-discovery error.",
    };
  }

  return { allowed: true };
}

export function evaluateGreen(input: {
  exitCode: number;
  testsUnchanged: boolean;
}): GateDecision {
  if (!input.testsUnchanged) {
    return {
      allowed: false,
      reason:
        "GREEN rejected: the tests changed after RED was verified. Re-prove RED first.",
    };
  }

  if (input.exitCode !== 0) {
    return {
      allowed: false,
      reason: "GREEN rejected: the focused test command is still failing.",
    };
  }

  return { allowed: true };
}

export function decidePreToolUse(input: {
  phase: GatePhase;
  role: WorkerRole;
  toolName: string;
  filePath?: string;
  command?: string;
}): GateDecision {
  if (input.toolName === "Write" || input.toolName === "Edit") {
    if (!input.filePath) {
      return {
        allowed: false,
        reason: `${input.toolName} rejected: the gate could not identify the target path.`,
      };
    }

    const target = classifyPath(input.filePath);

    if (input.role === "test-engineer" && target === "production") {
      return {
        allowed: false,
        reason: "The test-engineer owns tests only and cannot change production files.",
      };
    }

    if (input.role === "feature-engineer" && target === "test") {
      return {
        allowed: false,
        reason: "The feature-engineer owns production code only and cannot change tests.",
      };
    }

    if (input.phase === "awaiting_red" && target === "production") {
      return {
        allowed: false,
        reason:
          "Production edits are locked until the RED gate verifies an expected failing test.",
      };
    }

    return { allowed: true };
  }

  if (input.toolName === "Bash") {
    if (input.phase !== "awaiting_red" && input.role !== "test-engineer") {
      return { allowed: true };
    }

    if (isSafePreRedCommand(input.command ?? "")) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason:
        "Shell command blocked before RED or inside test-engineer. Use read-only inspection, Bun tests, or the tdd-gate command; use Write/Edit only for test files.",
    };
  }

  return { allowed: true };
}

function isSafePreRedCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;

  if (
    /[;&|<>`]|\$\(|[\r\n]|\b(?:tee|sed\s+-i|perl\s+-pi|cp|mv|rm|touch|mkdir)\b/.test(
      normalized
    )
  ) {
    return false;
  }

  return [
    /^(?:pwd|ls|rg|head|tail|wc|which|type)\b/,
    /^find\b(?!.*\s-(?:delete|exec|execdir|ok|okdir)\b)/,
    /^sed\s+-n\b/,
    /^cat\s+[^;&]+$/,
    /^git\s+(?:status|diff|log|show|ls-files)\b/,
    /^bun\s+(?:test|run\s+(?:test|lint|typecheck))\b/,
    /^bun\s+.*\.claude\/skills\/tdd-feature-workflow\/scripts\/tdd-gate\.ts\b/,
  ].some((pattern) => pattern.test(normalized));
}
