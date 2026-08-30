import type {
  DomainSearchState,
  EvaluatedCandidate,
  SearchCandidate,
  SearchDomain,
  SearchObjective,
} from "./types.js";
import { SEARCH_DOMAINS } from "./types.js";
import { canonicalHash } from "./canonical.js";

export interface AdapterContext<State extends DomainSearchState<Action>, Action> {
  readonly state: State;
  readonly seed: EvaluatedCandidate<Action>;
  readonly frontier: readonly EvaluatedCandidate<Action>[];
  readonly objective: SearchObjective;
  readonly round: number;
  readonly signal: AbortSignal;
}

export interface DomainAdapter<State extends DomainSearchState<Action>, Action = unknown> {
  readonly domain: SearchDomain;
  generate(context: AdapterContext<State, Action>): Promise<readonly SearchCandidate<Action>[]>;
}

export class AdapterRegistry<State extends DomainSearchState<Action>, Action = unknown> {
  readonly #adapters = new Map<SearchDomain, DomainAdapter<State, Action>>();

  public register(adapter: DomainAdapter<State, Action>): this {
    if (this.#adapters.has(adapter.domain)) {
      throw new Error(`Adapter already registered for domain: ${adapter.domain}`);
    }
    this.#adapters.set(adapter.domain, adapter);
    return this;
  }

  public get(domain: SearchDomain): DomainAdapter<State, Action> {
    const adapter = this.#adapters.get(domain);
    if (!adapter) throw new Error(`Missing adapter for domain: ${domain}`);
    return adapter;
  }

  public list(): readonly DomainAdapter<State, Action>[] {
    return SEARCH_DOMAINS.flatMap((domain) => {
      const adapter = this.#adapters.get(domain);
      return adapter ? [adapter] : [];
    });
  }

  public assertComplete(): void {
    const missing = SEARCH_DOMAINS.filter((domain) => !this.#adapters.has(domain));
    if (missing.length) throw new Error(`Missing full-domain adapters: ${missing.join(", ")}`);
  }
}

class CatalogDomainAdapter<State extends DomainSearchState<Action>, Action> implements DomainAdapter<State, Action> {
  public constructor(public readonly domain: SearchDomain) {}

  public async generate(context: AdapterContext<State, Action>): Promise<readonly SearchCandidate<Action>[]> {
    const entries = context.state.domainCandidates?.[this.domain] ?? [];
    const inferred = inferDomainCandidates(context.state, this.domain, context.seed);
    const explicit = entries
      .filter((candidate) => candidate.parentIds === undefined || candidate.parentIds.includes(context.seed.id))
      .flatMap((candidate) => {
        const composed = composeCandidate(candidate, context.seed, this.domain);
        return composed ? [composed] : [];
      });
    return [...explicit, ...inferred]
      .filter((candidate) => candidateAllowed(candidate, this.domain, context.objective, context.state))
      .map((candidate) => ({ ...candidate, domain: this.domain }))
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((candidate, index, all) => index === 0 || all[index - 1]?.id !== candidate.id);
  }
}

function composeCandidate<Action>(
  proposal: SearchCandidate<Action>,
  seed: EvaluatedCandidate<Action>,
  domain: SearchDomain,
): SearchCandidate<Action> | undefined {
  if (proposal.metricsByScenario || proposal.metadata?.absolute === true) return proposal;
  const existingIds = new Set(seed.actions.map(actionId).filter((id): id is string => id !== undefined));
  const delta = proposal.actions.filter((action) => {
    const id = actionId(action);
    return id === undefined || !existingIds.has(id);
  });
  if (!delta.length) return undefined;
  const actions = [...seed.actions, ...delta];
  const deltaCost = proposal.estimatedCost ?? actionsCost(delta);
  return {
    ...proposal,
    id: `candidate:${domain}:${canonicalHash(actions).slice(0, 20)}`,
    baseFingerprint: seed.baseFingerprint,
    actions,
    domain,
    parentIds: [seed.id],
    estimatedCost: candidateCost(seed) + deltaCost,
    metadata: {
      ...proposal.metadata,
      proposalId: proposal.id,
      graphNodeIds: [...new Set([
        ...candidateGraphNodeIds(seed),
        ...candidateGraphNodeIds(proposal),
      ])].sort(),
    },
  };
}

function actionId(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).id === "string"
    ? (value as Record<string, unknown>).id as string
    : undefined;
}

