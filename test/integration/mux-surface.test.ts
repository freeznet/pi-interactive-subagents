/**
 * Integration tests for the multiplexer surface layer.
 *
 * These tests exercise real mux operations: creating panes,
 * sending commands, reading screen output, and closing surfaces.
 * No LLM calls — fast and free.
 *
 * Run inside a supported multiplexer:
 *   cmux bash -c 'npm run test:integration'
 *   tmux new 'npm run test:integration'
 *   zellij --session pi  # then run: npm run test:integration
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  focusSurface,
  getFocusedSurface,
  getSurfacePane,
  supportsAbsoluteSurfaceFocus,
  waitForFocusedSurface,
  createHerdrTab,
  focusHerdrTab,
  closeHerdrTab,
  getHerdrSnapshot,
  getHerdrPaneInfo,
  getHerdrPaneLayout,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sendEscape,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  SHELL_READY_DELAY_MS,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No mux backend available — skipping mux-surface integration tests");
  console.log("   Run inside Herdr, cmux, tmux, zellij, or WezTerm to enable these tests.");
}

for (const backend of backends) {
  describe(`mux-surface [${backend}]`, { timeout: 60_000 }, () => {
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

    it("keeps focus on the active surface while creating and targeting subagent surfaces", async (t) => {
      if (!supportsAbsoluteSurfaceFocus(backend)) {
        t.skip(`${backend} has no absolute pane-focus helper; backend-specific placement tests cover it`);
        return;
      }

      const anchor = createTrackedSurfaceSplit(env, "focus-anchor", "right");
      await sleep(SHELL_READY_DELAY_MS);

      focusSurface(backend, anchor);
      await waitForFocusedSurface(backend, anchor, 10_000);

      const childA = createTrackedSurface(env, "focus-child-a");
      await sleep(SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(backend), anchor);

      const childB = createTrackedSurface(env, "focus-child-b");
      await sleep(SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(backend), anchor);

      if (backend === "cmux") {
        const paneA = getSurfacePane(backend, childA);
        const paneB = getSurfacePane(backend, childB);
        assert.ok(paneA, `Expected pane ref for ${childA}`);
        assert.ok(paneB, `Expected pane ref for ${childB}`);
        assert.equal(paneB, paneA);
      }

      const markerA = uniqueId();
      const markerB = uniqueId();
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(backend), anchor);
    });

    if (backend === "herdr") {
      it("uses the captured caller pane even when global focus switches tabs", async () => {
        const callerPaneId = process.env.HERDR_PANE_ID;
        const callerTabId = process.env.HERDR_TAB_ID;
        const callerWorkspaceId = process.env.HERDR_WORKSPACE_ID;
        assert.ok(callerPaneId, "HERDR_PANE_ID must identify the caller pane");
        assert.ok(callerTabId, "HERDR_TAB_ID must identify the caller tab");
        assert.ok(callerWorkspaceId, "HERDR_WORKSPACE_ID must identify the caller workspace");

        const originalFocus = getHerdrSnapshot();
        let disposableTabId: string | null = null;
        let child: string | null = null;

        try {
          const disposable = createHerdrTab({
            workspaceId: callerWorkspaceId,
            cwd: env.dir,
            label: `focus-race-${uniqueId()}`,
          });
          disposableTabId = disposable.tabId;
          focusHerdrTab(disposable.tabId);
          await sleep(250);

          const focusedBeforeCreate = getHerdrSnapshot();
          assert.equal(focusedBeforeCreate.focused_tab_id, disposable.tabId);
          assert.equal(focusedBeforeCreate.focused_pane_id, disposable.rootPaneId);

          child = createTrackedSurface(env, "herdr-focus-race-child");
          await sleep(SHELL_READY_DELAY_MS);
          const childInfo = getHerdrPaneInfo(child);
          assert.ok(childInfo, `Expected Herdr pane info for ${child}`);
          assert.equal(childInfo.workspace_id, callerWorkspaceId);
          assert.equal(childInfo.tab_id, callerTabId);
          assert.equal(childInfo.focused, false);

          const focusedAfterCreate = getHerdrSnapshot();
          assert.equal(focusedAfterCreate.focused_tab_id, disposable.tabId);
          assert.equal(focusedAfterCreate.focused_pane_id, disposable.rootPaneId);

          const marker = uniqueId();
          sendCommand(child, `echo "HERDR_FOCUS_${marker}"`);
          await waitForScreen(child, new RegExp(`HERDR_FOCUS_${marker}`), 20_000, 50);
        } finally {
          if (originalFocus.focused_tab_id) {
            try {
              focusHerdrTab(originalFocus.focused_tab_id);
            } catch {}
          }
          if (child) {
            try {
              closeSurface(child);
            } catch {}
            untrackSurface(env, child);
          }
          if (disposableTabId) {
            try {
              closeHerdrTab(disposableTabId);
            } catch {}
          }
        }
      });

      it("treats closing an already closed Herdr pane as success", () => {
        const surface = createTrackedSurface(env, "herdr-double-close");
        closeSurface(surface);
        closeSurface(surface);
        untrackSurface(env, surface);
        assert.equal(getHerdrPaneInfo(surface), null);
      });

      it("keeps the caller pane size stable after the first of four child placements", async () => {
        const callerPaneId = process.env.HERDR_PANE_ID;
        assert.ok(callerPaneId, "HERDR_PANE_ID must identify the caller pane");

        const children: string[] = [];
        try {
          children.push(createTrackedSurface(env, "herdr-placement-1"));
          await sleep(250);
          const afterFirst = getHerdrPaneLayout(callerPaneId);
          const callerAfterFirst = afterFirst.panes.find((pane) => pane.paneId === callerPaneId);
          assert.ok(callerAfterFirst, "caller pane must remain in its original tab after first child");

          for (let i = 2; i <= 4; i++) {
            children.push(createTrackedSurface(env, `herdr-placement-${i}`));
          }
          await sleep(250);

          const afterAll = getHerdrPaneLayout(callerPaneId);
          const callerAfterAll = afterAll.panes.find((pane) => pane.paneId === callerPaneId);
          assert.ok(callerAfterAll, "caller pane must remain available after four children");
          assert.deepEqual(callerAfterAll.rect, callerAfterFirst.rect);
          assert.ok(callerAfterAll.rect.width >= 40, `caller width ${callerAfterAll.rect.width} < 40`);
          assert.ok(callerAfterAll.rect.height >= 10, `caller height ${callerAfterAll.rect.height} < 10`);

          for (const child of children) {
            assert.ok(getHerdrPaneInfo(child), `expected child pane ${child} to remain available`);
          }
        } finally {
          for (const child of children) {
            try {
              closeSurface(child);
            } catch {}
            untrackSurface(env, child);
          }
        }
      });

      it("opens a no-focus tab when configured minimums make every split unsafe", async () => {
        const callerPaneId = process.env.HERDR_PANE_ID;
        assert.ok(callerPaneId, "HERDR_PANE_ID must identify the caller pane");

        const previousMinColumns = process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS;
        const before = getHerdrPaneLayout(callerPaneId);
        const callerBefore = before.panes.find((pane) => pane.paneId === callerPaneId);
        assert.ok(callerBefore, "caller pane must exist before fallback placement");
        let child: string | null = null;

        try {
          process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS = "9999";
          child = createTrackedSurface(env, "herdr-tab-fallback");
          const childInfo = getHerdrPaneInfo(child);
          assert.ok(childInfo, "fallback child pane must exist");
          assert.notEqual(childInfo.tab_id, before.tabId);
          assert.equal(childInfo.focused, false);

          const marker = uniqueId();
          sendCommand(child, `echo "HERDR_TAB_FALLBACK_${marker}"`);
          await waitForScreen(child, new RegExp(`HERDR_TAB_FALLBACK_${marker}`), 20_000, 50);

          const after = getHerdrPaneLayout(callerPaneId);
          const callerAfter = after.panes.find((pane) => pane.paneId === callerPaneId);
          assert.ok(callerAfter, "caller pane must remain after fallback placement");
          assert.deepEqual(callerAfter.rect, callerBefore.rect);
        } finally {
          if (previousMinColumns === undefined) {
            delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS;
          } else {
            process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS = previousMinColumns;
          }
          if (child) {
            try {
              closeSurface(child);
            } catch {}
            untrackSurface(env, child);
          }
        }
      });
    }

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        screen.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;

      sendLongCommand(surface, command);
      const screen = await waitForScreen(surface, new RegExp(`LONG_${marker}.*_END`, "s"), 20_000, 100);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      assert.notEqual(s1, s2, "Concurrent surface creation must return unique stable IDs");
      await sleep(SHELL_READY_DELAY_MS);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      const filePath = `/tmp/pi-mux-test-${marker}.txt`;

      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });

    it("delivers Escape as byte 27 to the target surface", async () => {
      const surface = createTrackedSurface(env, "escape-byte-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      const byteFile = `/tmp/pi-mux-escape-${marker}.txt`;
      trackTempFile(env, byteFile);

      const nodeProgram =
        "const fs = require('node:fs');" +
        "if (!process.stdin.isTTY) throw new Error('stdin is not a TTY');" +
        "process.stdin.setRawMode(true);" +
        "process.stdin.resume();" +
        "process.stdout.write('ESC_READY\\n');" +
        "process.stdin.once('data', (chunk) => {" +
        `fs.writeFileSync(${JSON.stringify(byteFile)}, Array.from(chunk).join(','));` +
        "process.exit(0);" +
        "});";
      const command = `node -e ${JSON.stringify(nodeProgram)}`;

      sendLongCommand(surface, command);
      await waitForScreen(surface, /ESC_READY/, 15_000, 50);

      sendEscape(surface);

      const content = await waitForFile(byteFile, 15_000, /^27$/);
      assert.equal(content.trim(), "27");
    });
  });
}
