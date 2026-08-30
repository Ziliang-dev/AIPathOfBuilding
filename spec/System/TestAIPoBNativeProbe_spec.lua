describe("AIPathOfBuilding native probes", function()
	local NativeEvidence = require("Modules.AIPoB.NativeEvidence")
	local NativeLinkProbe = require("Modules.AIPoB.NativeLinkProbe")

	before_each(function()
		newBuild()
	end)

	it("exports full granted-effect support identities from the native calculator", function()
		build.skillsTab:PasteSocketGroup("Fireball 20/0  1\nAdded Fire Damage 20/0  1\n")
		runCallback("OnFrame")
		local probe = assert(NativeLinkProbe.Extract(build))
		assert.is_true(probe.complete)
		assert.is_false(probe.truncated)
		assert.is_string(probe.probeFingerprint)
		assert.is_true(#probe.groups > 0)
		local foundFireball
		local foundSpellEcho
		local foundCurrentAddedFire
		for _, group in ipairs(probe.groups) do
			for _, skill in ipairs(group.activeSkills) do
				if skill.name == "Fireball" then foundFireball = skill break end
			end
			for _, support in ipairs(group.supports) do
				if support.name == "Spell Echo" and #support.acceptedBy > 0 then foundSpellEcho = support break end
			end
			for _, support in ipairs(group.currentSupports) do
				if support.name == "Added Fire Damage" then
					foundCurrentAddedFire = support
					assert.are.equal(1, support.appliesToSkillIndex)
					assert.is_string(support.appliesToSkillId)
					assert.are.equal(group.index, support.sourceGroup)
					assert.are.equal(2, support.sourceGem)
					assert.is_true(support.sourceResolved)
					break
				end
			end
		end
		assert.is_table(foundFireball)
		assert.is_table(foundSpellEcho)
		assert.is_table(foundCurrentAddedFire)
		assert.is_string(foundSpellEcho.grantedEffectId)
		assert.is_string(foundSpellEcho.id)
	end)

	it("includes secondary support granted effects and native condition facts", function()
		build.skillsTab:PasteSocketGroup("Fireball 20/0  1\n")
		runCallback("OnFrame")
		local probe = assert(NativeLinkProbe.Extract(build))
		local evidence = assert(NativeEvidence.Extract(build))
		assert.is_true(evidence.complete)
		assert.is_string(evidence.probeFingerprint)
		assert.is_table(evidence.claims)
		assert.is_table(evidence.nativeUptime)
		local hasSecondary = false
		for _, group in ipairs(probe.groups) do
			for _, support in ipairs(group.supports) do
				if support.variantId and support.grantedEffectId then hasSecondary = true break end
			end
			if hasSecondary then break end
		end
		assert.is_true(hasSecondary)
	end)

	it("uses explicitly mapped native uptime outputs without guessing condition names", function()
		local env = build.calcsTab.mainEnv
		local output = build.calcsTab.mainOutput
		local conditionsUsed = env.conditionsUsed
		local minionConditionsUsed = env.minionConditionsUsed
		local enemyConditionsUsed = env.enemyConditionsUsed
		env.conditionsUsed = { conditionNative = { { name = "Native source", source = "Item:1" } } }
		env.minionConditionsUsed = { }
		env.enemyConditionsUsed = { }
		build.calcsTab.mainOutput = { NativeUptime = 95 }
		local conditionModName = "Condition:conditionNative"
		local conditionMods = env.modDB.mods[conditionModName]
		env.modDB:NewMod(conditionModName, "FLAG", true, "Native producer")
		env.modDB.conditions.conditionNative = true
		local evidence = assert(NativeEvidence.Extract(build, {
			conditions = { conditionNative = { trigger = "always", uptimeKey = "NativeUptime" } },
		}))
		assert.are.equal(1, #evidence.claims)
		assert.is_true(evidence.claims[1].active)
		assert.is_true(evidence.claims[1].value)
		assert.are.equal(0.95, evidence.claims[1].sources[1].uptime)
		assert.matches("Native producer", evidence.claims[1].sources[1].id)
		assert.matches("Item:1", evidence.claims[1].dependencies[1].id)
		assert.is_nil(evidence.claims[1].sources[1].id:match("Item:1"))
		env.modDB.mods[conditionModName] = conditionMods
		env.modDB.conditions.conditionNative = nil
		env.enemyConditionsUsed.conditionEnemyNative = { { name = "Enemy native", source = "Enemy native" } }
		env.enemyDB.conditions.conditionEnemyNative = 9
		local enemyEvidence = assert(NativeEvidence.Extract(build))
		local enemyCondition
		for _, claim in ipairs(enemyEvidence.claims) do
			if claim.actor == "enemy" and claim.condition == "conditionEnemyNative" then enemyCondition = claim break end
		end
		assert.is_table(enemyCondition)
		assert.is_true(enemyCondition.active)
		assert.are.equal(9, enemyCondition.value)
		assert.are.equal(0, #enemyCondition.sources)
		assert.are.equal(1, #enemyCondition.dependencies)
		env.enemyConditionsUsed.conditionEnemyNative = nil
		env.enemyDB.conditions.conditionEnemyNative = nil
		build.calcsTab.mainEnv = env
		build.calcsTab.mainOutput = output
		env.conditionsUsed = conditionsUsed
		env.minionConditionsUsed = minionConditionsUsed
		env.enemyConditionsUsed = enemyConditionsUsed
	end)

	it("fails closed when native calculator output is unavailable", function()
		local original = build.calcsTab
		build.calcsTab = nil
		local probe, probeErr = NativeLinkProbe.Extract(build)
		local evidence, evidenceErr = NativeEvidence.Extract(build)
		build.calcsTab = original
		assert.is_nil(probe)
		assert.matches("unavailable", probeErr)
		assert.is_nil(evidence)
		assert.matches("unavailable", evidenceErr)
	end)
end)
