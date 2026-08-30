import {
  ScenarioSpecSchema,
  type RankedScenarioId,
  type ScenarioSpec,
} from "../schemas.js";

export const SUSTAINABLE_UPTIME_THRESHOLD = 0.9;

const STANDARD_SCENARIOS: ReadonlyArray<{
  id: RankedScenarioId;
  name: string;
  enemyIsBoss: ScenarioSpec["enemyIsBoss"];
  allowsAdds: boolean;
}> = [
  { id: "mapping", name: "Mapping", enemyIsBoss: "None", allowsAdds: true },
  { id: "standardBoss", name: "Standard Boss", enemyIsBoss: "Boss", allowsAdds: false },
  { id: "pinnacle", name: "Guardian / Pinnacle", enemyIsBoss: "Pinnacle", allowsAdds: false },
  { id: "uber", name: "Uber Pinnacle", enemyIsBoss: "Uber", allowsAdds: false },
];

export interface StandardScenarioOptions {
  readonly mapModifiers?: readonly string[];
  readonly bossSkillPreset?: string;
  readonly assumptions?: Readonly<Record<string, unknown>>;
}

function createScenario(
  descriptor: (typeof STANDARD_SCENARIOS)[number],
  profile: "sustainable" | "peak",
  options: StandardScenarioOptions,
): ScenarioSpec {
  const mapping = descriptor.id === "mapping";
  return ScenarioSpecSchema.parse({
    id: descriptor.id,
    name: `${descriptor.name} (${profile === "peak" ? "Peak" : "Sustainable"})`,
    enemyIsBoss: descriptor.enemyIsBoss,
    profile,
    mapModifiers: mapping ? [...(options.mapModifiers ?? [])] : [],
    ...(mapping || options.bossSkillPreset === undefined
      ? {}
      : { bossSkillPreset: options.bossSkillPreset }),
    allowedEvents: [
      ...(mapping ? ["onKill" as const] : []),
      "onHit" as const,
      "onCrit" as const,
      "onBlock" as const,
      "onUse" as const,
      "recently" as const,
    ],
    assumptions: {
      ...options.assumptions,
      adds: descriptor.allowsAdds,
      onKill: mapping,
      allowTemporaryBuffs: profile === "peak",
      sustainableUptimeThreshold: SUSTAINABLE_UPTIME_THRESHOLD,
    },
  });
}

/** Creates the four ranked scenarios plus their non-ranking Peak counterparts. */
export function generateStandardScenarios(options: StandardScenarioOptions = {}): ScenarioSpec[] {
  const sustainable = STANDARD_SCENARIOS.map((descriptor) =>
    createScenario(descriptor, "sustainable", options));
  const peak = STANDARD_SCENARIOS.map((descriptor) => createScenario(descriptor, "peak", options));
  return [...sustainable, ...peak];
}

/** Preserves the user's current Config only as a diagnostic, never as ranked proof. */
export function createCurrentDiagnosticScenario(
  enemyIsBoss: ScenarioSpec["enemyIsBoss"],
  assumptions: Readonly<Record<string, unknown>> = {},
): ScenarioSpec {
  return ScenarioSpecSchema.parse({
    id: "current",
    name: "Current configuration (diagnostic)",
    enemyIsBoss,
    profile: "current",
    mapModifiers: [],
    allowedEvents: [],
    assumptions: { ...assumptions, preserveManualConfiguration: true },
  });
}

export function isRankedScenario(scenario: ScenarioSpec): scenario is ScenarioSpec & {
  id: RankedScenarioId;
  profile: "sustainable" | "peak";
} {
  return scenario.id !== "current" && scenario.profile !== "current";
}