function actionCost(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const cost = (value as Record<string, unknown>).costDivine;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

function actionsCost(actions: readonly unknown[]): number {
  return actions.reduce<number>((total, action) => total + actionCost(action), 0);
}

function candidateCost<Action>(candidate: SearchCandidate<Action>): number {
  return candidate.estimatedCost ?? actionsCost(candidate.actions);
}

function inferDomainCandidates<State extends DomainSearchState<Action>, Action>(
  state: State,
  domain: SearchDomain,
  seed: EvaluatedCandidate<Action>,
): SearchCandidate<Action>[] {
  const proposals: SearchCandidate<Action>[] = [];
  const add = (
    id: string,
    description: string,
    action: Record<string, unknown> | readonly Record<string, unknown>[],
    metadata: Readonly<Record<string, unknown>>,
    costDivine?: number,
  ): void => {
    const existingIds = new Set(seed.actions.map(actionId).filter((id): id is string => id !== undefined));
    const addedIds = new Set<string>();
    const addedActions = (Array.isArray(action) ? action : [action])
      .map((entry) => entry as Action)
      .filter((entry) => {
        const entryId = actionId(entry);
        if (entryId === undefined) return true;
        if (existingIds.has(entryId) || addedIds.has(entryId)) return false;
        addedIds.add(entryId);
        return true;
      });
    if (!addedActions.length) return;
    const actions = [...seed.actions, ...addedActions];
    const totalCost = candidateCost(seed) + (costDivine ?? actionsCost(addedActions));
    proposals.push({
      id: `candidate:${domain}:${canonicalHash(actions).slice(0, 20)}`,
      baseFingerprint: seed.baseFingerprint,
      actions,
      domain,
      parentIds: [seed.id],
      estimatedCost: totalCost,
      metadata: {
        ...metadata,
        description,
        proposalId: id,
        graphNodeIds: [...new Set([
          ...candidateGraphNodeIds(seed),
          ...metadataGraphNodeIds(metadata),
        ])].sort(),
      },
    });
  };

  if (domain === "gear") {
    for (const item of state.proposalInputs?.gear ?? []) {
      const payload = {
        slot: item.slot,
        itemId: item.itemId,
        ...(item.itemSetId !== undefined ? { itemSetId: item.itemSetId } : {}),
      };
      add(item.id, item.description ?? `Equip existing item ${item.itemId} in ${item.slot}`, {
        id: `action:${item.id}`,
        kind: "replaceItem",
        description: item.description ?? `Equip existing item ${item.itemId}`,
        dependsOn: [], preconditions: [], reversible: true, payload,
        ...(item.costDivine !== undefined ? { costDivine: item.costDivine } : {}),
      }, { source: "currentBuild", touches: [`gear.${item.slot}`] }, item.costDivine);
    }
  } else if (domain === "skills") {
    for (const links of state.proposalInputs?.links ?? []) {
      add(links.id, links.description ?? `Replace links for group ${links.group}`, {
        id: `action:${links.id}`,
        kind: "replaceSkillLinks",
        description: links.description ?? `Replace links for group ${links.group}`,
        dependsOn: [], preconditions: [], reversible: true,
        payload: { group: links.group, gems: links.gems },
      }, { source: "currentBuild", touches: [`skills.groups.${links.group}.links`] });
    }
  } else if (domain === "config") {
    for (const config of state.proposalInputs?.config ?? []) {
      add(config.id, config.description ?? `Set configuration ${config.name}`, {
        id: `action:${config.id}`,
        kind: "setConfig",
        description: config.description ?? `Set configuration ${config.name}`,
        dependsOn: [], preconditions: [], reversible: true,
        payload: { name: config.name, value: config.value },
      }, { source: "currentBuild", touches: [`config.${config.name}`] });
    }
  } else if (domain === "tree") {
    for (const tree of state.proposalInputs?.tree ?? []) {
      const treeActions = treeNodeActions(`action:${tree.id}`, tree.nodeIds, tree.mastery);
      add(tree.id, tree.description ?? "Apply passive tree allocation", treeActions,
        { source: "currentBuild", touches: ["tree.nodes"] });
    }
  }

  for (const entry of state.contentCatalog ?? []) {
    if (!entry.available || entry.domain !== domain) continue;
    if (entry.kind !== "currentBuild" || !entry.id.startsWith("pob:")) continue;
    const data = entry.data;
    const catalogAdd: AddProposal = (id, description, action, metadata, costDivine) =>
      add(id, description, action, { ...metadata, catalogId: entry.id }, costDivine);
    if (domain === "gear") inferCatalogGear(entry.id, data, catalogAdd);
    else if (domain === "skills") inferCatalogLinks(entry.id, data, catalogAdd);
    else if (domain === "config") inferCatalogConfig(
      entry.id,
      data,
      state.evidence ?? [],
      state.scenarioSpecs ?? [],
      catalogAdd,
    );
    else if (domain === "tree") inferCatalogTree(entry.id, data, catalogAdd);
  }
  return proposals;
}

type AddProposal = (
  id: string,
  description: string,
  action: Record<string, unknown> | readonly Record<string, unknown>[],
  metadata: Readonly<Record<string, unknown>>,
  costDivine?: number,
) => void;

function inferCatalogGear(catalogId: string, data: Readonly<Record<string, unknown>>, add: AddProposal): void {
  if (!Array.isArray(data.actionCandidates)) return;
  data.actionCandidates.forEach((candidate, index) => {
    if (!plainRecord(candidate) || candidate.kind !== "replaceItem" || !plainRecord(candidate.payload)) return;
    const payload = candidate.payload;
    if (typeof payload.slot !== "string" || !nonnegativeInteger(payload.itemId)) return;
    if (payload.itemSetId !== undefined && !positiveInteger(payload.itemSetId)) return;
    add(`${catalogId}:item:${index}`, `Equip existing item ${payload.itemId} in ${payload.slot}`, {
      id: `action:${catalogId}:item:${index}`,
      kind: "replaceItem",
      description: `Equip existing item ${payload.itemId} in ${payload.slot}`,
      dependsOn: [], preconditions: [], reversible: true,
      payload: {
        slot: payload.slot,
        itemId: payload.itemId,
        ...(payload.itemSetId !== undefined ? { itemSetId: payload.itemSetId } : {}),
      },
    }, { source: "currentBuild", touches: [`gear.${payload.slot}`] });
  });
}

function inferCatalogLinks(catalogId: string, data: Readonly<Record<string, unknown>>, add: AddProposal): void {
  if (!Array.isArray(data.groups) || !Array.isArray(data.availableGems)) return;
  const availableGems: unknown[] = data.availableGems;
  const probe = plainRecord(data.nativeLinkProbe) && data.nativeLinkProbe.complete === true
    && data.nativeLinkProbe.truncated !== true && Array.isArray(data.nativeLinkProbe.groups)
    ? data.nativeLinkProbe
    : undefined;
  if (probe === undefined) return;
  const probeGroups: unknown[] = probe.groups as unknown[];
  data.groups.forEach((group, groupIndex) => {
    if (!plainRecord(group) || !positiveInteger(group.index) || !Array.isArray(group.gems) || group.gems.length === 0) return;
    const nativeGroup = probeGroups.find((value: unknown) => plainRecord(value) && value.index === group.index);
    if (!plainRecord(nativeGroup) || nativeGroup.noSupports === true || !Array.isArray(nativeGroup.supports)) return;
    const compatibleIds = new Set(nativeGroup.supports.flatMap((value) => {
      if (!plainRecord(value) || value.available === false) return [];
      const accepted = Array.isArray(value.acceptedBy) && value.acceptedBy.length > 0
        || Array.isArray(value.acceptedByIds) && value.acceptedByIds.length > 0;
      if (!accepted) return [];
      return [value.gemId, value.grantedEffectId].filter((id): id is string => typeof id === "string");
    }));
    const supports = availableGems.filter((gem: unknown) => plainRecord(gem)
      && gem.support === true
      && typeof gem.name === "string"
      && (typeof gem.id === "string" && compatibleIds.has(gem.id)
        || typeof gem.grantedEffectId === "string" && compatibleIds.has(gem.grantedEffectId)));
    const current = group.gems.map(catalogGemPayload);
    if (current.some((gem) => gem === undefined)) return;
    const currentGems = current as Record<string, unknown>[];
    const currentNames = currentGems.map((gem) => gem.nameSpec);
    supports.slice(0, 32).forEach((support: unknown, supportIndex: number) => {
      if (!plainRecord(support) || typeof support.name !== "string" || currentNames.includes(support.name)) return;
      const gems = currentGems.map((gem) => ({ ...gem }));
      gems[gems.length - 1] = {
        nameSpec: support.name,
        level: 20,
        quality: 0,
        enabled: true,
        count: 1,
      };
      add(`${catalogId}:group:${groupIndex}:support:${supportIndex}`, `Try ${support.name} in skill group ${group.index}`, {
        id: `action:${catalogId}:group:${groupIndex}:support:${supportIndex}`,
        kind: "replaceSkillLinks",
        description: `Try ${support.name} in skill group ${group.index}`,
        dependsOn: [], preconditions: [], reversible: true,
        payload: { group: group.index, gems },
      }, { source: "currentBuild", touches: [`skills.groups.${group.index}.links`] });
    });
  });
}

function catalogGemPayload(value: unknown): Record<string, unknown> | undefined {
  if (!plainRecord(value) || typeof value.name !== "string" || value.name.length === 0) return undefined;
  const output: Record<string, unknown> = { nameSpec: value.name };
  const numericFields = [
    "level", "quality", "count", "skillPart", "skillPartCalcs", "skillStage",
    "skillStageCount", "skillStageCountCalcs",
  ];
  const booleanFields = ["enabled", "includeInFullDPS", "enableGlobal1", "enableGlobal2"];
  for (const field of numericFields) {
    const fieldValue = value[field];
    if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) output[field] = fieldValue;
  }
  for (const field of booleanFields) {
    if (typeof value[field] === "boolean") output[field] = value[field];
  }
  if (typeof value.qualityId === "string") output.qualityId = value.qualityId;
  return output;
}

