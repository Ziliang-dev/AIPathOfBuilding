import {
  MechanicFactBundleSchema,
  MechanicFactSchema,
  SCHEMA_VERSION,
  type BuildSnapshot,
  type MechanicContext,
  type MechanicFact,
  type MechanicFactBundle,
  type MechanicObservation,
} from "../schemas.js";
import { canonicalHash } from "../search/canonical.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];
}

function scopedId(context: MechanicContext, raw: string): string {
  return `${context}:${raw}`;
}

function fact(input: Omit<MechanicFact, "fingerprint">): MechanicFact {
  return MechanicFactSchema.parse({ ...input, fingerprint: `sha256:${canonicalHash(input)}` });
}

function catalog(snapshot: BuildSnapshot, id: string): Record<string, unknown> | undefined {
  return snapshot.contentCatalog?.find((entry) => entry.id === id)?.data;
}

function provenance(
  kind: "projection" | "native_probe" | "native_evidence" | "catalog" | "worker_observation",
  sourceId: string,
  fingerprint: string,
  evidence: readonly string[] = [],
) {
  return [{ kind, sourceId, fingerprint, evidence: [...evidence] }];
}

function projectionFacts(snapshot: BuildSnapshot, context: MechanicContext, observation: MechanicObservation): MechanicFact[] {
  const facts: MechanicFact[] = [];
  const activeItems = new Set(observation.activeItemIds);
  const activeLines = new Set(observation.activeModifierIds);
  for (const item of snapshot.mechanicProjection.items) {
    const itemId = scopedId(context, `item:${item.id}`);
    facts.push(fact({
      id: itemId,
      context,
      domain: "gear",
      kind: "item",
      ...(item.name === undefined ? {} : { name: item.name }),
      active: activeItems.has(item.id),
      provenance: provenance("projection", `item:${item.id}`, snapshot.mechanicProjection.fingerprint, [
        `legality:${item.legality.status}`,
        ...item.references.map(({ itemSetId, slot }) => `item-set:${itemSetId}:${slot}`),
      ]),
      data: {
        itemId: item.id,
        baseName: item.baseName,
        type: item.type,
        rarity: item.rarity,
        legality: item.legality,
        state: item.state,
        references: item.references,
      },
    }));
    for (const line of item.modifierLines) {
      const id = scopedId(context, line.id);
      facts.push(fact({
        id,
        context,
        domain: "gear",
        kind: "modifierLine",
        name: line.rawText,
        active: activeLines.has(line.id),
        provenance: provenance("projection", line.id, snapshot.mechanicProjection.fingerprint, [
          `parse:${line.parseStatus}`,
          ...line.provenance.evidence,
        ]),
        data: {
          itemEntityId: itemId,
          itemId: item.id,
          section: line.section,
          ordinal: line.ordinal,
          parseStatus: line.parseStatus,
          disabled: line.disabled,
          flags: line.flags,
          modTags: line.modTags,
          parsedMods: line.parsedMods,
          modifierProvenance: line.provenance,
        },
      }));
      for (const [index, parsed] of line.parsedMods.entries()) {
        facts.push(fact({
          id: `${id}:parsed:${index + 1}`,
          context,
          domain: "gear",
          kind: "parsedModifier",
          name: parsed.name,
          active: activeLines.has(line.id),
          provenance: provenance("projection", `${line.id}:parsed:${index + 1}`, snapshot.mechanicProjection.fingerprint, [
            `classification:${parsed.classification}`,
          ]),
          data: { modifierLineEntityId: id, ...parsed },
        }));
      }
    }
  }
  return facts;
}

