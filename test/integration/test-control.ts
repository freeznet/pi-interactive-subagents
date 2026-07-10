import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";

export default function integrationTestControl(pi: ExtensionAPI) {
  pi.registerTool({
    name: "test_wait_for_file",
    label: "Wait for test file",
    description: "Integration-test helper: wait until a path exists before continuing.",
    parameters: Type.Object({
      path: Type.String(),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_toolCallId, params, signal) {
      const timeoutMs = params.timeoutMs ?? 120_000;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error(`Aborted waiting for ${params.path}`);
        if (existsSync(params.path)) {
          return {
            content: [{ type: "text", text: `File exists: ${params.path}` }],
            details: { path: params.path },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      throw new Error(`Timed out waiting for ${params.path}`);
    },
  });
}