function inferCatalogConfig(
  catalogId: string,
  data: Readonly<Record<string, unknown>>,
  evidence: DomainSearchState["evidence"],
  scenarios: NonNullable<DomainSearchState["scenarioSpecs"]>,
  add: AddProposal,
): void {
  if (!Array.isArray(data.conditionClaims)) return;
  data.conditionClaims.forEach((claim, index) => {
    if (!plainRecord(claim) || typeof claim.condition !== "string" || claim.current === true) return;
    const requiredScenarios = scenarios
      .filter((scenario) => scenario.profile === "sustainable" && scenario.id !== "current")
      .map((scenario) => scenario.id);
    const proven = requiredScenarios.length > 0 && requiredScenarios.every((scenarioId) =>
      evidence?.some((entry) => entry.condition === claim.condition
        && entry.scenario === scenarioId
        && entry.profile === "sustainable"
        && entry.status === "proven_sustainable"));
    if (!proven) return;
    add(`${catalogId}:condition:${index}`, `Enable proven condition ${claim.condition}`, {
      id: `action:${catalogId}:condition:${index}`,
      kind: "setConfig",
      description: `Enable proven condition ${claim.condition}`,
      dependsOn: [], preconditions: [], reversible: true,
      payload: { name: claim.condition, value: true },
    }, { source: "currentBuild", touches: [`config.${claim.condition}`] });
  });
}

