import { EMPTY_PROJECTION_FINGERPRINT, emptyModifierProjection } from "./mechanicsFixture.js";
import { describe, expect, it } from "vitest";
import { runReadonlyAgentLoop } from "../src/agent/loop.js";
import { ReadonlyToolDispatcher } from "../src/agent/readonlyTools.js";
import type { HighLevelToolName } from "../src/llm/toolSchemas.js";
import type {
  ModelAdapter,
  ModelTurnInput,
  ModelTurnResult,
  ParsedToolCall,
} from "../src/llm/types.js";
import {
  BuildSnapshotSchema,
  ObjectiveSpecSchema,
  SCHEMA_VERSION,
  ScenarioSpecSchema,
} from "../src/schemas.js";

const snapshot = BuildSnapshotSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  mechanicProjection: emptyModifierProjection(),
  mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
  xml: "<PathOfBuilding/>",
  fingerprint: "fingerprint",
  engineVersion: "test",
  dataVersion: "test",
  ruleset: "test",
});

const objective = ObjectiveSpecSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  goals: [{ metric: "FullDPS", direction: "maximize" }],
});

const scenario = ScenarioSpecSchema.parse({
  id: "mapping",
  name: "Mapping",
  enemyIsBoss: "None",
  profile: "sustainable",
});

const context = { snapshot, objective, scenarios: [scenario] };

function inspectCall(id = "call-1"): ParsedToolCall<HighLevelToolName> {
  return {
    id,
    name: "inspect_build",
    arguments: { snapshotId: "snapshot-1" },
    rawArguments: '{"snapshotId":"snapshot-1"}',
  };
}

class RepeatingAdapter implements ModelAdapter<HighLevelToolName> {
  callsUsed = 0;
  readonly callsRemaining = 100;

  async complete(_input: ModelTurnInput): Promise<ModelTurnResult<HighLevelToolName>> {
    this.callsUsed += 1;
    return {
      kind: "message",
      content: "",
      toolCalls: [inspectCall(`call-${this.callsUsed}`)],
    };
  }
}

describe("ReadonlyToolDispatcher", () => {
  it("dispatches validated high-level tools and redacts output", async () => {
    const dispatcher = new ReadonlyToolDispatcher({
      inspect_build: (args, toolContext) => ({
        snapshotId: args.snapshotId,
        fingerprint: toolContext.snapshot.fingerprint,
        accountName: "private-account",
        seller: "private-seller",
      }),
    });

    const result = await dispatcher.execute(inspectCall(), context);
    expect(result).toMatchObject({
      ok: true,
      output: {
        snapshotId: "snapshot-1",
        fingerprint: "fingerprint",
      },
    });
    expect(result.output).not.toHaveProperty("accountName");
    expect(result.output).not.toHaveProperty("seller");
  });

  it("fails closed when allowed tool has no handler", async () => {
    const dispatcher = new ReadonlyToolDispatcher({});
    await expect(dispatcher.execute(inspectCall(), context)).resolves.toMatchObject({
      ok: false,
      output: { error: "tool_unavailable" },
    });
  });
});

describe("runReadonlyAgentLoop", () => {
  it("stops repeated unchanged calls as doom loop", async () => {
    const dispatcher = new ReadonlyToolDispatcher({
      inspect_build: () => ({ fingerprint: "unchanged" }),
    });
    const result = await runReadonlyAgentLoop({
      adapter: new RepeatingAdapter(),
      dispatcher,
      messages: [{ role: "user", content: "Improve build" }],
      context,
      limits: { duplicateCallLimit: 3, modelCallLimit: 16, recursionLimit: 40 },
    });

    expect(result.stopReason).toBe("doom_loop");
    expect(result.modelCalls).toBe(3);
    expect(result.toolCalls).toBe(3);
  });

  it("enforces per-loop model call limit", async () => {
    let version = 0;
    const result = await runReadonlyAgentLoop({
      adapter: new RepeatingAdapter(),
      dispatcher: new ReadonlyToolDispatcher({
        inspect_build: () => {
          version += 1;
          return { version };
        },
      }),
      messages: [{ role: "user", content: "Improve build" }],
      context,
      limits: { duplicateCallLimit: 10, modelCallLimit: 2, recursionLimit: 40 },
    });

    expect(result.stopReason).toBe("model_call_limit");
    expect(result.modelCalls).toBe(2);
  });

  it("reports cancellation during an in-flight model request", async () => {
    const controller = new AbortController();
    const adapter = {
      callsUsed: 0,
      callsRemaining: 16,
      complete: async (_input: unknown, signal?: AbortSignal) => {
        adapter.callsUsed += 1;
        adapter.callsRemaining -= 1;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const loop = runReadonlyAgentLoop({
      adapter,
      dispatcher: new ReadonlyToolDispatcher({}),
      messages: [{ role: "user", content: "Improve build" }],
      context,
      signal: controller.signal,
    });
    controller.abort(new Error("user cancelled"));
    await expect(loop).resolves.toMatchObject({ stopReason: "cancelled" });
  });
});