function skillFacts(snapshot: BuildSnapshot, context: MechanicContext, observation: MechanicObservation): MechanicFact[] {
  const facts: MechanicFact[] = [];
  const skillsCatalog = catalog(snapshot, "pob:skills");
  const nativeProbe = record(skillsCatalog?.nativeLinkProbe);
  const groups = records(nativeProbe?.groups);
  const projectedGrant = (names: readonly string[], id: string, displayName?: string) => {
    for (const item of snapshot.mechanicProjection.items) {
      if (!item.active) continue;
      for (const line of item.modifierLines) {
        if (!line.active) continue;
        for (const parsed of line.parsedMods) {
          const value = record(parsed.value);
          const skillId = String(value?.skillId ?? value?.id ?? "");
          const skillName = String(value?.skillName ?? value?.name ?? "");
          if (names.includes(parsed.name) && (skillId === id || (displayName !== undefined && skillName === displayName))) {
            return { itemId: item.id, lineId: line.id, section: line.section, ordinal: line.ordinal };
          }
        }
      }
    }
    return undefined;
  };
  for (const observed of observation.skills) {
    const group = groups.find((entry) => entry.index === observed.group);
    const gems = records(group?.gems);
    const activeGem = gems.find((entry) => entry.support !== true && entry.enabled !== false);
    const skillGrant = observed.fromItem ? projectedGrant(["ExtraSkill", "ExtraSkillMod"], observed.id, observed.name) : undefined;
    const skillId = scopedId(context, `skill:${observed.id}`);
    facts.push(fact({
      id: skillId,
      context,
      domain: "skills",
      kind: "skill",
      name: observed.name,
      active: observed.enabled,
      provenance: [
        ...provenance("native_probe", `group:${observed.group}:skill:${observed.id}`, observation.nativeProbeFingerprint, [
          `group:${observed.group}`,
          observed.includeInFullDps ? "full-dps:true" : "full-dps:false",
        ]),
        ...(skillGrant === undefined ? [] : provenance("projection", skillGrant.lineId, snapshot.mechanicProjection.fingerprint, [skillGrant.lineId])),
      ],
      data: {
        group: observed.group,
        ...(typeof activeGem?.index === "number" ? { gem: activeGem.index } : {}),
        includeInFullDps: observed.includeInFullDps,
        fromItem: observed.fromItem,
        ...(skillGrant === undefined ? {} : { sourceModifier: skillGrant }),
      },
    }));
    for (const support of observed.supports) {
      const supportGem = gems.find((entry) => entry.grantedEffectId === support.id && entry.support === true);
      const supportGrant = support.fromItem ? projectedGrant(["ExtraSupport", "ExtraSupportMod"], support.id, support.name) : undefined;
      facts.push(fact({
        id: scopedId(context, `support:${observed.group}:${observed.id}:${support.id}`),
        context,
        domain: "skills",
        kind: "support",
        name: support.name,
        active: true,
        provenance: [
          ...provenance("native_probe", `group:${observed.group}:support:${support.id}`, observation.nativeProbeFingerprint, [
            `supports:${skillId}`,
            support.fromItem ? "from-item:true" : "from-item:false",
          ]),
          ...(supportGrant === undefined ? [] : provenance("projection", supportGrant.lineId, snapshot.mechanicProjection.fingerprint, [supportGrant.lineId])),
        ],
        data: {
          group: observed.group,
          ...(typeof supportGem?.index === "number" ? { gem: supportGem.index } : {}),
          grantedEffectId: support.id,
          supportedSkillEntityId: skillId,
          fromItem: support.fromItem,
          ...(supportGrant === undefined ? {} : { sourceModifier: supportGrant }),
        },
      }));
    }
  }
  return facts;
}

function treeFacts(snapshot: BuildSnapshot, context: MechanicContext, observation: MechanicObservation): MechanicFact[] {
  const tree = catalog(snapshot, "pob:tree");
  const allocated = records(tree?.allocated);
  const active = new Set(observation.activePassiveIds);
  return allocated.map((node) => {
    const nodeId = typeof node.id === "number" || typeof node.id === "string" ? node.id : "unknown";
    return fact({
      id: scopedId(context, `passive:${nodeId}`),
      context,
      domain: "tree",
      kind: "passive",
      ...(typeof node.name === "string" ? { name: node.name } : {}),
      active: active.has(String(nodeId)),
      provenance: provenance("catalog", `passive:${nodeId}`, observation.fingerprint, ["allocated-passive"]),
      data: { ...node, nodeId },
    });
  });
}