function inferCatalogTree(catalogId: string, data: Readonly<Record<string, unknown>>, add: AddProposal): void {
  const budget = plainRecord(data.pointBudget) ? data.pointBudget : undefined;
  if (budget === undefined || !nonnegativeInteger(budget.remainingPassive) || !nonnegativeInteger(budget.remainingAscendancy)) return;
  const remainingPassive = budget.remainingPassive;
  const remainingAscendancy = budget.remainingAscendancy;
  if (Array.isArray(data.connectable)) {
    data.connectable.forEach((entry, index) => {
      if (!plainRecord(entry) || !positiveInteger(entry.id) || !numberArray(entry.path) || !positiveInteger(entry.pointCost)) return;
      const remaining = entry.pointPool === "ascendancy" ? remainingAscendancy : remainingPassive;
      if (typeof remaining !== "number" || entry.pointCost > remaining) return;
      const nodes = [...entry.path, entry.id].filter((nodeId, nodeIndex, all) => all.indexOf(nodeId) === nodeIndex);
      add(`${catalogId}:path:${index}`, `Allocate passive path to ${entry.id}`,
        treeNodeActions(
          `action:${catalogId}:path:${index}`,
          nodes,
          undefined,
          entry.pointPool === "ascendancy" ? "ascendancy" : "passive",
        ),
        { source: "currentBuild", touches: ["tree.nodes"] });
    });
  }
  if (Array.isArray(data.masteryCandidates)) {
    data.masteryCandidates.forEach((entry, index) => {
      if (!plainRecord(entry) || !positiveInteger(entry.nodeId) || !positiveInteger(entry.effectId)
        || !numberArray(entry.path) || !positiveInteger(entry.pointCost) || entry.pointCost > remainingPassive) return;
      const nodes = [...entry.path, entry.nodeId].filter((nodeId, nodeIndex, all) => all.indexOf(nodeId) === nodeIndex);
      add(`${catalogId}:mastery:${index}`, `Select mastery ${entry.effectId} on ${entry.nodeId}`,
        treeNodeActions(
          `action:${catalogId}:mastery:${index}`,
          nodes,
          { nodeId: entry.nodeId, effectId: entry.effectId },
          "passive",
        ), { source: "currentBuild", touches: ["tree.masteries"] });
    });
  }
}

