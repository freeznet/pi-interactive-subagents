/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn REAL pi sessions with REAL LLM calls (haiku by default).
 * Each test creates a mux surface, runs pi with a task that uses the subagent
 * tool, and verifies the outcome via marker files and screen output.
 *
 * Costs: ~$0.01-0.05 per test run (haiku).
 * Duration: ~30-90s per test.
 *
 * Run inside a supported multiplexer:
 *   cmux bash -c 'npm run test:integration'
 *   tmux new 'npm run test:integration'
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions (default: local/gpt-5.6-sol)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  untrackSurface,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  sendCommand,
  closeSurface,
  getHerdrPaneIds,
  waitForNewHerdrPane,
  waitForHerdrPaneClosed,
  TEST_MODEL,
  PI_TIMEOUT,
  SHELL_READY_DELAY_MS,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No mux backend available — skipping subagent lifecycle integration tests");
  console.log("   Run inside Herdr, cmux, tmux, zellij, or WezTerm to enable these tests.");
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 12 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    afterEach(() => {
      for (const surface of [...env.surfaces]) {
        try {
          closeSurface(surface);
        } catch {}
        untrackSurface(env, surface);
      }
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `echo-${id}`);
      await sleep(SHELL_READY_DELAY_MS);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(
        surface,
        /INTEGRATION_COMPLETE/,
        PI_TIMEOUT,
      );

      // Verify: session file was created (shown in steer result)
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

        const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
        assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");
      }
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `status-${id}`);
      await sleep(SHELL_READY_DELAY_MS);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readScreen(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE/,
        PI_TIMEOUT,
        300,
      );
      assert.match(completionScreen, /STATUS_TEST_DONE/);
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = createTrackedSurface(env, `parallel-${id}`);
      await sleep(SHELL_READY_DELAY_MS);

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
        `After both subagent results arrive, say PARALLEL_DONE_${id}.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
      await waitForScreen(surface, new RegExp(`PARALLEL_DONE_${id}`), PI_TIMEOUT, 300);
    });

    // ── Fork mode ──

    it("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `fork-${id}`);
      await sleep(SHELL_READY_DELAY_MS);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Fork-${id}"`,
        `  fork: true`,
        `  cwd: "${env.dir}"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
        `Do not set the agent parameter. Set only name, fork, cwd, model, and task.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(
        surface,
        /FORK_COMPLETE/,
        PI_TIMEOUT,
      );

      // Verify: the forked session has a parent link
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

        const entries = readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const header = entries[0];
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.parentSession, "Fork session should have parentSession field");
        // Fork sessions include parent context (model_change entries etc.)
        assert.ok(entries.length >= 2, "Fork session should have context entries beyond header");
      }
    });

    // ── caller_ping ──

    it("subagent caller_ping sends notification back to the parent", async () => {
      const id = uniqueId();

      const surface = createTrackedSurface(env, `ping-${id}`);
      await sleep(SHELL_READY_DELAY_MS);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ping"`,
        `  task: "PING_TEST_${id}"`,
        `Just call the subagent tool once. Do not do anything else before calling it.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-ping agent calls caller_ping, which steers a "needs help" message
      // back to the outer pi. Look for it on screen.
      const screen = await waitForScreen(
        surface,
        /needs help|PING|caller_ping|ping/i,
        PI_TIMEOUT,
      );

      assert.ok(
        /needs help|PING/i.test(screen),
        `Screen should show ping notification. Got:\n${screen.slice(-800)}`,
      );
    });

    // ── Agent discovery ──

    it("subagent discovers project-local test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `discovery-${id}`);
      await sleep(SHELL_READY_DELAY_MS);

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
      await waitForScreen(surface, /DISCOVERY_DONE/, PI_TIMEOUT, 300);
    });

    // ── Subagent with custom system prompt ──

    it("passes systemPrompt to subagent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `sysprompt-${id}`);
      await sleep(SHELL_READY_DELAY_MS);

      const task = [
        `Call the subagent tool with these parameters:`,
        `  name: "SysP-${id}"`,
        `  agent: "test-echo"`,
        `  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
        `  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
        `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
      assert.ok(content.includes(`SYSPROMPT_${id}`), `System prompt test marker should exist`);
      await waitForScreen(
        surface,
        /SYSPROMPT_TEST_DONE/,
        PI_TIMEOUT,
        300,
      );
    });

    if (backend === "herdr") {
      it("resumes the same session and appends a follow-up result", async () => {
        const id = uniqueId();
        const seedFile = `/tmp/pi-integ-resume-seed-${id}.txt`;
        const resumedFile = `/tmp/pi-integ-resume-done-${id}.txt`;
        const sessionPathFile = `/tmp/pi-integ-resume-session-${id}.txt`;
        for (const file of [seedFile, resumedFile, sessionPathFile]) trackTempFile(env, file);

        const surface = createTrackedSurface(env, `resume-${id}`);
        await sleep(SHELL_READY_DELAY_MS);
        const panesBeforeSeed = getHerdrPaneIds();

        const task = [
          `Call the subagent tool with these EXACT parameters:`,
          `  name: "ResumeSeed-${id}"`,
          `  agent: "test-echo"`,
          `  task: "Run this exact bash command: printf '%s' \"$PI_SUBAGENT_SESSION\" > '${sessionPathFile}'; echo 'SEED_${id}' > '${seedFile}'"`,
          `Wait for that subagent result.`,
          `Read ${sessionPathFile} to obtain the exact .jsonl session path.`,
          `Then call subagent_resume with these EXACT parameters:`,
          `  sessionPath: the exact path read from ${sessionPathFile}`,
          `  name: "ResumeFollow-${id}"`,
          `  message: "Run this bash command now: echo 'RESUMED_${id}' > '${resumedFile}'"`,
          `  autoExit: true`,
          `Do not spawn another subagent. After the resumed result arrives, say RESUME_TEST_DONE.`,
        ].join("\n");

        startPi(surface, env.dir, task);
        const seedPanePromise = waitForNewHerdrPane(panesBeforeSeed, PI_TIMEOUT);

        const sessionPath = (await waitForFile(sessionPathFile, PI_TIMEOUT, /\.jsonl/)).trim();
        assert.ok(existsSync(sessionPath), `Seed session should exist: ${sessionPath}`);
        const seedPane = await seedPanePromise;
        await waitForFile(seedFile, PI_TIMEOUT, new RegExp(`SEED_${id}`));
        await waitForHerdrPaneClosed(seedPane, PI_TIMEOUT);

        const resumedPane = await waitForNewHerdrPane(
          new Set([...panesBeforeSeed, seedPane]),
          PI_TIMEOUT,
        );
        assert.notEqual(resumedPane, seedPane, "Resume must launch in a new stable pane");

        const resumed = await waitForFile(resumedFile, PI_TIMEOUT, new RegExp(`RESUMED_${id}`));
        assert.ok(resumed.includes(`RESUMED_${id}`));
        await waitForHerdrPaneClosed(resumedPane, PI_TIMEOUT);
        await waitForScreen(
          surface,
          /RESUME_TEST_DONE/,
          PI_TIMEOUT,
          300,
        );

        const entries = readFileSync(sessionPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const userMessages = entries.filter(
          (entry) => entry.type === "message" && entry.message?.role === "user",
        );
        const assistantMessages = entries.filter(
          (entry) => entry.type === "message" && entry.message?.role === "assistant",
        );
        assert.ok(userMessages.length >= 2, "Resume must append another user turn to same session");
        assert.ok(
          assistantMessages.length >= 2,
          "Resume must append another assistant turn to same session",
        );
      });

      it("interrupts a running child by name and watcher later closes its pane", async () => {
        const id = uniqueId();
        const startFile = `/tmp/pi-integ-interrupt-start-${id}.txt`;
        const lateFile = `/tmp/pi-integ-interrupt-late-${id}.txt`;
        const sessionPathFile = `/tmp/pi-integ-interrupt-session-${id}.txt`;
        for (const file of [startFile, lateFile, sessionPathFile]) trackTempFile(env, file);

        const surface = createTrackedSurface(env, `interrupt-${id}`);
        await sleep(SHELL_READY_DELAY_MS);
        const panesBeforeChild = getHerdrPaneIds();

        const childName = `Interrupt-${id}`;
        const task = [
          `Call the subagent tool with these EXACT parameters:`,
          `  name: "${childName}"`,
          `  agent: "test-echo"`,
          `  task: "Run this exact bash command: printf '%s' \"$PI_SUBAGENT_SESSION\" > '${sessionPathFile}'; echo 'START_${id}' > '${startFile}'; sleep 120; echo 'TOO_LATE_${id}' > '${lateFile}'"`,
          `Immediately after the subagent tool returns, call test_wait_for_file with path "${startFile}".`,
          `Then call subagent_interrupt with exactly this JSON object: {"name":"${childName}"}.`,
          `Do not set the id parameter. You must target by the full display name.`,
          `After the interrupt acknowledgement, say INTERRUPT_ACK_${id}.`,
          `Do not call subagent_resume and do not spawn another subagent.`,
        ].join("\n");

        startPi(surface, env.dir, task);
        const childPanePromise = waitForNewHerdrPane(panesBeforeChild, PI_TIMEOUT);

        await waitForFile(startFile, PI_TIMEOUT, new RegExp(`START_${id}`));
        const sessionPath = (await waitForFile(sessionPathFile, PI_TIMEOUT, /\.jsonl/)).trim();
        assert.ok(existsSync(sessionPath), `Interrupted child session should exist: ${sessionPath}`);
        const childPane = await childPanePromise;

        const interruptScreen = await waitForScreen(
          surface,
          /interrupt requested|No running subagent|Failed to send Escape/i,
          PI_TIMEOUT,
          300,
        );
        assert.match(interruptScreen, /interrupt requested/i);

        await sleep(1500);
        sendCommand(
          childPane,
          `Reply exactly INTERRUPT_CLEANUP_DONE_${id}. Do not call tools.`,
        );

        await waitForHerdrPaneClosed(childPane, PI_TIMEOUT);
        assert.equal(existsSync(lateFile), false, "Interrupted tool must not finish its delayed command");
      });
    }
  });
}
