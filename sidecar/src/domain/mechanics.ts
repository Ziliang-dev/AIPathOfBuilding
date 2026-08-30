import {
  BuildMechanicReportSchema,
  MechanicDiffSchema,
  SCHEMA_VERSION,
  type BuildMechanicReport,
  type BuildSnapshot,
  type MechanicDiff,
  type MechanicFinding,
  type ModifierLineProjection,
  type ModifierProjection,
} from "../schemas.js";
import { canonicalHash } from "../search/canonical.js";
import { DomainGraph } from "./graph.js";

interface NativeActiveSkill {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly fromItem?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mainNativeSkills(snapshot: BuildSnapshot): NativeActiveSkill[] {
  const mainGroup = Number(snapshot.buildState.mainSocketGroup ?? 1);
  const skillsEntry = snapshot.contentCatalog?.find(({ id }) => id === "pob:skills");
  const probe = record(skillsEntry?.data.nativeLinkProbe);
  const group = array(probe?.groups)
    .map(record)
    .find((entry) => Number(entry?.index) === mainGroup);
  return array(group?.activeSkills).map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

function parsedSkill(mod: ModifierLineProjection["parsedMods"][number]): { id: string; name?: string; triggered: boolean } | undefined {
  if (mod.name !== "ExtraSkill") return undefined;
  const value = record(mod.value);
  const id = value?.skillId;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  return {
    id: String(id),
    ...(typeof value?.skillName === "string" ? { name: value.skillName } : {}),
    triggered: value?.triggered === true,
  };
}

function finding(input: Omit<MechanicFinding, "id">): MechanicFinding {
  return {
    id: `finding:${canonicalHash(input).slice(0, 24)}`,
    ...input,
  };
}

function addFindingOnce(findings: MechanicFinding[], next: MechanicFinding): void {
  if (!findings.some(({ id }) => id === next.id)) findings.push(next);
}

function sourceSkillLine(
  projection: ModifierProjection,
  skill: NativeActiveSkill,
): { itemId: string; line: ModifierLineProjection } | undefined {
  const skillId = typeof skill.id === "string" || typeof skill.id === "number" ? String(skill.id) : undefined;
  const skillName = typeof skill.name === "string" ? skill.name.toLowerCase() : undefined;
  for (const item of projection.items) {
    if (!item.active) continue;
    for (const line of item.modifierLines) {
      if (!line.active) continue;
      for (const mod of line.parsedMods) {
        const extra = parsedSkill(mod);
        if (extra !== undefined && (extra.id === skillId || (extra.name !== undefined && extra.name.toLowerCase() === skillName))) {
          return { itemId: item.id, line };
        }
      }
      if (skillName !== undefined && line.rawText.toLowerCase().includes(skillName)) return { itemId: item.id, line };
    }
  }
  return undefined;
}

function configuredConditionFindings(snapshot: BuildSnapshot, projection: ModifierProjection): MechanicFinding[] {
  const configEntry = snapshot.contentCatalog?.find(({ id }) => id === "pob:config");
  const claims = array(configEntry?.data.conditionClaims).map(record).filter((claim): claim is Record<string, unknown> => claim !== undefined);
  const activeText = projection.items
    .filter(({ active }) => active)
    .flatMap(({ modifierLines }) => modifierLines.filter(({ active }) => active).map(({ rawText }) => rawText.toLowerCase()))
    .join("\n");
  const findings: MechanicFinding[] = [];
  for (const claim of claims) {
    if (claim.sourceStatus !== "manual" || claim.current === undefined || claim.current === false) continue;
    const condition = typeof claim.condition === "string" ? claim.condition : "manual-condition";
    const label = typeof claim.label === "string" ? claim.label : condition;
    const words = label.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    const critical = words.some((word) => activeText.includes(word));
    findings.push(finding({
      severity: critical ? "blocker" : "warning",
      code: "manual_condition_unproven",
      message: `${label} is configured manually without native sustainable source evidence`,
      critical,
      evidence: [`config:${condition}`],
    }));
  }
  return findings;
}

export function analyzeBuildMechanics(snapshot: BuildSnapshot): BuildMechanicReport {
  const projection = snapshot.mechanicProjection;
  if (projection.fingerprint !== snapshot.mechanicProjectionFingerprint) {
    throw new Error("Modifier projection fingerprint does not match BuildSnapshot");
  }
  const graph = new DomainGraph(snapshot.buildGraph ?? { nodes: [], edges: [] });
  const findings: MechanicFinding[] = [];
  const mainGroup = Number(snapshot.buildState.mainSocketGroup ?? 1);
  const playerId = `build:${snapshot.fingerprint.slice(0, 16)}:player`;
  graph.addNode({ id: playerId, domain: "identity", kind: "player", data: { current: true } });

  for (const item of projection.items) {
    const itemNodeId = `item:${item.id}`;
    graph.addNode({
      id: itemNodeId,
      domain: "gear",
      kind: "item",
      data: {
        name: item.name,
        baseName: item.baseName,
        type: item.type,
        rarity: item.rarity,
        active: item.active,
        legality: item.legality.status,
      },
    });
    if (item.active) graph.addEdge({ from: playerId, to: itemNodeId, relation: "usesSlot", data: {} });
    for (const legality of item.legality.findings) {
      addFindingOnce(findings, finding({
        severity: legality.status === "invalid" && item.active ? "blocker" : "warning",
        code: legality.code,
        message: legality.reason,
        itemId: item.id,
        ...(legality.lineId === undefined ? {} : { modifierLineId: `item:${item.id}:${legality.lineId}` }),
        critical: legality.status === "invalid" && item.active,
        evidence: [`item:${item.id}`, `legality:${item.legality.status}`],
      }));
    }
    for (const line of item.modifierLines) {
      graph.addNode({
        id: line.id,
        domain: "gear",
        kind: "modifierLine",
        data: {
          text: line.rawText,
          section: line.section,
          flags: line.flags,
          active: line.active,
          parseStatus: line.parseStatus,
          provenance: line.provenance,
        },
      });
      graph.addEdge({ from: itemNodeId, to: line.id, relation: "grants", data: { active: line.active } });
      if (line.provenance.donorItem !== undefined) {
        const donorId = `unique:${canonicalHash(line.provenance.donorItem).slice(0, 20)}`;
        if (!graph.hasNode(donorId)) graph.addNode({ id: donorId, domain: "gear", kind: "modifierDonor", data: { name: line.provenance.donorItem } });
        graph.addEdge({ from: donorId, to: line.id, relation: "grants", data: { sourceFamily: line.provenance.sourceFamily } });
      }
      line.parsedMods.forEach((mod, index) => {
        const modId = `${line.id}:mod:${index + 1}`;
        graph.addNode({ id: modId, domain: "gear", kind: "parsedModifier", data: mod });
        graph.addEdge({ from: line.id, to: modId, relation: "grants", data: {} });
        const extra = parsedSkill(mod);
        if (extra !== undefined) {
          const skillId = `skill:${extra.id}:item:${item.id}`;
          if (!graph.hasNode(skillId)) graph.addNode({ id: skillId, domain: "skills", kind: "itemGrantedSkill", data: { name: extra.name ?? extra.id, active: line.active } });
          graph.addEdge({ from: modId, to: skillId, relation: extra.triggered ? "triggers" : "grants", data: {} });
        }
      });
      if (item.active && line.active && (line.parseStatus === "unknown" || line.parseStatus === "partial")) {
        addFindingOnce(findings, finding({
          severity: "warning",
          code: "active_modifier_semantics_incomplete",
          message: `Active modifier is not completely parsed: ${line.rawText}`,
          itemId: item.id,
          modifierLineId: line.id,
          critical: false,
          evidence: [`parse:${line.parseStatus}`, ...line.provenance.evidence],
        }));
      }
    }
  }

  const mainSkills = mainNativeSkills(snapshot);
  const understoodSkills: Array<{ id: string; name: string; sourceItemId?: string; sourceModifierLineId?: string }> = [];
  const criticalNodeIds: string[] = [];
  const verifiedChains: string[][] = [];
  const hasNativeSkillProbe = snapshot.contentCatalog?.some(({ id }) => id === "pob:skills") === true;
  if (mainSkills.length === 0 && hasNativeSkillProbe) {
    findings.push(finding({
      severity: "blocker",
      code: "main_skill_missing",
      message: "Selected main socket group has no native active skill",
      critical: true,
      evidence: [`socket-group:${mainGroup}`],
    }));
  } else if (mainSkills.length === 0) {
    findings.push(finding({
      severity: "warning",
      code: "native_skill_probe_unavailable",
      message: "Native active-skill probe is unavailable in this snapshot",
      critical: false,
      evidence: ["catalog:pob:skills:missing"],
    }));
  }
  for (const skill of mainSkills) {
    const id = typeof skill.id === "string" || typeof skill.id === "number" ? String(skill.id) : "unknown";
    const name = typeof skill.name === "string" ? skill.name : id;
    const source = sourceSkillLine(projection, skill);
    const skillNodeId = `main-skill:${id}`;
    if (!graph.hasNode(skillNodeId)) graph.addNode({ id: skillNodeId, domain: "skills", kind: "mainSkill", data: { name, group: mainGroup, fromItem: skill.fromItem === true } });
    criticalNodeIds.push(skillNodeId);
    if (skill.fromItem === true) {
      if (source === undefined) {
        findings.push(finding({
          severity: "blocker",
          code: "item_granted_skill_source_unknown",
          message: `Item-granted main skill ${name} has no resolved modifier source`,
          critical: true,
          evidence: [`skill:${id}`, `socket-group:${mainGroup}`],
        }));
        understoodSkills.push({ id, name });
      } else {
        graph.addEdge({ from: source.line.id, to: skillNodeId, relation: source.line.parsedMods.some((mod) => record(mod.value)?.triggered === true) ? "triggers" : "grants", data: {} });
        criticalNodeIds.push(source.line.id, `item:${source.itemId}`);
        verifiedChains.push([`item:${source.itemId}`, source.line.id, skillNodeId]);
        understoodSkills.push({ id, name, sourceItemId: source.itemId, sourceModifierLineId: source.line.id });
        const existing = findings.find(({ modifierLineId }) => modifierLineId === source.line.id && modifierLineId !== undefined);
        if (existing !== undefined && existing.code === "active_modifier_semantics_incomplete") {
          existing.severity = "blocker";
          existing.critical = true;
        }
      }
    } else {
      understoodSkills.push({ id, name });
      verifiedChains.push([skillNodeId]);
    }
  }
  for (const condition of configuredConditionFindings(snapshot, projection)) addFindingOnce(findings, condition);

  findings.sort((left, right) => left.id.localeCompare(right.id));
  const status = findings.some(({ severity }) => severity === "blocker")
    ? "blocked"
    : findings.some(({ severity }) => severity === "warning") ? "warning" : "complete";
  const graphJson = graph.toJSON();
  const reportWithoutFingerprint = {
    schemaVersion: SCHEMA_VERSION,
    snapshotFingerprint: snapshot.fingerprint,
    projectionFingerprint: projection.fingerprint,
    status,
    summary: `${understoodSkills.length} main skill(s), ${projection.activeModifierCount} active modifier line(s), ${findings.length} finding(s)`,
    understanding: {
      mainSkillGroup: mainGroup,
      mainSkills: understoodSkills,
      criticalNodeIds: [...new Set(criticalNodeIds)].sort(),
      verifiedChains,
    },
    findings,
    graph: graphJson,
  } as const;
  return BuildMechanicReportSchema.parse({
    ...reportWithoutFingerprint,
    analysisFingerprint: `sha256:${canonicalHash({
      snapshot: snapshot.fingerprint,
      ruleset: snapshot.ruleset,
      dataVersion: snapshot.dataVersion,
      projection: projection.fingerprint,
      report: reportWithoutFingerprint,
    })}`,
  });
}

function lineMap(projection: ModifierProjection): Map<string, ModifierLineProjection> {
  return new Map(projection.items.flatMap(({ modifierLines }) => modifierLines.map((line) => [line.id, line] as const)));
}

export function diffMechanics(
  baseReport: BuildMechanicReport,
  base: ModifierProjection,
  candidate: ModifierProjection,
): MechanicDiff {
  const before = lineMap(base);
  const after = lineMap(candidate);
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...before.keys()].filter((id) => {
    const next = after.get(id);
    return next !== undefined && canonicalHash(before.get(id)) !== canonicalHash(next);
  }).sort();
  const critical = new Set(baseReport.understanding.criticalNodeIds);
  const criticalRemoved = removed.filter((id) => critical.has(id));
  const criticalChanged = changed.filter((id) => critical.has(id));
  const breaks = criticalRemoved.length > 0 || criticalChanged.length > 0;
  const findings = breaks ? [finding({
    severity: "blocker",
    code: "candidate_breaks_critical_mechanism",
    message: "Candidate removes or changes a modifier in the verified main-mechanism chain",
    critical: true,
    evidence: [...criticalRemoved, ...criticalChanged],
  })] : [];
  return MechanicDiffSchema.parse({
    baseProjectionFingerprint: base.fingerprint,
    candidateProjectionFingerprint: candidate.fingerprint,
    addedModifierLineIds: added,
    removedModifierLineIds: removed,
    changedModifierLineIds: changed,
    breaksCriticalMechanism: breaks,
    findings,
  });
}