function configFacts(snapshot: BuildSnapshot, context: MechanicContext, observation: MechanicObservation): MechanicFact[] {
  const config = catalog(snapshot, "pob:config");
  const claims = records(config?.conditionClaims);
  const nativeConditions = new Map(observation.conditions.map((condition) => [condition.id.split(":").slice(1).join(":"), condition]));
  const facts: MechanicFact[] = [];
  for (const [configKey, value] of Object.entries(observation.configValues).sort(([left], [right]) => left.localeCompare(right))) {
    const claim = claims.find((entry) => entry.configKey === configKey || entry.condition === configKey);
    const native = nativeConditions.get(configKey);
    facts.push(fact({
      id: scopedId(context, `config:${configKey}`),
      context,
      domain: "config",
      kind: "config",
      name: typeof claim?.label === "string" ? claim.label : configKey,
      active: claim === undefined || claim.sourceStatus === "manual",
      provenance: provenance(native === undefined ? "catalog" : "native_evidence", `config:${configKey}`,
        native === undefined ? observation.fingerprint : observation.evidenceFingerprint,
        native?.sources ?? ["manual-config"]),
      data: { configKey, value, ...(claim === undefined ? {} : { claim }), nativeSources: native?.sources ?? [] },
    }));
  }
  for (const condition of observation.conditions) {
    facts.push(fact({
      id: scopedId(context, `condition:${condition.id}`),
      context,
      domain: "condition",
      kind: "condition",
      name: condition.id,
      active: true,
      provenance: provenance("native_evidence", `condition:${condition.id}`, observation.evidenceFingerprint, condition.sources),
      data: { actor: condition.actor, sources: condition.sources },
    }));
  }
  return facts;
}

function actorFacts(snapshot: BuildSnapshot, context: MechanicContext, observation: MechanicObservation): MechanicFact[] {
  const actors = catalog(snapshot, "pob:actors");
  const projection = record(actors?.actorSeason);
  const actorList = records(projection?.actors);
  const season = record(projection?.season) ?? {};
  const meaningful = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(meaningful);
    if (value !== null && typeof value === "object") return Object.values(value).some(meaningful);
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.length > 0;
    return false;
  };
  const facts: MechanicFact[] = actorList.map((actor, index) => fact({
    id: scopedId(context, `actor:${String(actor.id ?? actor.kind ?? index + 1)}`),
    context,
    domain: "actor",
    kind: actor.kind === "party" ? "actorBuff" : "actor",
    ...(typeof actor.name === "string" ? { name: actor.name } : {}),
    active: actor.kind === "party" ? actor.active === true : actor.active !== false,
    provenance: provenance("catalog", `actor:${index + 1}`, observation.fingerprint, ["actor-season-projection"]),
    data: actor,
  }));
  for (const [key, value] of Object.entries(season).sort(([left], [right]) => left.localeCompare(right))) {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") continue;
    facts.push(fact({
      id: scopedId(context, `season:${key}`),
      context,
      domain: "actor",
      kind: "seasonMechanic",
      name: key,
      active: meaningful(value),
      provenance: provenance("catalog", `season:${key}`, observation.fingerprint, [snapshot.ruleset]),
      data: { value },
    }));
  }
  return facts;
}

function numericFacts(
  context: MechanicContext,
  observation: MechanicObservation,
  values: Readonly<Record<string, number>>,
  kind: "metric" | "resource" | "cooldown" | "duration",
  domain: "offence" | "resource" | "defence",
): MechanicFact[] {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => fact({
    id: scopedId(context, `${kind}:${name}`),
    context,
    domain,
    kind,
    name,
    active: true,
    provenance: provenance("worker_observation", `${kind}:${name}`, observation.fingerprint, [`value:${value}`]),
    data: { value },
  }));
}

const OFFENCE_METRICS = new Set([
  "FullDPS", "CombinedDPS", "TotalDPS", "TotalDot", "Speed",
  "fullDps", "combinedDps", "totalDps", "totalDot", "speed",
]);

function metricFacts(context: MechanicContext, observation: MechanicObservation): MechanicFact[] {
  const offence: Record<string, number> = {};
  const defence: Record<string, number> = {};
  for (const [name, value] of Object.entries(observation.metrics)) {
    (OFFENCE_METRICS.has(name) ? offence : defence)[name] = value;
  }
  return [
    ...numericFacts(context, observation, offence, "metric", "offence"),
    ...numericFacts(context, observation, defence, "metric", "defence"),
  ];
}

function inventory(snapshot: BuildSnapshot) {
  const loadouts = catalog(snapshot, "pob:loadouts");
  const activeItem = String(loadouts?.activeItemSetId ?? "");
  const activeTree = String(loadouts?.activeTreeSpecId ?? "");
  const activeSkill = String(loadouts?.activeSkillSetId ?? "");
  const stringIds = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
  return {
    inactiveItemSetIds: stringIds(loadouts?.itemSetIds).filter((id) => id !== activeItem),
    inactiveTreeSpecIds: stringIds(loadouts?.treeSpecIds).filter((id) => id !== activeTree),
    inactiveSkillSetIds: stringIds(loadouts?.skillSetIds).filter((id) => id !== activeSkill),
  };
}

