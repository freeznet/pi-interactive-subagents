import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERDR_CLI_OPTIONS = {
  encoding: "utf8" as const,
  timeout: 5_000,
  maxBuffer: 4 * 1024 * 1024,
};

const HERDR_SYNC_CLI_OPTIONS = {
  ...HERDR_CLI_OPTIONS,
  stdio: ["ignore", "pipe", "pipe"] as const,
};

export type HerdrSplitDirection = "right" | "down";
type MuxSplitDirection = "left" | "right" | "up" | "down";
type HerdrReadSource = "recent-unwrapped" | "visible";
type HerdrSyncRunner = (args: string[]) => string;
type HerdrAsyncRunner = (args: string[]) => Promise<string>;

export interface HerdrPaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HerdrPaneLayout {
  workspaceId: string;
  tabId: string;
  panes: Array<{
    paneId: string;
    rect: HerdrPaneRect;
  }>;
}

export interface HerdrSplitPlacement {
  parentPaneId: string;
  direction: HerdrSplitDirection;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function outputText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function parseHerdrErrorOutput(value: unknown): { code?: string; message?: string } | null {
  const text = outputText(value)?.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as {
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    const envelope = parsed.error ?? parsed;
    const result = {
      ...(nonEmptyString(envelope.code) ? { code: envelope.code } : {}),
      ...(nonEmptyString(envelope.message) ? { message: envelope.message } : {}),
    };
    return result.code || result.message ? result : null;
  } catch {
    return null;
  }
}

function errorOutput(error: unknown): { code?: string; message?: string } | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { stderr?: unknown; stdout?: unknown };
  return parseHerdrErrorOutput(record.stderr) ?? parseHerdrErrorOutput(record.stdout);
}

export function herdrErrorCode(error: unknown): string | null {
  const parsed = errorOutput(error)?.code;
  if (parsed) return parsed;
  if (error && typeof error === "object" && nonEmptyString((error as { code?: unknown }).code)) {
    return (error as { code: string }).code;
  }
  return null;
}

function herdrOperationError(operation: string, target: string | null, error: unknown): Error {
  const parsed = errorOutput(error);
  const systemCode =
    error && typeof error === "object" && nonEmptyString((error as { code?: unknown }).code)
      ? (error as { code: string }).code
      : null;
  const detail = parsed?.message ?? parsed?.code ?? systemCode ?? "unknown CLI error";
  const targetText = target ? ` for pane ${target}` : "";
  const wrapped = new Error(`Herdr ${operation} failed${targetText}: ${detail}`) as Error & {
    code?: string;
  };
  const code = parsed?.code ?? systemCode;
  if (code) wrapped.code = code;
  return wrapped;
}

function runHerdrSync(args: string[], operation: string, target: string | null): string {
  try {
    return execFileSync("herdr", args, HERDR_SYNC_CLI_OPTIONS);
  } catch (error) {
    throw herdrOperationError(operation, target, error);
  }
}

export function buildHerdrSplitArgs(input: {
  parentPaneId: string;
  direction: MuxSplitDirection;
  cwd: string;
}): string[] {
  if (!nonEmptyString(input.parentPaneId)) {
    throw new Error("Herdr split requires an explicit parent pane ID");
  }
  if (input.direction === "left" || input.direction === "up") {
    throw new Error(
      `Herdr 0.7.3 cannot create ${input.direction} splits without changing focus; use right or down`,
    );
  }
  if (!nonEmptyString(input.cwd)) {
    throw new Error("Herdr split requires a working directory");
  }

  return [
    "pane",
    "split",
    input.parentPaneId,
    "--direction",
    input.direction,
    "--cwd",
    input.cwd,
    "--no-focus",
  ];
}

export function parseHerdrPaneId(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Unexpected Herdr pane split output: invalid JSON");
  }

  const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane?.pane_id;
  if (!nonEmptyString(paneId)) {
    throw new Error("Unexpected Herdr pane split output: missing result.pane.pane_id");
  }
  return paneId;
}

export function buildHerdrTabCreateArgs(input: {
  workspaceId: string;
  cwd: string;
  label: string;
}): string[] {
  if (!nonEmptyString(input.workspaceId)) {
    throw new Error("Herdr tab creation requires an explicit workspace ID");
  }
  if (!nonEmptyString(input.cwd)) {
    throw new Error("Herdr tab creation requires a working directory");
  }
  if (!nonEmptyString(input.label)) {
    throw new Error("Herdr tab creation requires a label");
  }

  return [
    "tab",
    "create",
    "--workspace",
    input.workspaceId,
    "--cwd",
    input.cwd,
    "--label",
    input.label,
    "--no-focus",
  ];
}

