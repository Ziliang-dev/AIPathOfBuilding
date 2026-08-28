local Util = require("Modules.AIPoB.Util")
local ConditionEvidence = require("Modules.AIPoB.ConditionEvidence")
local ConfigOptions = require("Modules.ConfigOptions")

local Scenario = { SCHEMA_VERSION = 1 }

local PRESETS = {
	mapping = { id = "mapping", label = "Mapping", enemyIsBoss = "None", allowOnKill = true },
	standardBoss = { id = "standardBoss", label = "Standard Boss", enemyIsBoss = "Boss", allowOnKill = false },
	pinnacle = { id = "pinnacle", label = "Guardian/Pinnacle", enemyIsBoss = "Pinnacle", allowOnKill = false },
	uber = { id = "uber", label = "Uber Pinnacle", enemyIsBoss = "Uber", allowOnKill = false },
}

local aliases = { guardianPinnacle = "pinnacle", uberPinnacle = "uber" }
local persistentConfig = { bandit = true, pantheonMajorGod = true, pantheonMinorGod = true }

local function resetScenarioConfig(build, input)
	for _, option in ipairs(ConfigOptions) do
		if type(option.var) == "string" and not persistentConfig[option.var] then
			local default
			if build.configTab and type(build.configTab.GetDefaultState) == "function" then
				local ok, value = pcall(build.configTab.GetDefaultState, build.configTab, option.var, type(input[option.var]))
				if ok then default = value end
			elseif option.defaultState ~= nil then
				default = option.defaultState
			elseif option.type == "check" then
				default = false
			end
			input[option.var] = Util.deepCopy(default)
		end
	end
end

local function scenarioEvidence(evidenceList, scenario)
	local selected = { }
	for _, evidence in ipairs(evidenceList or { }) do
		local evidenceScenario = aliases[evidence.scenario] or evidence.scenario
		if evidenceScenario == scenario.id and evidence.profile == scenario.profile then
			table.insert(selected, evidence)
		end
	end
	return selected
end

function Scenario.Presets()
	local result = { }
	for _, id in ipairs({ "mapping", "standardBoss", "pinnacle", "uber" }) do
		local preset = Util.deepCopy(PRESETS[id])
		preset.schemaVersion = Scenario.SCHEMA_VERSION
		preset.profile = "sustainable"
		table.insert(result, preset)
	end
	return result
end

function Scenario.Create(id, profile, overrides)
	id = aliases[id] or id
	local base = PRESETS[id]
	if not base then
		return nil, "unsupported scenario preset: " .. tostring(id)
	end
	local scenario = Util.deepCopy(base)
	scenario.schemaVersion = Scenario.SCHEMA_VERSION
	scenario.profile = profile or "sustainable"
	if scenario.profile ~= "sustainable" and scenario.profile ~= "peak" then
		return nil, "unsupported scenario profile: " .. tostring(scenario.profile)
	end
	for key, value in pairs(overrides or { }) do
		if key ~= "id" and key ~= "enemyIsBoss" then
			scenario[key] = Util.deepCopy(value)
		end
	end
	return scenario
end

function Scenario.Apply(build, scenario, evidenceList)
	if type(build) ~= "table" or not build.configTab or type(build.configTab.input) ~= "table" then
		return nil, "build has no active configuration input"
	end
	if type(scenario) ~= "table" then
		return nil, "invalid scenario"
	end
	local scenarioId = aliases[scenario.id] or scenario.id
	if not PRESETS[scenarioId] then return nil, "invalid scenario" end
	local previous = Util.deepCopy(build.configTab.input)
	local input = build.configTab.input
	resetScenarioConfig(build, input)
	input.enemyIsBoss = PRESETS[scenarioId].enemyIsBoss
	if type(scenario.bossSkillPreset) == "string" and scenario.bossSkillPreset ~= "" then input.presetBossSkills = scenario.bossSkillPreset end
	if type(scenario.allowedEvents) == "table" then
		for _, event in ipairs(scenario.allowedEvents) do if event == "onKill" then scenario.allowOnKill = true end end
	end
	if scenarioId == "mapping" and type(scenario.mapModifiers) == "table" then
		for key, value in pairs(scenario.mapModifiers) do
			if type(key) == "string" and (type(value) == "string" or type(value) == "number" or type(value) == "boolean") then
				input[key] = value
			elseif type(value) == "table" and type(value.configKey) == "string" then
				input[value.configKey] = value.value
			end
		end
	end
	local assumptionConfig = type(scenario.assumptions) == "table"
		and (scenario.assumptions.configInputs or scenario.assumptions.config)
	if type(assumptionConfig) == "table" then
		for key, value in pairs(assumptionConfig) do
			if type(key) == "string" and (type(value) == "string" or type(value) == "number" or type(value) == "boolean") then input[key] = value end
		end
	end
	if scenario.profile == "sustainable" then
		ConditionEvidence.ApplySustainable(input, scenarioEvidence(evidenceList, scenario))
	elseif scenario.profile == "peak" then
		for _, evidence in ipairs(scenarioEvidence(evidenceList, scenario)) do
			local configKey = evidence.configKey or evidence.condition
			if (evidence.status == ConditionEvidence.STATUS.PROVEN_SUSTAINABLE or evidence.status == ConditionEvidence.STATUS.PROVEN_PEAK or evidence.status == ConditionEvidence.STATUS.INTERMITTENT) and configKey then
				input[configKey] = evidence.value == nil and true or evidence.value
			end
		end
	end
	if type(build.configTab.BuildModList) == "function" then
		build.configTab:BuildModList()
	end
	build.buildFlag = true
	return previous
end

function Scenario.Restore(build, previous)
	if not build.configTab then
		return nil, "build has no configuration tab"
	end
	build.configTab.input = Util.deepCopy(previous or { })
	if build.configTab.configSets and build.configTab.activeConfigSetId and build.configTab.configSets[build.configTab.activeConfigSetId] then
		build.configTab.configSets[build.configTab.activeConfigSetId].input = build.configTab.input
	end
	if type(build.configTab.BuildModList) == "function" then
		build.configTab:BuildModList()
	end
	build.buildFlag = true
	return true
end

return Scenario
