import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPath,
  decidePreToolUse,
  evaluateGreen,
  evaluateRed,
} from "./tdd-gate-lib";

describe("classifyPath", () => {
  test("recognizes colocated and directory-based tests", () => {
    expect(classifyPath("lib/cart.test.ts")).toBe("test");
    expect(classifyPath("components/cart/__tests__/checkout.tsx")).toBe("test");
    expect(classifyPath("test/fixtures/cart.json")).toBe("test");
    expect(classifyPath("lib/cart.ts")).toBe("production");
  });
});

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
        toolName: "Write",
        filePath: "lib/cart.ts",
      }).allowed
    ).toBe(false);

    expect(
      decidePreToolUse({
        phase: "awaiting_red",
        role: "test-engineer",
        toolName: "Edit",
        filePath: "lib/cart.test.ts",
      })
    ).toEqual({ allowed: true });
  });

  test("keeps worker ownership separated after red", () => {
    expect(
      decidePreToolUse({
        phase: "red_verified",
        role: "test-engineer",
        toolName: "Edit",
        filePath: "lib/cart.ts",
      }).allowed
    ).toBe(false);

    expect(
      decidePreToolUse({
        phase: "red_verified",
        role: "feature-engineer",
        toolName: "Edit",
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

  test("rejects shell composition, substitution, newlines, and destructive find actions", () => {
    const unsafeCommands = [
      "bun test lib/cart.test.ts; pwd",
      "bun test lib/cart.test.ts && pwd",
      "bun test lib/cart.test.ts || pwd",
      "rg cart $(pwd)",
      "rg cart `pwd`",
      "bun test lib/cart.test.ts\npwd",
      "find lib -name '*.ts' -delete",
      "find lib -exec rm {} +",
      "find lib -execdir rm {} +",
      "find lib -ok rm {} +",
      "find lib -okdir rm {} +",
    ];

    for (const command of unsafeCommands) {
      expect(
        decidePreToolUse({
          phase: "awaiting_red",
          role: "test-engineer",
          toolName: "Bash",
          command,
        }).allowed,
        command
      ).toBe(false);
    }

    for (const command of [
      "pwd",
      "rg -n cart lib",
      "find lib -name '*.test.ts' -print",
      "git diff -- lib/cart.ts",
      "bun test lib/cart.test.ts",
    ]) {
      expect(
        decidePreToolUse({
          phase: "awaiting_red",
          role: "test-engineer",
          toolName: "Bash",
          command,
        }).allowed,
        command
      ).toBe(true);
    }
  });
});

const gatePath = join(import.meta.dir, "tdd-gate.ts");

function createProject(): string {
  const project = mkdtempSync(join(tmpdir(), "claude-tdd-gate-"));
  expect(spawnSync("git", ["init", "-q"], { cwd: project }).status).toBe(0);
  expect(
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
    }).status
  ).toBe(0);
  expect(
    spawnSync("git", ["config", "user.name", "TDD Gate Test"], { cwd: project }).status
  ).toBe(0);
  return project;
}

function runGate(project: string, args: string[], input?: Record<string, unknown>) {
  return spawnSync("bun", [gatePath, ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    input: input ? JSON.stringify(input) : undefined,
  });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeState(project: string, state: Record<string, unknown>): string {
  const statePath = join(project, ".claude", "tdd-state.json");
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

function baseState(phase: "awaiting_red" | "red_verified") {
  const now = new Date().toISOString();
  return {
    version: 1,
    task: "gate regression",
    phase,
    startedAt: now,
    updatedAt: now,
    baselineHashes: {},
    agents: {},
  };
}

describe("Claude gate CLI regressions", () => {
  test("RED rejects a timed-out command even after it prints the expected marker", () => {
    const project = createProject();
    try {
      writeFileSync(join(project, ".git", "info", "exclude"), ".claude/\n");
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
      const statePath = writeState(project, baseState("awaiting_red"));

      const result = spawnSync(
        "bun",
        [
          gatePath,
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
            CLAUDE_PROJECT_DIR: project,
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

  test("Claude gate command timeout uses a short override and preserves failure evidence", () => {
    const project = createProject();
    try {
      mkdirSync(join(project, "lib"), { recursive: true });
      const testContent = "export const timeoutRegression = true;\n";
      writeFileSync(join(project, "lib", "timeout.test.ts"), testContent);
      const delayedCommand = [
        "bun",
        "-e",
        "console.log('stdout-before-timeout'); console.error('stderr-before-timeout'); await Bun.sleep(300)",
      ];
      const statePath = writeState(project, {
        ...baseState("red_verified"),
        red: {
          command: delayedCommand,
          exitCode: 1,
          outputHash: "red-output",
          outputExcerpt: "expected RED",
          verifiedAt: new Date().toISOString(),
          expectedPattern: "expected RED",
          testFiles: ["lib/timeout.test.ts"],
          testHashes: { "lib/timeout.test.ts": sha256(testContent) },
        },
      });

      const result = spawnSync("bun", [gatePath, "green", "--", ...delayedCommand], {
        cwd: project,
        encoding: "utf8",
        timeout: 2_000,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          TDD_GATE_COMMAND_TIMEOUT_MS: "50",
        },
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(output).toContain("stdout-before-timeout");
      expect(output).toContain("stderr-before-timeout");
      expect(output).toContain("TDD gate command timed out after 50 ms");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.phase).toBe("red_verified");
      expect(state.green).toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("GREEN rejects a different command before execution and accepts the exact RED command", () => {
    const project = createProject();
    try {
      mkdirSync(join(project, "lib"), { recursive: true });
      const testContent = "export const regression = true;\n";
      writeFileSync(join(project, "lib", "cart.test.ts"), testContent);
      const exactCommand = ["bun", "-e", "console.log('exact focused RED command ran')"];
      const markerPath = join(project, "different-command-ran.txt");
      const statePath = writeState(project, {
        ...baseState("red_verified"),
        red: {
          command: exactCommand,
          exitCode: 1,
          outputHash: "red-output",
          outputExcerpt: "expected RED",
          verifiedAt: new Date().toISOString(),
          expectedPattern: "expected RED",
          testFiles: ["lib/cart.test.ts"],
          testHashes: { "lib/cart.test.ts": sha256(testContent) },
        },
      });

      const rejected = runGate(project, [
        "green",
        "--",
        "bun",
        "-e",
        `await Bun.write(${JSON.stringify(markerPath)}, "ran")`,
      ]);
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}${rejected.stderr}`).toContain(
        "exact focused RED command"
      );
      const rejectedState = JSON.parse(readFileSync(statePath, "utf8"));
      expect(rejectedState.green).toBeUndefined();
      expect(existsSync(markerPath)).toBe(false);

      const accepted = runGate(project, ["green", "--", ...exactCommand]);
      expect(accepted.status).toBe(0);
      expect(`${accepted.stdout}${accepted.stderr}`).toContain("GREEN verified");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("post-tool blocks dirty production files for awaiting RED and test-engineer roles", () => {
    for (const scenario of [
      { phase: "awaiting_red" as const, agents: {}, agentId: "main-agent" },
      {
        phase: "red_verified" as const,
        agents: { "test-engineer": "test-agent" },
        agentId: "test-agent",
      },
    ]) {
      const project = createProject();
      try {
        mkdirSync(join(project, "lib"), { recursive: true });
        writeState(project, {
          ...baseState(scenario.phase),
          agents: scenario.agents,
        });
        writeFileSync(join(project, "lib", "cart.ts"), "export const dirty = true;\n");

        const result = runGate(project, ["hook-post-tool"], {
          hook_event_name: "PostToolUse",
          agent_id: scenario.agentId,
          tool_name: "Bash",
          tool_input: { command: "bun test lib/cart.test.ts" },
        });

        expect(result.status, scenario.phase).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`, scenario.phase).toContain(
          "Production changes are not allowed"
        );
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    }
  });

  test("post-tool invalidates RED when a test drifts after a Bash-shaped hook", () => {
    const project = createProject();
    try {
      mkdirSync(join(project, "lib"), { recursive: true });
      const original = "export const version = 1;\n";
      writeFileSync(join(project, "lib", "cart.test.ts"), original);
      const statePath = writeState(project, {
        ...baseState("red_verified"),
        red: {
          command: ["bun", "test", "lib/cart.test.ts"],
          exitCode: 1,
          outputHash: "red-output",
          outputExcerpt: "expected RED",
          verifiedAt: new Date().toISOString(),
          expectedPattern: "expected RED",
          testFiles: ["lib/cart.test.ts"],
          testHashes: { "lib/cart.test.ts": sha256(original) },
        },
      });
      writeFileSync(join(project, "lib", "cart.test.ts"), "export const version = 2;\n");

      const result = runGate(project, ["hook-post-tool"], {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "bun run format" },
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Test files changed after RED"
      );
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.phase).toBe("awaiting_red");
      expect(state.red).toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("workflow start hashes directory symlinks safely and preserves regular file SHA", () => {
    const project = createProject();
    try {
      mkdirSync(join(project, "target"), { recursive: true });
      writeFileSync(join(project, "target", "nested.txt"), "nested\n");
      symlinkSync("target", join(project, "directory-link"));
      const regularContent = `regular-${randomUUID()}\n`;
      writeFileSync(join(project, "regular.test.ts"), regularContent);

      const result = runGate(project, ["start", "--task", "hash paths safely"]);

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("Phase: awaiting_red");
      const state = JSON.parse(
        readFileSync(join(project, ".claude", "tdd-state.json"), "utf8")
      );
      expect(state.baselineHashes["directory-link"]).toMatch(/^[a-f0-9]{64}$/);
      expect(state.baselineHashes["regular.test.ts"]).toBe(sha256(regularContent));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
