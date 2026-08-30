describe("AIPathOfBuilding verified mechanic Golden Build", function()
	local ContentCatalog = require("Modules.AIPoB.ContentCatalog")
	local MechanicExperiment = require("Modules.AIPoB.MechanicExperiment")
	local ModifierProjection = require("Modules.AIPoB.ModifierProjection")
	local NativeEvidence = require("Modules.AIPoB.NativeEvidence")
	local NativeLinkProbe = require("Modules.AIPoB.NativeLinkProbe")

	local function readFile(path)
		local file = assert(io.open(path, "rb"), "cannot read mechanic Golden Build: " .. path)
		local value = file:read("*a")
		file:close()
		return value
	end

	local function findItem(projection, pattern)
		for _, item in ipairs(projection.items or { }) do
			local name = tostring(item.name or item.title or item.baseName or "")
			if name:lower():find(pattern:lower(), 1, true) then return item end
		end
	end

	local function findLine(item, pattern)
		for _, line in ipairs(item and item.modifierLines or { }) do
			if tostring(line.rawText or ""):lower():find(pattern:lower(), 1, true) then return line end
		end
	end

	local function findItemWithLine(projection, pattern)
		for _, item in ipairs(projection.items or { }) do
			local line = findLine(item, pattern)
			if line then return item, line end
		end
	end

	local function findObservedSkill(observation, pattern)
		for _, skill in ipairs(observation.skills or { }) do
			if (tostring(skill.name or "") .. " " .. tostring(skill.id or "")):lower():find(pattern:lower(), 1, true) then
				return skill
			end
		end
	end

	it("extracts both contexts and the accepted Death Aura/Blight mechanism inventory", function()
		loadBuildFromXML(readFile("../spec/AIPoBGolden/3_29/user-death-aura-blight.xml"), "user-death-aura-blight")
		local projection = assert(ModifierProjection.Capture(build))
		local gloves, gloveDot = findItemWithLine(projection, "more Damage over Time")
		assert.is_table(gloves, "Golden gloves missing")
		assert.is_true(gloves.active, "ordinary equipped gloves must be active without an XML active attribute")
		assert.is_not_nil(gloveDot, "glove DoT multiplier missing")
		local infusedItem, infused = findItemWithLine(projection, "Infused Channelling")
		assert.is_table(infusedItem, "item-granted Infused Channelling source missing")
		assert.is_not_nil(infused, "item-granted Infused Channelling missing")
		assert.is_true(infusedItem.active)
		assert.is_true(infused.active)

		local body = assert(findItem(projection, "Death's Oath"), "Foulborn Death's Oath missing")
		assert.is_true(body.active)
		assert.is_true(body.state.foulborn)
		assert.is_not_nil(findLine(body, "Death Aura"))
		assert.is_not_nil(findLine(body, "Effect of Withered"))

		local probe = assert(NativeLinkProbe.Extract(build, { }))
		assert.is_true(probe.complete)
		local evidence = assert(NativeEvidence.Extract(build, { }))
		assert.is_true(evidence.complete)
		local catalog = assert(ContentCatalog.Export(build, { limit = 10000 }))
		assert.is_false(catalog.domains.tree.truncated)
		assert.is_false(catalog.domains.skills.truncated)

		local weaponSet1 = assert(MechanicExperiment.Run(build, { id = "observe-w1", context = "weaponSet1" }))
		local weaponSet2 = assert(MechanicExperiment.Run(build, { id = "observe-w2", context = "weaponSet2" }))
		assert.are.equal("weaponSet1", weaponSet1.baseline.context)
		assert.are.equal("weaponSet2", weaponSet2.baseline.context)
		assert.are_not.equal(weaponSet1.baseline.fingerprint, weaponSet2.baseline.fingerprint)

		local blight = assert(findObservedSkill(weaponSet1.baseline, "Blight"), "Blight missing")
		assert.is_true(blight.includeInFullDps)
		local deathAura = assert(findObservedSkill(weaponSet1.baseline, "Death Aura"), "Death Aura missing")
		assert.is_true(deathAura.fromItem)
		assert.are.equal(6, #deathAura.supports, "Death Aura must expose six effective native Supports")
		assert.is_not_nil(findObservedSkill(weaponSet1.baseline, "EnemyExplode"), "On Kill Explosion missing")
		assert.is_not_nil(findObservedSkill(weaponSet1.baseline, "Withering Step"), "Withering Step missing")
		assert.is_not_nil(findObservedSkill(weaponSet1.baseline, "Despair"), "Despair missing")
		assert.is_not_nil(findObservedSkill(weaponSet1.baseline, "Malevolence"), "Malevolence missing")
		assert.are.equal(9, weaponSet1.baseline.configValues.multiplierWitheredStackCount)

		local secondary = catalog.domains.actors.actorSeason.season.secondaryAscendancy
		assert.is_table(secondary, "secondary Bloodline projection missing")
		assert.is_truthy(tostring(secondary.name or secondary.id):lower():find("velka", 1, true), "Velka Bloodline missing")
		assert.is_not_nil(findItem(projection, "Thread of Hope"))
		assert.is_not_nil(findItem(projection, "Impossible Escape"))
		assert.is_not_nil(findItem(projection, "Cluster Jewel"))

		local experiment = assert(MechanicExperiment.Run(build, {
			id = "suppress-infused", context = "weaponSet1",
			intervention = {
				kind = "suppress_item_modifier", itemId = infusedItem.id,
				section = infused.section, ordinal = infused.ordinal,
			},
		}))
		local before, after = { }, { }
		for _, id in ipairs(experiment.baseline.activeModifierIds) do before[id] = true end
		for _, id in ipairs(experiment.diagnostic.activeModifierIds) do after[id] = true end
		assert.is_true(before[infused.id] == true)
		assert.is_false(after[infused.id] == true, "counterfactual must suppress only the selected source")

		local configExperiment = assert(MechanicExperiment.Run(build, {
			id = "suppress-withered-stacks", context = "weaponSet1",
			intervention = { kind = "suppress_config_source", configKey = "multiplierWitheredStackCount" },
		}))
		assert.are.equal(9, configExperiment.baseline.configValues.multiplierWitheredStackCount)
		assert.is_nil(configExperiment.diagnostic.configValues.multiplierWitheredStackCount,
			"counterfactual must reset Config to the PoB typed default")
	end)
end)
