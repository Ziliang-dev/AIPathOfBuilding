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
		for _, group in ipairs(probe.groups) do
			for _, skill in ipairs(group.activeSkills) do
				if skill.name == "Fireball" then foundFireball = skill break end
			end
			for _, support in ipairs(group.supports) do
				if support.name == "Spell Echo" and #support.acceptedBy > 0 then foundSpellEcho = support break end
			end
		end
		assert.is_table(foundFireball)
		assert.is_table(foundSpellEcho)
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
		local evidence = assert(NativeEvidence.Extract(build, {
			conditions = { conditionNative = { trigger = "always", uptimeKey = "NativeUptime" } },
		}))
		assert.are.equal(1, #evidence.claims)
		assert.are.equal(0.95, evidence.claims[1].sources[1].uptime)
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