function treeNodeActions(
  idPrefix: string,
  nodeIds: readonly number[],
  mastery?: { readonly nodeId: number; readonly effectId: number },
  pointPool: "passive" | "ascendancy" = "passive",
): Record<string, unknown>[] {
  const actions: Record<string, unknown>[] = [];
  let previous: string | undefined;
  const allocationNodes = mastery === undefined ? nodeIds : nodeIds.filter((nodeId) => nodeId !== mastery.nodeId);
  allocationNodes.forEach((nodeId, index) => {
    const id = `${idPrefix}:node:${index}`;
    actions.push({
      id, kind: "setTree", description: `Allocate passive node ${nodeId}`,
      dependsOn: previous ? [previous] : [], preconditions: [], reversible: true,
      payload: { nodeId, allocated: true, pointPool },
    });
    previous = id;
  });
  if (mastery) {
    const id = `${idPrefix}:mastery`;
    actions.push({
      id, kind: "setTree", description: `Select mastery ${mastery.effectId}`,
      dependsOn: previous ? [previous] : [], preconditions: [], reversible: true,
      payload: { nodeId: mastery.nodeId, effectId: mastery.effectId, pointPool },
    });
  }
  return actions;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function numberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(positiveInteger);
}

function candidateAllowed<Action>(
  candidate: SearchCandidate<Action>,
  domain: SearchDomain,
  objective: SearchObjective,
  state: DomainSearchState<Action>,
): boolean {
  if (!domainGraphAllows(candidate, state)) return false;
  if (domain === "config" && !configActionsProven(candidate, state)) return false;
  if (domain === "tree" && !treeActionsFitPointBudget(candidate, state)) return false;
  const policy = objective.candidatePolicy;
  if (!policy) return true;
  const lockedFields = [
    ...(policy.locks?.class ? ["class", "identity.class"] : []),
    ...(policy.locks?.ascendancy ? ["ascendancy", "identity.ascendancy"] : []),
    ...(policy.locks?.mainSkill ? ["mainSkill", "skills.mainSkill"] : []),
    ...(policy.locks?.fields ?? []),
  ];
  const touches = candidateTouches(candidate);
  if (touches.some((touch) => lockedFields.some((locked) => fieldsOverlap(touch, locked)))) return false;
  if (candidate.estimatedCost !== undefined && policy.budgetDivine !== undefined && candidate.estimatedCost > policy.budgetDivine) {
    return false;
  }
  const source = candidate.metadata?.source;
  if (source === "unique") return policy.budgetDivine !== undefined && policy.sources.uniques;
  if (source === "targetRare") return policy.budgetDivine !== undefined && policy.sources.targetRares;
  if (source === "trade") return policy.budgetDivine !== undefined && policy.sources.trade;
  if (domain === "external") return false;
  if (source === "currentBuild") return policy.sources.currentBuild;
  return source === undefined && candidate.metadata?.catalogId === undefined;
}