export function extractMechanicFacts(
  snapshot: BuildSnapshot,
  observations: Readonly<Record<MechanicContext, MechanicObservation>>,
): MechanicFactBundle {
  const requiredCatalogs = ["pob:skills", "pob:items", "pob:tree", "pob:actors", "pob:config", "pob:loadouts"];
  const available = new Set(snapshot.contentCatalog?.map(({ id }) => id) ?? []);
  const missingScopes = requiredCatalogs.filter((id) => !available.has(id));
  const truncatedScopes: string[] = [];
  if (catalog(snapshot, "pob:skills")?.currentGroupsTruncated === true) truncatedScopes.push("pob:skills:current-groups");
  if (catalog(snapshot, "pob:tree")?.allocatedTruncated === true) truncatedScopes.push("pob:tree:allocated");
  if (record(catalog(snapshot, "pob:actors")?.actorSeason)?.truncated === true) truncatedScopes.push("pob:actors:active");
  if (catalog(snapshot, "pob:config")?.valuesTruncated === true) truncatedScopes.push("pob:config:values");
  if (catalog(snapshot, "pob:config")?.conditionClaimsTruncated === true) truncatedScopes.push("pob:config:claims");
  if (catalog(snapshot, "pob:loadouts")?.truncated === true) truncatedScopes.push("pob:loadouts");
  const nativeProbe = record(catalog(snapshot, "pob:skills")?.nativeLinkProbe);
  if (nativeProbe?.complete !== true || nativeProbe.truncated === true) truncatedScopes.push("pob:skills:native-link-probe");
  if (snapshot.mechanicProjection.fingerprint !== snapshot.mechanicProjectionFingerprint) {
    missingScopes.push("modifier-projection-fingerprint");
  }
  const contexts: MechanicContext[] = ["weaponSet1", "weaponSet2"];
  const entities = contexts.flatMap((context) => {
    const observation = observations[context];
    return [
      ...projectionFacts(snapshot, context, observation),
      ...skillFacts(snapshot, context, observation),
      ...treeFacts(snapshot, context, observation),
      ...configFacts(snapshot, context, observation),
      ...actorFacts(snapshot, context, observation),
      ...metricFacts(context, observation),
      ...numericFacts(context, observation, observation.resources, "resource", "resource"),
      ...numericFacts(context, observation, observation.cooldowns, "cooldown", "resource"),
      ...numericFacts(context, observation, observation.durations, "duration", "resource"),
    ];
  }).sort((left, right) => left.id.localeCompare(right.id));
  const duplicate = entities.find((entity, index) => index > 0 && entities[index - 1]?.id === entity.id);
  if (duplicate !== undefined) missingScopes.push(`duplicate-entity:${duplicate.id}`);
  const withoutFingerprint = {
    schemaVersion: SCHEMA_VERSION,
    snapshotFingerprint: snapshot.fingerprint,
    projectionFingerprint: snapshot.mechanicProjection.fingerprint,
    engineVersion: snapshot.engineVersion,
    dataVersion: snapshot.dataVersion,
    ruleset: snapshot.ruleset,
    contexts,
    complete: missingScopes.length === 0 && truncatedScopes.length === 0,
    missingScopes: [...new Set(missingScopes)].sort(),
    truncatedScopes: [...new Set(truncatedScopes)].sort(),
    entities,
    observations,
    inventory: inventory(snapshot),
  };
  return MechanicFactBundleSchema.parse({
    ...withoutFingerprint,
    fingerprint: `sha256:${canonicalHash(withoutFingerprint)}`,
  });
}

export function compactFactManifest(bundle: MechanicFactBundle): unknown {
  const counts = new Map<string, number>();
  for (const entity of bundle.entities) {
    const key = `${entity.context}:${entity.domain}:${entity.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    snapshotFingerprint: bundle.snapshotFingerprint,
    factBundleFingerprint: bundle.fingerprint,
    contexts: bundle.contexts,
    complete: bundle.complete,
    missingScopes: bundle.missingScopes,
    truncatedScopes: bundle.truncatedScopes,
    entityCount: bundle.entities.length,
    counts: Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))),
    inventory: bundle.inventory,
  };
}
