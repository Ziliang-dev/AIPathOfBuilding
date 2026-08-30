import { describe, expect, it } from "vitest";
import { analyzeBuildMechanics } from "../src/domain/mechanics.js";
import { BuildSnapshotSchema } from "../src/schemas.js";

const projectionFingerprint = `sha256:${"a".repeat(64)}`;

function snapshot(legality: "valid" | "invalid" = "valid") {
  return BuildSnapshotSchema.parse({
    schemaVersion: 4,
    xml: "<PathOfBuilding/>",
    fingerprint: "vestigial-build",
    engineVersion: "test",
    dataVersion: "3.29",
    ruleset: "3.29",
    metrics: {},
    config: {},
    buildState: { mainSocketGroup: 1 },
    gameplayFieldPaths: ["Build.mainSocketGroup"],
    contentCatalog: [{
      id: "pob:skills", domain: "skills", kind: "nativeProbe",
      data: { nativeLinkProbe: { groups: [{ index: 1, activeSkills: [{ id: "DeathAura", name: "Death Aura", fromItem: true }] }] } },
    }],
    mechanicProjectionFingerprint: projectionFingerprint,
    mechanicProjection: {
      version: 1,
      inventory: { version: 1, sections: ["explicit"], lineFlags: ["vestigial"], sourceFamilies: [{ name: "Vestigial", modifierCount: 1 }] },
      modifierCount: 2,
      activeModifierCount: 1,
      unresolvedModifierCount: 0,
      descriptions: { entries: [], truncated: false },
      fingerprint: projectionFingerprint,
      items: [{
        id: "26", name: "Ambu's Charge", type: "Body Armour", equipped: true, active: true,
        references: [{ itemSetId: "1", slot: "Body Armour", active: true }], state: {},
        legality: {
          version: 1, status: legality,
          findings: legality === "valid" ? [] : [{ status: "invalid", code: "vestigial_donor_mismatch", reason: "donor invalid", lineId: "vestigial-1" }],
        },
        modifierLines: [{
          id: "item:26:explicit:1", section: "explicit", ordinal: 1,
          rawText: "Trigger Level 20 Death Aura when Equipped", active: true, disabled: false,
          flags: ["vestigial"], modTags: [], parseStatus: "parsed",
          provenance: { sourceFamily: "Vestigial", sourceTable: "Vestigial", donorItem: "Death's Oath", resolution: "exact", evidence: ["vestigialModMappings"] },
          parsedMods: [{ name: "ExtraSkill", type: "ExtraSkill", classification: "structured", value: { skillId: "DeathAura", skillName: "Death Aura", level: 20 }, flags: 0, keywordFlags: 0, tags: [] }],
        }],
      }, {
        id: "99", name: "Foulborn Death's Oath", type: "Body Armour", equipped: false, active: false,
        references: [{ itemSetId: "2", slot: "Body Armour", active: false }], state: {},
        legality: { version: 1, status: "valid", findings: [] },
        modifierLines: [{
          id: "item:99:explicit:1", section: "explicit", ordinal: 1,
          rawText: "Trigger Level 20 Death Aura when Equipped", active: false, disabled: false,
          flags: [], modTags: [], parseStatus: "parsed",
          provenance: { sourceFamily: "Foulborn", resolution: "exact", evidence: ["inactive-item-set"] },
          parsedMods: [{ name: "ExtraSkill", type: "ExtraSkill", classification: "structured", value: { skillId: "DeathAura" }, flags: 0, keywordFlags: 0, tags: [] }],
        }],
      }],
    },
  });
}

describe("Build mechanic analysis", () => {
  it("traces Vestigial item-granted skills from the active item only", () => {
    const report = analyzeBuildMechanics(snapshot());
    expect(report.status).toBe("complete");
    expect(report.understanding.mainSkills[0]).toMatchObject({
      name: "Death Aura", sourceItemId: "26", sourceModifierLineId: "item:26:explicit:1",
    });
    expect(report.understanding.verifiedChains).toContainEqual([
      "item:26", "item:26:explicit:1", "main-skill:DeathAura",
    ]);
    expect(report.understanding.criticalNodeIds).not.toContain("item:99:explicit:1");
  });

  it("blocks an invalid active Vestigial modifier", () => {
    const report = analyzeBuildMechanics(snapshot("invalid"));
    expect(report.status).toBe("blocked");
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "vestigial_donor_mismatch", severity: "blocker", critical: true,
    }));
  });

  it("does not infer condition sources from English label substrings", () => {
    const raw = structuredClone(snapshot()) as unknown as Record<string, unknown>;
    const catalog = raw.contentCatalog as Array<Record<string, unknown>>;
    catalog.push({
      id: "pob:config",
      domain: "config",
      kind: "config",
      data: {
        conditionClaims: [{
          condition: "conditionEnemyInStance",
          configKey: "conditionEnemyInStance",
          label: "Enemy Stance and Resistance",
          current: true,
          sourceStatus: "manual",
        }],
        nativeEvidence: { claims: [] },
      },
    });
    const report = analyzeBuildMechanics(BuildSnapshotSchema.parse(raw));
    expect(report.status).toBe("warning");
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "manual_condition_unproven",
      severity: "warning",
      critical: false,
    }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({ severity: "blocker" }));
  });
});