function treeActionsFitPointBudget<Action>(
  candidate: SearchCandidate<Action>,
  state: DomainSearchState<Action>,
): boolean {
  const pointBudget = (state.contentCatalog ?? [])
    .filter((entry) => entry.domain === "tree" && plainRecord(entry.data.pointBudget))
    .map((entry) => entry.data.pointBudget)
    .find((value) => plainRecord(value)
      && nonnegativeInteger(value.remainingPassive)
      && nonnegativeInteger(value.remainingAscendancy));
  if (!plainRecord(pointBudget)
    || !nonnegativeInteger(pointBudget.remainingPassive)
    || !nonnegativeInteger(pointBudget.remainingAscendancy)) return false;
  const passive = new Set<number>();
  const ascendancy = new Set<number>();
  for (const action of candidate.actions) {
    if (!plainRecord(action) || !plainRecord(action.payload)) continue;
    if (action.kind !== "setTree" && action.kind !== "tree.setNode" && action.kind !== "tree.setMastery") continue;
    if (!positiveInteger(action.payload.nodeId)) return false;
    const allocates = action.kind === "tree.setMastery"
      || (action.payload.effectId !== undefined)
      || action.payload.allocated === true;
    if (!allocates) continue;
    if (action.payload.pointPool === "ascendancy") ascendancy.add(action.payload.nodeId);
    else if (action.payload.pointPool === "passive") passive.add(action.payload.nodeId);
    else return false;
  }
  return passive.size <= pointBudget.remainingPassive
    && ascendancy.size <= pointBudget.remainingAscendancy;
}

function configActionsProven<Action>(
  candidate: SearchCandidate<Action>,
  state: DomainSearchState<Action>,
): boolean {
  const actions = candidate.actions.flatMap((action) => {
    if (!plainRecord(action) || (action.kind !== "setConfig" && action.kind !== "config.setInput")) return [];
    if (!plainRecord(action.payload) || typeof action.payload.name !== "string") return [{ name: "", value: undefined }];
    return [{ name: action.payload.name, value: action.payload.value }];
  });
  if (actions.length === 0) return true;
  const requiredScenarios = ["mapping", "standardBoss", "pinnacle", "uber"] as const;
  const availableScenarios = new Set((state.scenarioSpecs ?? [])
    .filter(({ profile }) => profile === "sustainable")
    .map(({ id }) => id));
  if (!requiredScenarios.every((scenario) => availableScenarios.has(scenario))) return false;
  return actions.every((action) => action.name.length > 0 && requiredScenarios.every((scenario) =>
    (state.evidence ?? []).some((entry) => {
      const evidenceValue = entry.value === undefined ? true : entry.value;
      return (entry.configKey ?? entry.condition) === action.name
        && entry.scenario === scenario
        && entry.profile === "sustainable"
        && entry.status === "proven_sustainable"
        && canonicalHash(evidenceValue) === canonicalHash(action.value);
    })));
}