export function parseHerdrTabSurface(output: string): { tabId: string; rootPaneId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Unexpected Herdr tab create output: invalid JSON");
  }

  const result = (parsed as {
    result?: { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown } };
  })?.result;
  const tabId = result?.tab?.tab_id;
  const rootPaneId = result?.root_pane?.pane_id;
  if (!nonEmptyString(tabId) || !nonEmptyString(rootPaneId)) {
    throw new Error("Unexpected Herdr tab create output: missing tab/root pane identity");
  }
  return { tabId, rootPaneId };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseHerdrPaneRect(value: unknown): HerdrPaneRect | null {
  if (!value || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  if (
    !finiteNumber(rect.x) ||
    !finiteNumber(rect.y) ||
    !finiteNumber(rect.width) ||
    !finiteNumber(rect.height)
  ) {
    return null;
  }
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export function parseHerdrPaneLayout(output: string): HerdrPaneLayout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Unexpected Herdr pane layout output: invalid JSON");
  }

  const layout = (parsed as { result?: { layout?: Record<string, unknown> } })?.result?.layout;
  const workspaceId = layout?.workspace_id;
  const tabId = layout?.tab_id;
  const rawPanes = layout?.panes;
  if (!nonEmptyString(workspaceId) || !nonEmptyString(tabId) || !Array.isArray(rawPanes)) {
    throw new Error("Unexpected Herdr pane layout output: missing layout identity or panes");
  }

  const panes = rawPanes.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Unexpected Herdr pane layout output: malformed pane entry");
    }
    const pane = value as Record<string, unknown>;
    const paneId = pane.pane_id;
    const rect = parseHerdrPaneRect(pane.rect);
    if (!nonEmptyString(paneId) || !rect) {
      throw new Error("Unexpected Herdr pane layout output: malformed pane identity or rect");
    }
    return { paneId, rect };
  });

  return { workspaceId, tabId, panes };
}

