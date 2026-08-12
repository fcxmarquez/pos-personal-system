import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSessionEnvironment,
  classifyPath,
  decidePreToolUse,
  evaluateGreen,
  evaluateRed,
  extractPatchPaths,
  getSessionStatePath,
  isGateCommand,
} from "./tdd-gate-lib";

describe("classifyPath", () => {
  test("recognizes colocated and directory-based tests", () => {
    expect(classifyPath("lib/cart.test.ts")).toBe("test");
    expect(classifyPath("components/cart/__tests__/checkout.tsx")).toBe("test");
    expect(classifyPath("test/fixtures/cart.json")).toBe("test");
    expect(classifyPath("lib/cart.ts")).toBe("production");
  });
});

describe("extractPatchPaths", () => {
  test("extracts every file affected by a Codex apply_patch call", () => {
    const patch = `*** Begin Patch
*** Add File: lib/cart.test.ts
+test("adds an item", () => {});
*** Update File: lib/cart.ts
@@
-return [];
+return items;
*** Delete File: lib/legacy-cart.ts
*** End Patch`;

    expect(extractPatchPaths(patch)).toEqual([
      "lib/cart.test.ts",
      "lib/cart.ts",
      "lib/legacy-cart.ts",
    ]);
  });
});

describe("session scoping", () => {
  test("derives a distinct opaque state path for each Codex session", () => {
    const first = getSessionStatePath("/repo", "session-a");
    const second = getSessionStatePath("/repo", "session-b");

    expect(first).not.toBe(second);
    expect(first).toStartWith("/repo/.tdd/codex/");
    expect(first).not.toContain("session-a");
    expect(first).toEndWith(".json");
  });

  test("recognizes gate commands and injects the parent session ID", () => {
    const command = "bun .agents/skills/tdd-feature-workflow/scripts/tdd-gate.ts status";

    expect(isGateCommand(command)).toBe(true);
    expect(addSessionEnvironment(command, "session-a")).toBe(
      `TDD_CODEX_SESSION_ID='session-a' ${command}`
    );
    expect(isGateCommand("bun test lib/cart.test.ts")).toBe(false);
  });

  test("keeps active workflows isolated between concurrent parent sessions", () => {
    const firstSession = `test-first-${randomUUID()}`;
    const secondSession = `test-second-${randomUUID()}`;

    try {
      expect(runGate(firstSession, ["start", "--task", "first workflow"]).status).toBe(0);
      expect(runGate(secondSession, ["status"]).stdout).toContain(
        "No active TDD workflow."
      );
      expect(runGate(secondSession, ["start", "--task", "second workflow"]).status).toBe(
        0
      );
      expect(runGate(firstSession, ["status"]).stdout).toContain("first workflow");
      expect(runGate(secondSession, ["status"]).stdout).toContain("second workflow");
    } finally {
      runGate(firstSession, ["abort", "--reason", "test cleanup"]);
      runGate(secondSession, ["abort", "--reason", "test cleanup"]);
    }
  });
});

function runGate(sessionId: string, args: string[]) {
  return spawnSync("bun", [join(import.meta.dir, "tdd-gate.ts"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, TDD_CODEX_SESSION_ID: sessionId },
  });
}

