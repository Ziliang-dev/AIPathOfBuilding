describe("AIPathOfBuilding Lua core", function()
	local BuildAction = require("Modules.AIPoB.BuildAction")
	local ConditionEvidence = require("Modules.AIPoB.ConditionEvidence")
	local ContentCatalog = require("Modules.AIPoB.ContentCatalog")
	local Metrics = require("Modules.AIPoB.Metrics")
	local Scenario = require("Modules.AIPoB.Scenario")
	local Snapshot = require("Modules.AIPoB.Snapshot")

	before_each(function()
		newBuild()
	end)

	it("captures a canonical sidecar snapshot without account state", function()
		local snapshot = assert(Snapshot.Capture(build))
		assert.are.equal(1, snapshot.schemaVersion)
		assert.is_string(snapshot.fingerprint)
		assert.is_string(snapshot.dataVersion)
		assert.is_string(snapshot.ruleset)
		assert.is_table(snapshot.metrics)
		assert.is_table(snapshot.config)
		assert.is_table(snapshot.buildState)
		assert.is_table(snapshot.gameplayFieldPaths)
		assert.is_true(#snapshot.gameplayFieldPaths > 6)
		assert.is_nil(snapshot.metrics.schemaVersion)
		assert.is_nil(snapshot.accountName)
		assert.is_nil(snapshot.oauthToken)
		assert.are.equal(snapshot.fingerprint, Snapshot.Capture(build).fingerprint)
	end)

	it("fails coverage on an unknown saved gameplay section", function()
		local paths, err = Snapshot.GameplayFieldPaths("<PathOfBuilding><Build/><UnknownGameplay value='1'/></PathOfBuilding>")
		assert.is_nil(paths)
		assert.matches("unclassified", err)
	end)

	it("drops non-finite metrics at the Lua RPC boundary", function()
		local metrics = Metrics.FromOutput({
			FullDPS = 100,
			PhysicalMaximumHitTaken = math.huge,
			FireMaximumHitTaken = -math.huge,
			ColdMaximumHitTaken = 500,
		})
		assert.are.equal(100, metrics.fullDps)
		assert.is_nil(metrics.physicalMaxHit)
		assert.is_nil(metrics.fireMaxHit)
		assert.are.equal(500, metrics.worstCaseMaxHit)
	end)

	it("loads the real PartyTab in BuildSandbox", function()
		build.partyTab.controls.editAuras:SetText("You and nearby Allies deal 10% increased Damage", false)
		local xml = assert(build:SaveDB("AIPoB test"))
		require("Modules.AIPoB.BuildSandbox")
		local sandbox = new("BuildSandbox"):BuildSandbox(xml, "Party sandbox")
		assert.is_nil(sandbox.loadError)
		assert.is_table(sandbox.partyTab.controls)
		assert.is_table(sandbox.partyTab.actor.Aura)
		assert.are.equal(build.partyTab.controls.editAuras.buf, sandbox.partyTab.controls.editAuras.buf)
	end)

	it("preserves future Build gameplay attributes and child nodes in BuildSandbox", function()
		local xml = assert(build:SaveDB("AIPoB future field test"))
		xml = xml:gsub("<Build ", "<Build newGameplay=\"future-value\" ", 1)
		xml = xml:gsub("</Build>", "<FutureMechanic enabled=\"true\"/></Build>", 1)
		require("Modules.AIPoB.BuildSandbox")
		local sandbox = new("BuildSandbox"):BuildSandbox(xml, "Future field sandbox")
		assert.is_nil(sandbox.loadError)
		local saved = assert(sandbox:SaveDB())
		local parsed = assert(common.xml.ParseXML(saved))[1]
		local savedBuild
		for _, node in ipairs(parsed) do if type(node) == "table" and node.elem == "Build" then savedBuild = node break end end
		assert.are.equal("future-value", savedBuild.attrib.newGameplay)
		local futureMechanic
		for _, node in ipairs(savedBuild) do if type(node) == "table" and node.elem == "FutureMechanic" then futureMechanic = node break end end
		assert.are.equal("true", futureMechanic.attrib.enabled)
	end)

	it("exports bounded catalog entries without import or account identity", function()
		build.importLink = "https://example.invalid/private"
		local catalog = assert(ContentCatalog.Export(build, { domains = { "ruleset", "skills", "config" }, limit = 20 }))
		local entries = ContentCatalog.ToEntries(catalog)
		assert.are.equal(3, #entries)
		local encoded = require("dkjson").encode(entries)
		assert.is_nil(encoded:find("example.invalid", 1, true))
		assert.is_nil(encoded:lower():find("oauth", 1, true))
		local fullConfig = assert(ContentCatalog.Export(build, { domains = { "config" }, limit = 1000 }))
		local foundBanner
		for _, claim in ipairs(fullConfig.domains.config.conditionClaims or { }) do
			if claim.condition == "bannerPlanted" then foundBanner = claim break end
		end
		assert.is_table(foundBanner)
		assert.are.equal("bannerPlanted", foundBanner.configKey)
	end)

	it("uses canonical scenario IDs and boss presets", function()
		local presets = Scenario.Presets()
		assert.same({ "mapping", "standardBoss", "pinnacle", "uber" }, {
			presets[1].id, presets[2].id, presets[3].id, presets[4].id,
		})
		assert.are.equal("Pinnacle", presets[3].enemyIsBoss)
		assert.are.equal("Uber", presets[4].enemyIsBoss)
		assert.are.equal("pinnacle", assert(Scenario.Create("guardianPinnacle", "sustainable")).id)
	end)

	it("ignores descriptive mapping modifiers and accepts normalized config records", function()
		local scenario = assert(Scenario.Create("mapping", "sustainable", {
			mapModifiers = { "Monsters deal extra damage", { configKey = "enemyIsBoss", value = "None" } },
			assumptions = { configInputs = { multiplierMapModEffect = 1.25, MapPrefix1 = 7 } },
		}))
		local previous = assert(Scenario.Apply(build, scenario, { }))
		assert.is_nil(build.configTab.input[1])
		assert.are.equal("None", build.configTab.input.enemyIsBoss)
		assert.are.equal(1.25, build.configTab.input.multiplierMapModEffect)
		assert.are.equal(7, build.configTab.input.MapPrefix1)
		assert.is_true(Scenario.Restore(build, previous))
	end)

	it("does not treat on-kill effects as sustainable on bosses", function()
		local mapping = assert(Scenario.Create("mapping", "sustainable"))
		local boss = assert(Scenario.Create("standardBoss", "sustainable"))
		local fact = { hasSource = true, onKill = true, uptime = 1 }
		assert.are.equal("proven_sustainable", ConditionEvidence.Classify(fact, mapping))
		assert.are.equal("proven_peak", ConditionEvidence.Classify(fact, boss))
	end)

	it("applies only evidence matching the scenario and profile", function()
		local mapping = assert(Scenario.Create("mapping", "sustainable"))
		build.configTab.input.conditionOnslaught = true
		local previous = assert(Scenario.Apply(build, mapping, {
			{
				condition = "conditionHaveTotem", configKey = "conditionHaveTotem", value = true,
				scenario = "mapping", profile = "sustainable", status = "proven_sustainable",
			},
			{
				condition = "conditionHaveTotem", configKey = "conditionHaveTotem", value = false,
				scenario = "standardBoss", profile = "sustainable", status = "proven_sustainable",
			},
		}))
		assert.is_true(build.configTab.input.conditionHaveTotem)
		assert.is_not_true(build.configTab.input.conditionOnslaught)
		assert.is_true(Scenario.Restore(build, previous))
		assert.is_true(build.configTab.input.conditionOnslaught)
	end)

	it("normalizes canonical sidecar actions and applies config safely", function()
		local action = {
			id = "config-1", kind = "setConfig", description = "Set boss",
			dependsOn = { }, preconditions = { }, reversible = true,
			payload = { name = "enemyIsBoss", value = "Uber" },
		}
		assert.is_true(BuildAction.Validate(action))
		assert.is_true(BuildAction.Apply(build, action))
		assert.are.equal("Uber", build.configTab.input.enemyIsBoss)
	end)

	it("enforces structured action fingerprint preconditions", function()
		local action = {
			id = "guarded", kind = "setConfig", description = "Guarded config",
			preconditions = { baseFingerprint = "wrong-fingerprint" },
			payload = { name = "enemyIsBoss", value = "Uber" },
		}
		local ok, err = BuildAction.Apply(build, action)
		assert.is_nil(ok)
		assert.matches("fingerprint changed", err)
	end)

	it("fails closed on unsupported action preconditions", function()
		local action = {
			id = "guarded-expression", kind = "setConfig", description = "Guarded config",
			preconditions = { "slot:Helmet:is-empty" },
			payload = { name = "enemyIsBoss", value = "Uber" },
		}
		local ok, err = BuildAction.Apply(build, action)
		assert.is_nil(ok)
		assert.matches("unsupported precondition expression", err)
		local invalid, invalidErr = BuildAction.Validate({
			version = 1, id = "guarded-object", kind = "config.setInput",
			preconditions = { expectedSlot = "Helmet" },
			payload = { name = "enemyIsBoss", value = "Uber" },
		})
		assert.is_nil(invalid)
		assert.matches("unsupported precondition", invalidErr)
	end)

	it("preserves advanced gem state when replacing links", function()
		local fake = {
			skillsTab = {
				socketGroupList = { { gemList = { } } },
				UpdateSocketGroups = function() end,
			},
		}
		local action = {
			version = 1, id = "links", kind = "skills.replaceLinks",
			payload = { group = 1, gems = { {
				nameSpec = "Fireball", level = 18, quality = 17, qualityId = "Anomalous",
				skillPart = 2, skillPartCalcs = 3, skillStage = 4, skillStageCount = 5,
				skillStageCountCalcs = 6, includeInFullDPS = true,
				enableGlobal1 = false, enableGlobal2 = true,
			} } },
		}
		assert.is_true(BuildAction.Apply(fake, action))
		local gem = fake.skillsTab.socketGroupList[1].gemList[1]
		assert.are.equal(18, gem.level)
		assert.are.equal(17, gem.quality)
		assert.are.equal("Anomalous", gem.qualityId)
		assert.are.equal(2, gem.skillPart)
		assert.are.equal(3, gem.skillPartCalcs)
		assert.are.equal(4, gem.skillStage)
		assert.are.equal(5, gem.skillStageCount)
		assert.are.equal(6, gem.skillStageCountCalcs)
		assert.is_false(gem.enableGlobal1)
	end)

	it("rejects unsupported and cyclic actions", function()
		local unsupported = {
			id = "rules", kind = "setRules", description = "Convert rules", payload = { targetVersion = "future" },
		}
		local ok, err = BuildAction.Validate(unsupported)
		assert.is_nil(ok)
		assert.matches("dedicated PoB conversion", err, nil, true)
		local actions = {
			{ version = 1, id = "a", kind = "build.setProperty", dependsOn = { "b" }, payload = { property = "characterLevel", value = 90 } },
			{ version = 1, id = "b", kind = "build.setProperty", dependsOn = { "a" }, payload = { property = "characterLevel", value = 91 } },
		}
		local ordered, cycle = BuildAction.Order(actions)
		assert.is_nil(ordered)
		assert.matches("cycle", cycle)
	end)

	it("rejects and undoes passive allocations over the point budget", function()
		local node = { id = 1, type = "Normal", alloc = false, path = { } }
		node.path[1] = node
		local spec = {
			nodes = { [1] = node },
			CreateUndoState = function() return { allocated = node.alloc } end,
			RestoreUndoState = function(_, state) node.alloc = state.allocated end,
			AllocNode = function() node.alloc = true end,
			CountAllocNodes = function() return node.alloc and 123 or 122, 0, 0 end,
		}
		local fake = {
			spec = spec, treeTab = { }, characterLevel = 100, characterLevelAutoMode = false,
			calcsTab = { mainOutput = { ExtraPoints = 0 } },
		}
		local ok, err = BuildAction.Apply(fake, {
			version = 1, id = "over-budget", kind = "tree.setNode",
			payload = { nodeId = 1, allocated = true },
		})
		assert.is_nil(ok)
		assert.matches("passive point budget exceeded", err)
		assert.is_false(node.alloc)
	end)
end)

describe("AIPathOfBuilding transaction", function()
	local BuildState = require("Modules.AIPoB.BuildState")
	local Scenario = require("Modules.AIPoB.Scenario")
	local Snapshot = require("Modules.AIPoB.Snapshot")
	local Transaction = require("Modules.AIPoB.Transaction")

	local function fakeBuild(level, hasConfig)
		local object = {
			characterLevel = level,
			targetVersion = "3_0",
			outputRevision = 1,
			calcsTab = { mainOutput = { FullDPS = 100, TotalEHP = 200 } },
			spec = { curClassName = "Witch", curAscendClassName = "None" },
		}
		if hasConfig then
			object.configTab = {
				activeConfigSetId = 1,
				configSets = { [1] = { input = { enemyIsBoss = "None" } } },
				input = { enemyIsBoss = "None" },
				BuildModList = function() end,
			}
			object.configTab.input = object.configTab.configSets[1].input
		end
		function object:SaveDB()
			return string.format("<PathOfBuilding level='%d'/>", self.characterLevel)
		end
		return object
	end

	it("rolls back exact snapshot when commit apply fails after preflight", function()
		local real = fakeBuild(80, false)
		local base = assert(Snapshot.Capture(real))
		local transaction = Transaction.new(real, {
			sandboxFactory = function() return fakeBuild(80, true) end,
			rebuild = function() return true end,
			restore = function(target, xml)
				target.characterLevel = assert(tonumber(xml:match("level='(%d+)'")))
				return true
			end,
		})
		local result = transaction:Apply({
			id = "candidate", baseFingerprint = base.fingerprint,
			actions = {
				{ version = 1, id = "level", kind = "build.setProperty", payload = { property = "characterLevel", value = 90 } },
				{ version = 1, id = "config", kind = "config.setInput", dependsOn = { "level" }, payload = { name = "enemyIsBoss", value = "Boss" } },
			},
		})
		assert.is_false(result.ok)
		assert.is_true(result.rolledBack)
		assert.are.equal(80, real.characterLevel)
		assert.are.equal(base.fingerprint, Snapshot.Capture(real).fingerprint)
	end)

	it("rolls back when commit metrics differ from preflight", function()
		local real = fakeBuild(80, true)
		real.calcsTab.mainOutput.FullDPS = 101
		local base = assert(Snapshot.Capture(real))
		local transaction = Transaction.new(real, {
			sandboxFactory = function() return fakeBuild(80, true) end,
			rebuild = function() return true end,
			restore = function(target, xml)
				target.characterLevel = assert(tonumber(xml:match("level='(%d+)'")))
				return true
			end,
		})
		local result = transaction:Apply({
			id = "candidate", baseFingerprint = base.fingerprint,
			actions = { { version = 1, id = "level", kind = "build.setProperty", payload = { property = "characterLevel", value = 90 } } },
		})
		assert.is_false(result.ok)
		assert.is_true(result.rolledBack)
		assert.matches("metric mismatch", result.error)
		assert.are.equal(base.fingerprint, Snapshot.Capture(real).fingerprint)
	end)

	it("rolls back when final sustainable scenario verification fails", function()
		local real = fakeBuild(80, true)
		local base = assert(Snapshot.Capture(real))
		local transaction = Transaction.new(real, {
			sandboxFactory = function() return fakeBuild(80, true) end,
			rebuild = function() return true end,
			restore = function(target, xml)
				target.characterLevel = assert(tonumber(xml:match("level='(%d+)'")))
				return true
			end,
			verifyScenarios = function() return nil, "injected scenario mismatch" end,
		})
		local result = transaction:Apply({
			id = "scenario-failure", baseFingerprint = base.fingerprint,
			actions = { { version = 1, id = "level", kind = "build.setProperty", payload = { property = "characterLevel", value = 90 } } },
		})
		assert.is_false(result.ok)
		assert.is_true(result.rolledBack)
		assert.are.equal("finalScenarioVerify", result.stage)
		assert.matches("scenario mismatch", result.error)
		assert.are.equal(base.fingerprint, Snapshot.Capture(real).fingerprint)
	end)

	it("replays the exact run scenarios during final verification", function()
		local real = fakeBuild(80, true)
		local transaction = Transaction.new(real, {
			sandboxFactory = function() return fakeBuild(80, true) end,
			rebuild = function(target)
				local input = target.configTab.input
				if input.enemyIsBoss == "None" and input.MapPrefix1 == "Enraged" then
					target.calcsTab.mainOutput.FullDPS = 111
				elseif input.presetBossSkills == "Slam" and input.enemyIsBoss == "Boss" then
					target.calcsTab.mainOutput.FullDPS = 122
				elseif input.presetBossSkills == "Slam" and input.enemyIsBoss == "Pinnacle" then
					target.calcsTab.mainOutput.FullDPS = 133
				elseif input.presetBossSkills == "Slam" and input.enemyIsBoss == "Uber" then
					target.calcsTab.mainOutput.FullDPS = 144
				else
					return nil, "exact scenario inputs were not applied"
				end
				return true
			end,
		})
		local scenarios = {
			assert(Scenario.Create("mapping", "sustainable", { assumptions = { configInputs = { MapPrefix1 = "Enraged" } } })),
			assert(Scenario.Create("standardBoss", "sustainable", { bossSkillPreset = "Slam" })),
			assert(Scenario.Create("pinnacle", "sustainable", { bossSkillPreset = "Slam" })),
			assert(Scenario.Create("uber", "sustainable", { bossSkillPreset = "Slam" })),
		}
		local candidate = { scenarioMetrics = {
			mapping = { FullDPS = 111 }, standardBoss = { FullDPS = 122 },
			pinnacle = { FullDPS = 133 }, uber = { FullDPS = 144 },
		} }
		local verified, actual = transaction:VerifyScenarios(candidate, "<PathOfBuilding/>", scenarios)
		assert.is_true(verified)
		assert.are.equal(111, actual.mapping.FullDPS)
		local missing, missingErr = transaction:VerifyScenarios(candidate, "<PathOfBuilding/>", { scenarios[1] })
		assert.is_nil(missing)
		assert.matches("missing sustainable transaction scenario", missingErr)
	end)

	it("rolls back when a commit callback throws", function()
		local real = fakeBuild(80, true)
		local base = assert(Snapshot.Capture(real))
		local transaction = Transaction.new(real, {
			sandboxFactory = function() return fakeBuild(80, true) end,
			rebuild = function(target)
				if target == real then error("injected rebuild exception") end
				return true
			end,
			restore = function(target, xml)
				target.characterLevel = assert(tonumber(xml:match("level='(%d+)'")))
				return true
			end,
		})
		local result = transaction:Apply({
			id = "exception-failure", baseFingerprint = base.fingerprint,
			actions = { { version = 1, id = "level", kind = "build.setProperty", payload = { property = "characterLevel", value = 90 } } },
		})
		assert.is_false(result.ok)
		assert.is_true(result.rolledBack)
		assert.are.equal("rebuild.exception", result.stage)
		assert.matches("injected rebuild exception", result.error)
		assert.are.equal(base.fingerprint, Snapshot.Capture(real).fingerprint)
	end)

	it("restores the exact full build XML after an injected commit failure", function()
		newBuild()
		build.notesTab.controls.edit:SetText("AIPoB rollback note")
		build.importTab.importLink = "rollback-test"
		build.plannerTab.controls.goalText:SetText("Preserve planner objective")
		local base = assert(Snapshot.Capture(build))
		local transaction = Transaction.new(build, {
			rebuild = function(target)
				if target == build then return nil, "injected commit failure" end
				return BuildState.Rebuild(target)
			end,
		})
		local result = transaction:Apply({
			id = "rollback-full-build", baseFingerprint = base.fingerprint,
			actions = {
				{ version = 1, id = "level", kind = "build.setProperty", payload = { property = "characterLevel", value = 90 } },
			},
		})
		assert.is_false(result.ok)
		assert.is_true(result.rolledBack)
		local restored = assert(Snapshot.Capture(build))
		assert.are.equal(base.xml, restored.xml)
		assert.are.equal(base.fingerprint, restored.fingerprint)
		assert.are.equal("AIPoB rollback note", build.notesTab.controls.edit.buf)
		assert.are.equal("Preserve planner objective", build.plannerTab.controls.goalText.buf)
	end)
end)
