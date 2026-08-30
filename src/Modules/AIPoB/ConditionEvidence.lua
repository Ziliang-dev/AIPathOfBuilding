local ConditionEvidence = {
	SCHEMA_VERSION = 1,
	STATUS = {
		PROVEN_SUSTAINABLE = "proven_sustainable",
		PROVEN_PEAK = "proven_peak",
		INTERMITTENT = "intermittent",
		MANUAL = "manual",
		IMPOSSIBLE = "impossible",
		CONFLICTING = "conflicting",
		UNKNOWN = "unknown",
	},
}

local validStatus = { }
for _, status in pairs(ConditionEvidence.STATUS) do
	validStatus[status] = true
end

function ConditionEvidence.IsValidStatus(status)
	return validStatus[status] == true
end

function ConditionEvidence.Classify(fact, scenario)
	fact = fact or { }
	scenario = scenario or { }
	if fact.conflicting then
		return ConditionEvidence.STATUS.CONFLICTING
	end
	if fact.possible == false or fact.hasSource == false then
		return ConditionEvidence.STATUS.IMPOSSIBLE
	end
	if fact.manual then
		return ConditionEvidence.STATUS.MANUAL
	end
	if fact.onKill and scenario.allowOnKill ~= true then
		return ConditionEvidence.STATUS.PROVEN_PEAK
	end
	if fact.hasSource ~= true then
		return ConditionEvidence.STATUS.UNKNOWN
	end
	local uptime = tonumber(fact.uptime)
	if uptime and uptime >= 0.9 and fact.sustainable ~= false then
		return ConditionEvidence.STATUS.PROVEN_SUSTAINABLE
	end
	if uptime and uptime > 0 then
		return ConditionEvidence.STATUS.INTERMITTENT
	end
	if fact.peak == true or fact.sustainable == false then
		return ConditionEvidence.STATUS.PROVEN_PEAK
	end
	return ConditionEvidence.STATUS.UNKNOWN
end

function ConditionEvidence.New(name, fact, scenario)
	local status = ConditionEvidence.Classify(fact, scenario)
	return {
		schemaVersion = ConditionEvidence.SCHEMA_VERSION,
		name = assert(name, "condition name is required"),
		condition = name,
		scenario = scenario and scenario.id or "current",
		profile = scenario and scenario.profile or "current",
		configKey = fact and fact.configKey,
		status = status,
		uptime = fact and tonumber(fact.uptime) or nil,
		sources = fact and fact.sources or { },
		conflicts = fact and fact.conflicts or { },
		conflictsWith = fact and fact.conflicts or { },
		triggerChain = fact and fact.triggerChain or { },
		confidence = fact and tonumber(fact.confidence) or 0,
		reason = fact and fact.reason or "PoB condition evidence",
	}
end

function ConditionEvidence.ApplySustainable(input, evidenceList)
	local applied = { }
	for _, evidence in ipairs(evidenceList or { }) do
		local configKey = evidence.configKey or evidence.condition
		if evidence.status == ConditionEvidence.STATUS.PROVEN_SUSTAINABLE and configKey then
			input[configKey] = evidence.value == nil and true or evidence.value
			table.insert(applied, configKey)
		end
	end
	return applied
end

return ConditionEvidence
