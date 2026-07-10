---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to "run integration tests", "run e2e tests", "test before release", "verify integration", "run the full test suite", "check everything works".
---

# Run Integration Tests

Run unit, real mux-surface, and real Pi lifecycle tests from the current checkout. Keep integration execution serial.

## Step 1: Repository and mux preflight

```bash
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

node --version
printf 'PI_SUBAGENT_MUX=%s\n' "${PI_SUBAGENT_MUX:-auto}"
printf 'HERDR_ENV=%s HERDR_PANE_ID=%s HERDR_SOCKET_PATH=%s\n' \
  "${HERDR_ENV:-}" "${HERDR_PANE_ID:-}" "${HERDR_SOCKET_PATH:-}"
printf 'CMUX_SOCKET_PATH=%s TMUX=%s ZELLIJ=%s WEZTERM_UNIX_SOCKET=%s\n' \
  "${CMUX_SOCKET_PATH:-}" "${TMUX:-}" "${ZELLIJ:-${ZELLIJ_SESSION_NAME:-}}" \
  "${WEZTERM_UNIX_SOCKET:-}"

BACKEND=$(
  node -e 'import("./pi-extension/subagents/cmux.ts").then(m => process.stdout.write(String(m.getMuxBackend())))'
)
test "$BACKEND" != "null" || {
  echo "No supported mux backend available" >&2
  exit 1
}
echo "Testing backend: $BACKEND"
```

Node 22+ required.

For Herdr, require client/server compatibility plus caller identity and a real socket:

```bash
if [ "$BACKEND" = herdr ]; then
  command -v herdr
  test "${HERDR_ENV:-}" = 1
  test -n "${HERDR_PANE_ID:-}"
  test -n "${HERDR_TAB_ID:-}"
  test -n "${HERDR_WORKSPACE_ID:-}"
  test -S "${HERDR_SOCKET_PATH:-}"
  herdr status
  HERDR_BASELINE=$(mktemp)
  herdr api snapshot > "$HERDR_BASELINE"
fi
```

Supported/tested Herdr contract: client/server 0.7.3, protocol 16. Stop if `herdr status` reports incompatibility.

## Step 2: Unit tests

```bash
cd "$ROOT"
npm test
```

Require zero failures. Test counts are informational, not a contract.

## Step 3: Real integration suites

Always force detected backend so unavailable-runtime mistakes fail fast instead of skipping successfully:

```bash
cd "$ROOT"
export PI_SUBAGENT_MUX="$BACKEND"

if [ "$BACKEND" = herdr ]; then
  for run in 1 2; do
    node --test --test-concurrency=1 test/integration/mux-surface.test.ts
  done
else
  node --test --test-concurrency=1 test/integration/mux-surface.test.ts
fi

node --test --test-concurrency=1 test/integration/subagent-lifecycle.test.ts
npm run test:integration
```

`--test-concurrency=1` is mandatory: focus/placement tests manipulate global mux state. Output must contain suites named with forced backend, for example `mux-surface [herdr]` and `subagent-lifecycle [herdr]`. Any `No mux backend available` message is failure in forced mode.

Configure LLM-backed lifecycle tests when needed:

| Variable | Default | Purpose |
|---|---|---|
| `PI_TEST_MODEL` | `anthropic/claude-haiku-4-5` | Model for real Pi sessions |
| `PI_TEST_TIMEOUT` | `120000` | Per-test timeout in ms |

## Step 4: Herdr leak check

When `BACKEND=herdr`, compare caller workspace/tab pane IDs before and after tests:

```bash
HERDR_AFTER=$(mktemp)
herdr api snapshot > "$HERDR_AFTER"

node - "$HERDR_BASELINE" "$HERDR_AFTER" "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" <<'NODE'
const fs = require("node:fs");
const [beforePath, afterPath, workspaceId, tabId] = process.argv.slice(2);
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8")).result.snapshot;
const paneIds = (snapshot) => new Set(
  (snapshot.layouts ?? [])
    .filter((layout) => layout.workspace_id === workspaceId && layout.tab_id === tabId)
    .flatMap((layout) => (layout.panes ?? []).map((pane) => pane.pane_id)),
);
const before = paneIds(read(beforePath));
const after = paneIds(read(afterPath));
const leaked = [...after].filter((pane) => !before.has(pane));
if (leaked.length) {
  console.error(`Leaked Herdr panes: ${leaked.join(", ")}`);
  process.exit(1);
}
console.log(`Herdr pane baseline restored (${after.size} caller-tab panes)`);
NODE

rm -f "$HERDR_BASELINE" "$HERDR_AFTER"
```

## Step 5: Session validation

Locate newest integration session directory, then validate every JSONL file found. Do not require fixed parent/child counts; tests evolve.

```bash
SESSION_DIR=$(
  find ~/.pi/agent/sessions -type d -name '*pi-integ*' -mmin -30 2>/dev/null \
    | tail -1
)
test -n "$SESSION_DIR" || {
  echo "No recent pi-integ session directory found" >&2
  exit 1
}

python3 - "$SESSION_DIR" <<'PY'
import glob, json, os, sys

session_dir = sys.argv[1]
files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")))
if not files:
    raise SystemExit(f"No session files in {session_dir}")

errors = []
parents = children = 0
for path in files:
    name = os.path.basename(path)
    entries = [json.loads(line) for line in open(path) if line.strip()]
    if not entries or entries[0].get("type") != "session":
        errors.append(f"{name}: missing session header")
        continue
    if entries[0].get("parentSession"):
        children += 1
    else:
        parents += 1
    messages = [entry.get("message", {}) for entry in entries if entry.get("type") == "message"]
    if not any(message.get("role") == "user" for message in messages):
        errors.append(f"{name}: no user message")
    if not any(message.get("role") == "assistant" for message in messages):
        errors.append(f"{name}: no assistant message")
    if any(entry.get("type") == "error" for entry in entries):
        errors.append(f"{name}: error entry present")

print(f"Validated {len(files)} sessions: {parents} parent, {children} fork-linked child")
if errors:
    print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
    raise SystemExit(1)
PY
```

## Step 6: Report

Report exact commands, pass/fail/skipped counts from Node output, tested backend(s), Herdr version/protocol when applicable, session-validation totals, and any unavailable backend not exercised. Never claim a skipped or unavailable runtime passed.