function normalizedMinimum(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function canSplitHerdrRect(
  rect: HerdrPaneRect,
  direction: HerdrSplitDirection,
  minColumns: number,
  minRows: number,
): boolean {
  const columns = Math.max(0, Math.trunc(rect.width));
  const rows = Math.max(0, Math.trunc(rect.height));
  if (direction === "right") {
    return rows >= minRows && Math.floor(columns / 2) >= minColumns;
  }
  return columns >= minColumns && Math.floor(rows / 2) >= minRows;
}

export function chooseHerdrSplitDirection(
  rect: HerdrPaneRect,
  minColumns: number,
  minRows: number,
  preferredDirection?: HerdrSplitDirection,
): HerdrSplitDirection | null {
  const columns = normalizedMinimum(minColumns);
  const rows = normalizedMinimum(minRows);
  const canRight = canSplitHerdrRect(rect, "right", columns, rows);
  const canDown = canSplitHerdrRect(rect, "down", columns, rows);

  if (preferredDirection === "right" && canRight) return "right";
  if (preferredDirection === "down" && canDown) return "down";
  if (canRight && !canDown) return "right";
  if (canDown && !canRight) return "down";
  if (!canRight && !canDown) return null;

  // Terminal cells are taller than wide. Keep resulting panes near a 4:1
  // column/row ratio when both split directions satisfy the minimums.
  const rightRatio = (rect.width / 2) / rect.height;
  const downRatio = rect.width / (rect.height / 2);
  return Math.abs(rightRatio - 4) <= Math.abs(downRatio - 4) ? "right" : "down";
}

export function selectHerdrSplitPlacement(
  layout: HerdrPaneLayout,
  candidatePaneIds: Iterable<string>,
  minColumns: number,
  minRows: number,
  preferredDirection?: HerdrSplitDirection,
): HerdrSplitPlacement | null {
  const candidates = new Set(candidatePaneIds);
  const panes = layout.panes
    .filter((pane) => candidates.has(pane.paneId))
    .sort((a, b) => {
      const areaDiff = b.rect.width * b.rect.height - a.rect.width * a.rect.height;
      return areaDiff !== 0 ? areaDiff : a.paneId.localeCompare(b.paneId);
    });

  for (const pane of panes) {
    const direction = chooseHerdrSplitDirection(
      pane.rect,
      minColumns,
      minRows,
      preferredDirection,
    );
    if (direction) return { parentPaneId: pane.paneId, direction };
  }
  return null;
}

export function createHerdrSurface(input: {
  name: string;
  parentPaneId: string;
  direction: MuxSplitDirection;
  cwd: string;
}): string {
  const args = buildHerdrSplitArgs(input);
  const output = runHerdrSync(args, "pane split", input.parentPaneId);
  const paneId = parseHerdrPaneId(output);

  try {
    renameHerdrPane(paneId, input.name);
  } catch {
    // Cosmetic only. Split success remains valid when rename fails.
  }

  return paneId;
}

export function createHerdrTabSurface(input: {
  name: string;
  workspaceId: string;
  cwd: string;
}): string {
  const output = runHerdrSync(
    buildHerdrTabCreateArgs({
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      label: input.name,
    }),
    "tab create",
    null,
  );
  const { rootPaneId } = parseHerdrTabSurface(output);
  try {
    renameHerdrPane(rootPaneId, input.name);
  } catch {
    // Cosmetic only. Tab creation remains valid when pane rename fails.
  }
  return rootPaneId;
}

export function readHerdrPaneLayout(paneId: string): HerdrPaneLayout {
  const output = runHerdrSync(["pane", "layout", "--pane", paneId], "pane layout", paneId);
  return parseHerdrPaneLayout(output);
}

export function renameHerdrPane(paneId: string, title: string): void {
  runHerdrSync(["pane", "rename", paneId, title], "pane rename", paneId);
}

export function sendHerdrCommand(paneId: string, command: string): void {
  runHerdrSync(["pane", "send-text", paneId, command], "pane send-text", paneId);
  runHerdrSync(["pane", "send-keys", paneId, "Enter"], "pane send-keys Enter", paneId);
}

export function sendHerdrEscape(paneId: string): void {
  runHerdrSync(["pane", "send-keys", paneId, "Escape"], "pane send-keys Escape", paneId);
}

function normalizedLineCount(lines: number): number {
  return Number.isFinite(lines) ? Math.max(1, Math.trunc(lines)) : 1;
}

export function buildHerdrReadArgs(
  paneId: string,
  lines: number,
  source: HerdrReadSource,
): string[] {
  const args = ["pane", "read", paneId, "--source", source];
  if (source === "recent-unwrapped") {
    args.push("--lines", String(normalizedLineCount(lines)));
  }
  args.push("--format", "text");
  return args;
}

export function normalizeHerdrScreen(output: string, lines: number): string {
  const count = normalizedLineCount(lines);
  const hasTrailingNewline = output.endsWith("\n");
  const body = hasTrailingNewline ? output.slice(0, -1) : output;
  const split = body.split("\n");
  if (split.length <= count) return output;
  const tail = split.slice(-count).join("\n");
  return hasTrailingNewline ? `${tail}\n` : tail;
}

function normalizeSearchableScreen(output: string, lines: number): string {
  const normalized = normalizeHerdrScreen(output, lines);
  const unwrappedSearchCopy = normalized.replace(/\n/g, "");
  return unwrappedSearchCopy === normalized
    ? normalized
    : `${normalized}\n${unwrappedSearchCopy}`;
}

function readHerdrScreenWithRunner(
  paneId: string,
  lines: number,
  runner: HerdrSyncRunner,
): string {
  let output: string;
  try {
    output = runner(buildHerdrReadArgs(paneId, lines, "recent-unwrapped"));
    // Herdr may return only the prompt for a bounded recent read even though
    // useful output remains visible. Treat a one-line read as incomplete.
    if (output.trim().length === 0 || output.trim().split("\n").length === 1) {
      output = runner(buildHerdrReadArgs(paneId, lines, "visible"));
    }
  } catch (error) {
    throw herdrOperationError("pane read", paneId, error);
  }
  return normalizeSearchableScreen(output, lines);
}

async function readHerdrScreenAsyncWithRunner(
  paneId: string,
  lines: number,
  runner: HerdrAsyncRunner,
): Promise<string> {
  let output: string;
  try {
    output = await runner(buildHerdrReadArgs(paneId, lines, "recent-unwrapped"));
    // Keep async behavior identical to the synchronous watcher fallback.
    if (output.trim().length === 0 || output.trim().split("\n").length === 1) {
      output = await runner(buildHerdrReadArgs(paneId, lines, "visible"));
    }
  } catch (error) {
    throw herdrOperationError("pane read", paneId, error);
  }
  return normalizeSearchableScreen(output, lines);
}

export function readHerdrScreen(paneId: string, lines: number): string {
  return readHerdrScreenWithRunner(paneId, lines, (args) =>
    execFileSync("herdr", args, HERDR_SYNC_CLI_OPTIONS),
  );
}

export function readHerdrScreenAsync(paneId: string, lines: number): Promise<string> {
  return readHerdrScreenAsyncWithRunner(paneId, lines, async (args) => {
    const { stdout } = await execFileAsync("herdr", args, HERDR_CLI_OPTIONS);
    return stdout;
  });
}

function closeHerdrSurfaceWithRunner(paneId: string, runner: HerdrSyncRunner): void {
  try {
    runner(["pane", "close", paneId]);
  } catch (error) {
    if (herdrErrorCode(error) === "pane_not_found") return;
    throw herdrOperationError("pane close", paneId, error);
  }
}

export function closeHerdrSurface(paneId: string): void {
  closeHerdrSurfaceWithRunner(paneId, (args) =>
    execFileSync("herdr", args, HERDR_SYNC_CLI_OPTIONS),
  );
}

export const __herdrTest__ = {
  closeHerdrSurfaceWithRunner,
  readHerdrScreenWithRunner,
  readHerdrScreenAsyncWithRunner,
};