function metadataGraphNodeIds(metadata: Readonly<Record<string, unknown>> | undefined): string[] {
  const ids = new Set<string>();
  if (typeof metadata?.catalogId === "string") ids.add(metadata.catalogId);
  if (Array.isArray(metadata?.graphNodeIds)) {
    for (const id of metadata.graphNodeIds) if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}

function candidateGraphNodeIds<Action>(candidate: SearchCandidate<Action>): string[] {
  return metadataGraphNodeIds(candidate.metadata);
}

function domainGraphAllows<Action>(
  candidate: SearchCandidate<Action>,
  state: DomainSearchState<Action>,
): boolean {
  const graph = state.domainGraph;
  if (graph === undefined) return true;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const active = new Set<string>(candidateGraphNodeIds(candidate));
  for (const node of graph.nodes) {
    if (node.data.active === true || node.data.current === true || node.data.selected === true) active.add(node.id);
  }
  for (const id of active) {
    if (nodes.get(id)?.data.available === false) return false;
  }
  for (const edge of graph.edges) {
    if (edge.relation === "conflicts" && active.has(edge.from) && active.has(edge.to)) return false;
    if ((edge.relation === "requires" || edge.relation === "availableIn" || edge.relation === "consumes")
      && active.has(edge.from)
      && (!active.has(edge.to) || nodes.get(edge.to)?.data.available === false)) return false;
  }
  const slotUsers = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.relation !== "usesSlot" || !active.has(edge.from)) continue;
    const users = slotUsers.get(edge.to) ?? [];
    users.push(edge.from);
    slotUsers.set(edge.to, users);
  }
  for (const users of slotUsers.values()) {
    if (users.length < 2) continue;
    const replacePairs = new Set(graph.edges
      .filter((edge) => edge.relation === "replaces")
      .map((edge) => `${edge.from}:${edge.to}`));
    const compatible = users.every((left) => users.every((right) =>
      left === right || replacePairs.has(`${left}:${right}`) || replacePairs.has(`${right}:${left}`)));
    if (!compatible) return false;
  }
  return true;
}

function candidateTouches<Action>(candidate: SearchCandidate<Action>): readonly string[] {
  const touches = new Set<string>();
  const declared = candidate.metadata?.touches;
  if (Array.isArray(declared)) {
    for (const entry of declared) if (typeof entry === "string") touches.add(entry);
  }
  for (const action of candidate.actions) {
    if (!action || typeof action !== "object") continue;
    const record = action as Record<string, unknown>;
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const values = payload as Record<string, unknown>;
    for (const key of ["target", "field", "path"]) {
      if (typeof values[key] === "string") touches.add(values[key]);
    }
    if (Array.isArray(values.fields)) {
      for (const entry of values.fields) if (typeof entry === "string") touches.add(entry);
    }
    if (record.kind === "setIdentity") {
      if (values.class !== undefined) touches.add("identity.class");
      if (values.ascendancy !== undefined) touches.add("identity.ascendancy");
      if (values.property === "class" || values.property === "ascendancy") touches.add(`identity.${values.property}`);
      if (values.property === "mainSkill" || values.property === "mainSocketGroup") touches.add("skills.mainSkill");
    }
    if ((record.kind === "setSkill" || record.kind === "replaceSkillLinks") && values.mainSkill === true) {
      touches.add("skills.mainSkill");
    }
    if (record.kind === "setSkill" && values.mainGroup !== undefined) touches.add("skills.mainSkill");
    if (record.kind === "setConfig") {
      const name = values.name ?? values.key ?? values.field;
      if (typeof name === "string") touches.add(`config.${name}`);
    }
    if (record.kind === "replaceItem" && typeof values.slot === "string") touches.add(`gear.${values.slot}`);
    if (record.kind === "replaceSkillLinks" && typeof values.group === "number") {
      touches.add(`skills.groups.${values.group}.links`);
    }
    if (record.kind === "setTree") touches.add("tree.nodes");
  }
  return [...touches];
}

function fieldsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

/** Full registry backed by normalized proposals produced at the PoB/catalog seam. */
export function createFullDomainRegistry<State extends DomainSearchState<Action>, Action = unknown>(): AdapterRegistry<State, Action> {
  const registry = new AdapterRegistry<State, Action>();
  for (const domain of SEARCH_DOMAINS) registry.register(new CatalogDomainAdapter<State, Action>(domain));
  registry.assertComplete();
  return registry;
}
