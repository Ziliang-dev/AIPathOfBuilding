local Util = require("Modules.AIPoB.Util")
local sha = require("sha2")

-- Extracts raw condition facts from PoB's calculated environment.  This module
-- never upgrades a condition to a proven status; the sidecar resolver decides
-- trigger legality, conflicts and the sustainable threshold.
local NativeEvidence = { SCHEMA_VERSION = 1 }

local function numeric(value)
	return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge and value or nil
end

local function outputRatios(output, prefix, result, visited)
	result = result or { }
	prefix = prefix or ""
	if type(output) ~= "table" then return result end
	visited = visited or { }
	if visited[output] then return result end
	visited[output] = true
	for _, key in ipairs(Util.sortedKeys(output or { })) do
		local raw = output[key]
		local name = tostring(key)
		local path = prefix == "" and name or prefix .. "." .. name
		if type(raw) == "table" then
			outputRatios(raw, path, result, visited)
		else
			local value = numeric(raw)
			if value and (name:find("Uptime", 1, true) or name:find("UpTimeRatio", 1, true)) then
				local ratio = value > 1 and value / 100 or value
				if ratio >= 0 then
					result[path] = math.min(1, ratio)
				end
				-- Preserve the historical top-level key for mappings that do not
				-- need actor namespaces; nested keys stay path-qualified above.
				if prefix == "" and result[name] == nil then result[name] = result[path] end
			end
		end
	end
	return result
end

local function sourceId(actor, condition, mod, index)
	local source = mod and (mod.source or mod.name)
	return table.concat({ tostring(actor), tostring(condition), tostring(source or "native"), tostring(index) }, ":")
end

local function sourceFacts(actor, condition, mods, options, ratios)
	local result = { }
	local conditionMap = type(options.conditions) == "table" and options.conditions or { }
	local mapping = type(conditionMap[condition]) == "table" and conditionMap[condition] or { }
	local orderedMods = { }
	for _, mod in ipairs(type(mods) == "table" and mods or { }) do table.insert(orderedMods, mod) end
	table.sort(orderedMods, function(left, right)
		local leftKey = tostring(left and (left.source or left.name) or "native") .. "|" .. tostring(left and left.name or "")
		local rightKey = tostring(right and (right.source or right.name) or "native") .. "|" .. tostring(right and right.name or "")
		return leftKey < rightKey
	end)
	for index, mod in ipairs(orderedMods) do
		local id = sourceId(actor, condition, mod, index)
		local source = {
			id = id,
			trigger = mapping.trigger or "unknown",
			triggerChain = mapping.triggerChain or { "native", tostring(mod and (mod.name or mod.source) or "condition") },
			confidence = tonumber(mapping.confidence) or 1,
			valid = mapping.valid ~= false,
			resourcesSustainable = mapping.resourcesSustainable ~= false,
			requiresAdds = mapping.requiresAdds == true,
			peakOnly = mapping.peakOnly == true,
			reason = mapping.reason or "PoB native condition source",
		}
		local uptime = numeric(mapping.uptime)
		if not uptime and type(mapping.uptimeKey) == "string" then uptime = numeric(ratios[mapping.uptimeKey]) end
		if uptime then
			local ratio = uptime > 1 and uptime / 100 or uptime
			if ratio >= 0 then source.uptime = math.min(1, ratio) end
		end
		table.insert(result, source)
	end
	return result
end

local function collectClaims(env, options, ratios)
	local claims = { }
	local seen = { }
	local function collect(actor, values)
		values = type(values) == "table" and values or { }
		for _, condition in ipairs(Util.sortedKeys(values or { })) do
			local mods = values[condition]
			local key = tostring(actor) .. ":" .. tostring(condition)
			if not seen[key] then
				seen[key] = true
				table.insert(claims, {
					condition = tostring(condition),
					configKey = tostring(condition),
					value = true,
					sources = sourceFacts(actor, condition, mods, options, ratios),
					actor = tostring(actor),
				})
			end
		end
	end
	collect("player", env.conditionsUsed)
	collect("minion", env.minionConditionsUsed)
	collect("enemy", env.enemyConditionsUsed)
	table.sort(claims, function(left, right)
		return left.condition == right.condition and left.actor < right.actor or left.condition < right.condition
	end)
	return claims
end

local function claimFingerprint(build, claims, ratios)
	local parts = {
		tostring(_G.version or _G.buildVersion or "unknown"),
		tostring(_G.dataVersion or build.targetVersion or "unknown"),
	}
	for _, claim in ipairs(claims) do
		table.insert(parts, tostring(claim.actor) .. ":" .. tostring(claim.condition))
		for _, source in ipairs(claim.sources or { }) do
			table.insert(parts, table.concat({
				tostring(source.id), tostring(source.trigger), tostring(source.uptime or ""),
				tostring(source.confidence), tostring(source.valid), tostring(source.reason or ""),
				table.concat(source.triggerChain or { }, ">"),
				tostring(source.resourcesSustainable), tostring(source.requiresAdds), tostring(source.peakOnly),
			}, "|"))
		end
	end
	for _, key in ipairs(Util.sortedKeys(ratios)) do table.insert(parts, tostring(key) .. "=" .. tostring(ratios[key])) end
	return sha.sha256(table.concat(parts, "\n"))
end

function NativeEvidence.Extract(build, options)
	if type(build) ~= "table" then return nil, "build is required" end
	if type(build.calcsTab) ~= "table" or type(build.calcsTab.mainEnv) ~= "table" then
		return nil, "native calculator output is unavailable"
	end
	options = type(options) == "table" and options or { }
	local ratios = outputRatios(build.calcsTab.mainOutput)
	local env = build.calcsTab.mainEnv
	local claims = collectClaims(env, options, ratios)
	local complete = type(build.calcsTab.mainOutput) == "table"
		and type(env.conditionsUsed) == "table"
		and type(env.minionConditionsUsed) == "table"
		and type(env.enemyConditionsUsed) == "table"
	local result = {
		schemaVersion = NativeEvidence.SCHEMA_VERSION,
		complete = complete,
		truncated = false,
		engineVersion = tostring(_G.version or _G.buildVersion or "unknown"),
		dataVersion = tostring(_G.dataVersion or build.targetVersion or "unknown"),
		claims = claims,
		nativeUptime = ratios,
		probeFingerprint = claimFingerprint(build, claims, ratios),
	}
	result.evidenceFingerprint = result.probeFingerprint
	return result
end

return NativeEvidence
