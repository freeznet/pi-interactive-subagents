/**
 * Model scoping for Pi-backed subagents.
 *
 * Why this exists: a bare model id like "glm-5.3" can exist in several
 * providers' catalogs (zai, zai-coding-cn, opencode-go, …). When the child pi
 * resolves `--model glm-5.3` it either errors out as ambiguous (when more
 * than one provider is authenticated) or fuzzy-matches into an arbitrary
 * provider — including one with no configured credentials. The subagent then
 * launches, fails its first API request, and hangs in the pane.
 *
 * This module resolves the requested model against an allowlist before any
 * pane is created:
 *
 *   1. When the session has scoped models (from `--models` or the
 *      `enabledModels` setting), only those models are allowed.
 *   2. Otherwise, authenticated models from the model registry act as the
 *      allowlist (never providers without credentials).
 *   3. When neither is available, the model string passes through unvalidated
 *      (previous behavior).
 *
 * Successful resolution returns a canonical `provider/modelId` reference so
 * the child never has to guess. When no model is requested at all, the
 * parent's active model is inherited — the subagent runs what you're running.
 */

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Structural view of a model reference, tolerant of both Model and ScopedModel shapes. */
export interface ScopedModelRef {
  provider: string;
  id: string;
  name?: string;
  thinkingLevel?: string;
}

export type SubagentModelSource = "param" | "agent" | "parent";

export interface SubagentModelResolution {
  /** Canonical "provider/modelId" reference, safe to pass to `pi --model`. */
  model: string;
  /** Optional thinking level (e.g. "high") from a `:suffix` or agent frontmatter. */
  thinking?: string;
  source: SubagentModelSource;
}

export interface ModelScopeInput {
  /** `model` tool parameter. Wins over the agent frontmatter default. */
  requestedModel?: string;
  /** `model` frontmatter from the agent definition. */
  agentModel?: string;
  /** `thinking` frontmatter from the agent definition. */
  agentThinking?: string;
  /** ctx.scopedModels — allowlist when non-empty. */
  scopedModels?: readonly unknown[] | undefined;
  /** ctx.model — the parent session's active model. */
  parentModel?: { provider: string; id: string } | null | undefined;
  /** ctx.modelRegistry.getAvailable() — fallback allowlist of authenticated models. */
  availableModels?: readonly unknown[] | undefined;
}

export interface ModelScopeResult {
  /**
   * Undefined when no model was requested anywhere and there is nothing to
   * inherit — the child keeps its own default resolution in that case.
   */
  resolution?: SubagentModelResolution;
  /** Present when the requested model is not usable; explains what went wrong. */
  error?: string;
}

/**
 * Normalize heterogeneous model objects into ScopedModelRef.
 * Accepts:
 *   - ScopedModel: { model: { provider, id, name }, thinkingLevel? }
 *   - Model: { provider, id, name }
 */
export function normalizeModelRefs(models: readonly unknown[]): ScopedModelRef[] {
  const refs: ScopedModelRef[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, any>;
    const inner = raw.model && typeof raw.model === "object" ? raw.model : raw;
    const provider = typeof inner.provider === "string" ? inner.provider : undefined;
    const id = typeof inner.id === "string" ? inner.id : undefined;
    if (!provider || !id) continue;
    refs.push({
      provider,
      id,
      ...(typeof inner.name === "string" ? { name: inner.name } : {}),
      ...(typeof raw.thinkingLevel === "string" ? { thinkingLevel: raw.thinkingLevel } : {}),
    });
  }
  return refs;
}

/**
 * Split a trailing `:thinking` suffix when it names a valid thinking level.
 * Mirrors pi's parseModelPattern: the full pattern is tried first by the
 * matcher, so an id that legitimately contains a colon is still matched
 * before this split is applied.
 */
export function splitThinkingSuffix(pattern: string): { base: string; thinking?: string } {
  const idx = pattern.lastIndexOf(":");
  if (idx === -1) return { base: pattern };
  const suffix = pattern.slice(idx + 1).trim().toLowerCase();
  if (!THINKING_LEVELS.has(suffix)) return { base: pattern };
  return { base: pattern.slice(0, idx), thinking: suffix };
}

function refKey(ref: ScopedModelRef): string {
  return `${ref.provider}/${ref.id}`.toLowerCase();
}

/**
 * Match a model pattern against the allowlist.
 *
 * Match order (mirrors pi's resolver):
 *   1. Exact `provider/modelId` reference
 *   2. Exact bare model id
 *   3. Fuzzy: id or display name contains the pattern
 *
 * Ambiguous matches (more than one distinct provider/model) are errors, never
 * a silent pick — unlike the child-side fuzzy resolver, which can land on an
 * unauthenticated provider.
 */
