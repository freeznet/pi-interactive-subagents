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
  return errorOutput(error)?.code ?? null;
}

function herdrOperationError(operation: string, target: string | null, error: unknown): Error {
  const parsed = errorOutput(error);
  const systemCode =
    error && typeof error === "object" && nonEmptyString((error as { code?: unknown }).code)
      ? (error as { code: string }).code
      : null;
  const detail = parsed?.message ?? parsed?.code ?? systemCode ?? "unknown CLI error";
  const targetText = target ? ` for pane ${target}` : "";
  return new Error(`Herdr ${operation} failed${targetText}: ${detail}`);
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

function normalizeVisibleFallback(output: string, lines: number): string {
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
  let usedVisibleFallback = false;
  try {
    output = runner(buildHerdrReadArgs(paneId, lines, "recent-unwrapped"));
    // Herdr may return only the prompt for a bounded recent read even though
    // useful output remains visible. Treat a one-line read as incomplete.
    if (output.trim().length === 0 || output.trim().split("\n").length === 1) {
      output = runner(buildHerdrReadArgs(paneId, lines, "visible"));
      usedVisibleFallback = true;
    }
  } catch (error) {
    throw herdrOperationError("pane read", paneId, error);
  }
  return usedVisibleFallback
    ? normalizeVisibleFallback(output, lines)
    : normalizeHerdrScreen(output, lines);
}

async function readHerdrScreenAsyncWithRunner(
  paneId: string,
  lines: number,
  runner: HerdrAsyncRunner,
): Promise<string> {
  let output: string;
  let usedVisibleFallback = false;
  try {
    output = await runner(buildHerdrReadArgs(paneId, lines, "recent-unwrapped"));
    // Keep async behavior identical to the synchronous watcher fallback.
    if (output.trim().length === 0 || output.trim().split("\n").length === 1) {
      output = await runner(buildHerdrReadArgs(paneId, lines, "visible"));
      usedVisibleFallback = true;
    }
  } catch (error) {
    throw herdrOperationError("pane read", paneId, error);
  }
  return usedVisibleFallback
    ? normalizeVisibleFallback(output, lines)
    : normalizeHerdrScreen(output, lines);
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