describe("evaluateRed", () => {
  test("accepts only an expected behavioral failure with new tests and no production edits", () => {
    expect(
      evaluateRed({
        exitCode: 1,
        output: "(fail) cart rejects an expired coupon",
        expectedPattern: "cart rejects an expired coupon",
        changedTests: ["lib/cart.test.ts"],
        productionChanges: [],
      })
    ).toEqual({ allowed: true });
  });

  test("rejects a red run after production code changed", () => {
    const result = evaluateRed({
      exitCode: 1,
      output: "(fail) cart rejects an expired coupon",
      expectedPattern: "cart rejects an expired coupon",
      changedTests: ["lib/cart.test.ts"],
      productionChanges: ["lib/cart.ts"],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("production");
  });

  test("rejects infrastructure failures masquerading as red", () => {
    const result = evaluateRed({
      exitCode: 1,
      output: "Cannot find module './missing-fixture'",
      expectedPattern: "missing-fixture",
      changedTests: ["lib/cart.test.ts"],
      productionChanges: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("infrastructure");
  });
});

describe("evaluateGreen", () => {
  test("requires the unchanged red tests to pass", () => {
    expect(evaluateGreen({ exitCode: 0, testsUnchanged: true })).toEqual({
      allowed: true,
    });
    expect(evaluateGreen({ exitCode: 0, testsUnchanged: false }).allowed).toBe(false);
    expect(evaluateGreen({ exitCode: 1, testsUnchanged: true }).allowed).toBe(false);
  });
});

describe("decidePreToolUse", () => {
  test("blocks production writes until red is verified", () => {
    expect(
      decidePreToolUse({
        phase: "awaiting_red",
        role: "main",
        toolName: "apply_patch",
        filePath: "lib/cart.ts",
      }).allowed
    ).toBe(false);

    expect(
      decidePreToolUse({
        phase: "awaiting_red",
        role: "test-engineer",
        toolName: "apply_patch",
        filePath: "lib/cart.test.ts",
      })
    ).toEqual({ allowed: true });
  });

  test("keeps worker ownership separated after red", () => {
    expect(
      decidePreToolUse({
        phase: "red_verified",
        role: "test-engineer",
        toolName: "apply_patch",
        filePath: "lib/cart.ts",
      }).allowed
    ).toBe(false);

    expect(
      decidePreToolUse({
        phase: "red_verified",
        role: "feature-engineer",
        toolName: "apply_patch",
        filePath: "lib/cart.test.ts",
      }).allowed
    ).toBe(false);
  });

  test("permits test commands but blocks arbitrary shell mutation before red", () => {
    expect(
      decidePreToolUse({
        phase: "awaiting_red",
        role: "test-engineer",
        toolName: "Bash",
        command: "bun test lib/cart.test.ts",
      })
    ).toEqual({ allowed: true });

    expect(
      decidePreToolUse({
        phase: "awaiting_red",
        role: "test-engineer",
        toolName: "Bash",
        command: "cp implementation.ts lib/cart.ts",
      }).allowed
    ).toBe(false);
  });

  test("rejects compound commands and mutating find operations", () => {
    expect(
      decidePreToolUse({
        phase: "awaiting_red",
        role: "test-engineer",
        toolName: "Bash",
        command: "bun test cart; pwd",
      }).allowed
    ).toBe(false);

    expect(
      decidePreToolUse({
        phase: "awaiting_red",
        role: "test-engineer",
        toolName: "Bash",
        command: "find lib -name '*.ts' -delete",
      }).allowed
    ).toBe(false);
  });
});

describe("gate command timeout", () => {
  test("RED rejects a timed-out command even after it prints the expected marker", () => {
    const project = mkdtempSync(join(tmpdir(), "agents-tdd-gate-"));
    const sessionId = `red-timeout-${randomUUID()}`;
    try {
      expect(spawnSync("git", ["init", "-q"], { cwd: project }).status).toBe(0);
      writeFileSync(join(project, ".git", "info", "exclude"), ".tdd/\n");
      mkdirSync(join(project, "lib"), { recursive: true });
      writeFileSync(
        join(project, "lib", "timeout.test.ts"),
        "export const timeoutRegression = true;\n"
      );
      const expectedMarker = "expected behavioral RED marker";
      const delayedCommand = [
        "bun",
        "-e",
        `console.error(${JSON.stringify(expectedMarker)}); await Bun.sleep(300)`,
      ];
      const now = new Date().toISOString();
      const statePath = getSessionStatePath(project, sessionId);
      mkdirSync(join(project, ".tdd", "codex"), { recursive: true });
      writeFileSync(
        statePath,
        `${JSON.stringify(
          {
            version: 1,
            task: "RED timeout regression",
            phase: "awaiting_red",
            startedAt: now,
            updatedAt: now,
            baselineHashes: {},
            agents: {},
          },
          null,
          2
        )}\n`
      );

      const result = spawnSync(
        "bun",
        [
          gatePathForTests(),
          "red",
          "--test",
          "lib/timeout.test.ts",
          "--expect",
          expectedMarker,
          "--",
          ...delayedCommand,
        ],
        {
          cwd: project,
          encoding: "utf8",
          timeout: 2_000,
          env: {
            ...process.env,
            TDD_CODEX_SESSION_ID: sessionId,
            TDD_GATE_COMMAND_TIMEOUT_MS: "50",
          },
        }
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(output).toContain(expectedMarker);
      expect(output).toContain("TDD gate command timed out after 50 ms");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.phase).toBe("awaiting_red");
      expect(state.red).toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("times out with a short override while preserving stdout and stderr", () => {
    const project = mkdtempSync(join(tmpdir(), "agents-tdd-gate-"));
    const sessionId = `timeout-${randomUUID()}`;
    try {
      expect(spawnSync("git", ["init", "-q"], { cwd: project }).status).toBe(0);
      mkdirSync(join(project, "lib"), { recursive: true });
      const testContent = "export const timeoutRegression = true;\n";
      writeFileSync(join(project, "lib", "timeout.test.ts"), testContent);
      const delayedCommand = [
        "bun",
        "-e",
        "console.log('stdout-before-timeout'); console.error('stderr-before-timeout'); await Bun.sleep(300)",
      ];
      const now = new Date().toISOString();
      const statePath = getSessionStatePath(project, sessionId);
      mkdirSync(join(project, ".tdd", "codex"), { recursive: true });
      writeFileSync(
        statePath,
        `${JSON.stringify(
          {
            version: 1,
            task: "timeout regression",
            phase: "red_verified",
            startedAt: now,
            updatedAt: now,
            baselineHashes: {},
            agents: {},
            red: {
              command: delayedCommand,
              exitCode: 1,
              outputHash: "red-output",
              outputExcerpt: "expected RED",
              verifiedAt: now,
              expectedPattern: "expected RED",
              testFiles: ["lib/timeout.test.ts"],
              testHashes: {
                "lib/timeout.test.ts": createHash("sha256")
                  .update(testContent)
                  .digest("hex"),
              },
            },
          },
          null,
          2
        )}\n`
      );

      const result = spawnSync(
        "bun",
        [gatePathForTests(), "green", "--", ...delayedCommand],
        {
          cwd: project,
          encoding: "utf8",
          timeout: 2_000,
          env: {
            ...process.env,
            TDD_CODEX_SESSION_ID: sessionId,
            TDD_GATE_COMMAND_TIMEOUT_MS: "50",
          },
        }
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(output).toContain("stdout-before-timeout");
      expect(output).toContain("stderr-before-timeout");
      expect(output).toMatch(/timed out/i);
      expect(JSON.parse(readFileSync(statePath, "utf8")).green).toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

function gatePathForTests(): string {
  return join(import.meta.dir, "tdd-gate.ts");
}