export function matchModelInScope(
  pattern: string,
  refs: ScopedModelRef[],
): { matches: ScopedModelRef[] } {
  const lowered = pattern.trim().toLowerCase();
  if (!lowered) return { matches: [] };

  // 1. Exact provider/id
  const exactRef = refs.filter((r) => refKey(r) === lowered);
  if (exactRef.length > 0) return { matches: dedupeRefs(exactRef) };

  // 2. Exact bare id
  const bareId = refs.filter((r) => r.id.toLowerCase() === lowered);
  if (bareId.length > 0) return { matches: dedupeRefs(bareId) };

  // 3. Fuzzy contains (id or name)
  const fuzzy = refs.filter(
    (r) =>
      r.id.toLowerCase().includes(lowered) ||
      (r.name?.toLowerCase().includes(lowered) ?? false),
  );
  return { matches: dedupeRefs(fuzzy) };
}

function dedupeRefs(refs: ScopedModelRef[]): ScopedModelRef[] {
  const seen = new Map<string, ScopedModelRef>();
  for (const ref of refs) {
    const key = refKey(ref);
    if (!seen.has(key)) seen.set(key, ref);
  }
  return [...seen.values()];
}

function formatAllowedList(refs: ScopedModelRef[]): string {
  return refs.map((r) => `- ${r.provider}/${r.id}`).join("\n");
}

function formatMatches(matches: ScopedModelRef[]): string {
  return matches.map((r) => `- ${r.provider}/${r.id}`).join("\n");
}

/**
 * Resolve the effective subagent model against the allowlist.
 *
 * Precedence: `requestedModel` > `agentModel` > inherit `parentModel`.
 * Returns an error (no pane spawn) when a requested model cannot be resolved
 * unambiguously within the allowlist.
 */
export function resolveSubagentModelScope(input: ModelScopeInput): ModelScopeResult {
  const scopedRefs = input.scopedModels ? normalizeModelRefs(input.scopedModels) : [];
  const availableRefs = input.availableModels ? normalizeModelRefs(input.availableModels) : [];

  // Allowlist: scoped models win; otherwise authenticated available models.
  const allowlist = scopedRefs.length > 0 ? scopedRefs : availableRefs;
  const allowlistKind = scopedRefs.length > 0 ? "session scoped-models" : "authenticated models";

  const requested = input.requestedModel?.trim() || input.agentModel?.trim() || "";
  const requestedSource: SubagentModelSource = input.requestedModel?.trim()
    ? "param"
    : input.agentModel?.trim()
      ? "agent"
      : "parent";

  if (requested) {
    // Pass-through when there is nothing to validate against.
    if (allowlist.length === 0) {
      return {
        resolution: {
          model: requested,
          ...(input.agentThinking ? { thinking: input.agentThinking } : {}),
          source: requestedSource,
        },
      };
    }

    // Try the full pattern first (ids may contain colons), then strip a
    // thinking-level suffix and retry — same order as pi's parseModelPattern.
    let base = requested;
    let suffixThinking: string | undefined;
    let matches = matchModelInScope(base, allowlist).matches;

    if (matches.length === 0) {
      const split = splitThinkingSuffix(requested);
      if (split.thinking) {
        base = split.base;
        suffixThinking = split.thinking;
        matches = matchModelInScope(base, allowlist).matches;
      }
    }

    if (matches.length === 0) {
      return {
        error:
          `Model "${requested}" is not available for subagents. ` +
          `It matches no model in the ${allowlistKind} allowlist:\n` +
          `${formatAllowedList(allowlist)}\n\n` +
          `Omit \`model\` to inherit the parent model${
            input.parentModel ? ` (${input.parentModel.provider}/${input.parentModel.id})` : ""
          }, or pick one of the allowed models above.`,
      };
    }

    if (matches.length > 1) {
      return {
        error:
          `Model "${requested}" matches multiple ${allowlistKind}:\n` +
          `${formatMatches(matches)}\n\n` +
          `Use the full "provider/model" form to disambiguate, or omit \`model\` to inherit the parent model${
            input.parentModel ? ` (${input.parentModel.provider}/${input.parentModel.id})` : ""
          }.`,
      };
    }

    const match = matches[0];
    const thinking = suffixThinking ?? input.agentThinking;
    return {
      resolution: {
        model: `${match.provider}/${match.id}`,
        ...(thinking ? { thinking } : {}),
        source: requestedSource,
      },
    };
  }

  // No model requested anywhere: inherit the parent's active model.
  if (input.parentModel?.provider && input.parentModel?.id) {
    return {
      resolution: {
        model: `${input.parentModel.provider}/${input.parentModel.id}`,
        ...(input.agentThinking ? { thinking: input.agentThinking } : {}),
        source: "parent",
      },
    };
  }

  return {};
}
