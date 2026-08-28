local sha = require("sha2")

local Snapshot = {
	SCHEMA_VERSION = 2,
}

local gameplayRoots = { Build = true, Config = true, Party = true, Tree = true, Items = true, Skills = true }
local excludedRoots = { Calcs = true, Notes = true, Import = true, AIPlanner = true, TreeView = true }

local function collectPaths(node, prefix, found)
	local path = prefix and (prefix .. "." .. node.elem) or node.elem
	if prefix then found[path] = true end
	for key in pairs(node.attrib or { }) do
		if not (path == "Build" and key == "viewMode") then found[path .. "." .. tostring(key)] = true end
	end
	for _, child in ipairs(node) do
		if type(child) == "table" and child.elem then
			collectPaths(child, path, found)
		elseif type(child) == "string" and child ~= "" then
			found[path .. ".#text"] = true
		end
	end
end

function Snapshot.GameplayFieldPaths(xml)
	local document, err = common.xml.ParseXML(xml)
	if err then return nil, tostring(err) end
	local root = document and document[1]
	if not root or root.elem ~= "PathOfBuilding" then return nil, "PathOfBuilding root element missing" end
	local found = { }
	for _, node in ipairs(root) do
		if type(node) == "table" and node.elem then
			if gameplayRoots[node.elem] then
				collectPaths(node, nil, found)
			elseif not excludedRoots[node.elem] then
				return nil, "unclassified PathOfBuilding section: " .. tostring(node.elem)
			end
		end
	end
	local paths = { }
	for path in pairs(found) do table.insert(paths, path) end
	table.sort(paths)
	return paths
end

local function fingerprint(xml)
	assert(type(xml) == "string", "snapshot XML must be a string")
	return sha.sha256(xml)
end

local function canonicalizeConfig(configNode)
	for _, configSet in ipairs(configNode) do
		if type(configSet) == "table" and configSet.elem == "ConfigSet" then
			configSet.attrib = configSet.attrib or { }
			configSet.attrib.title = configSet.attrib.title or "Default"
			local values = { }
			local remainder = { }
			for _, child in ipairs(configSet) do
				if type(child) == "table" and (child.elem == "Input" or child.elem == "Placeholder") then
					table.insert(values, child)
				else
					table.insert(remainder, child)
				end
			end
			table.sort(values, function(left, right)
				if left.elem ~= right.elem then return left.elem < right.elem end
				return tostring((left.attrib or { }).name or "") < tostring((right.attrib or { }).name or "")
			end)
			for index = #configSet, 1, -1 do configSet[index] = nil end
			for _, child in ipairs(values) do table.insert(configSet, child) end
			for _, child in ipairs(remainder) do table.insert(configSet, child) end
		end
	end
end

function Snapshot.SanitizeXML(xml)
	local document, err = common.xml.ParseXML(xml)
	if err then return nil, tostring(err) end
	local root = document and document[1]
	if not root or root.elem ~= "PathOfBuilding" then return nil, "PathOfBuilding root element missing" end
	local sanitized = { elem = "PathOfBuilding", attrib = root.attrib or { } }
	for _, node in ipairs(root) do
		if type(node) == "table" and gameplayRoots[node.elem] then
			if node.elem == "Config" then canonicalizeConfig(node) end
			table.insert(sanitized, node)
		end
	end
	local composed, composeErr = common.xml.ComposeXML(sanitized)
	if not composed then return nil, tostring(composeErr) end
	return composed
end

function Snapshot.Fingerprint(xml)
	return fingerprint(xml)
end

function Snapshot.Capture(build, options)
	if type(build) ~= "table" or type(build.SaveDB) ~= "function" then
		return nil, "build does not support SaveDB"
	end
	local ok, fullXml = pcall(build.SaveDB, build, "AIPathOfBuilding")
	if not ok then
		return nil, "SaveDB failed: " .. tostring(fullXml)
	end
	if type(fullXml) ~= "string" or fullXml == "" then
		return nil, "SaveDB returned no XML"
	end
	local xml, sanitizeErr = Snapshot.SanitizeXML(fullXml)
	if not xml then return nil, "snapshot sanitization failed: " .. tostring(sanitizeErr) end
	local metricSet = { }
	local metricsOk, Metrics = pcall(require, "Modules.AIPoB.Metrics")
	if metricsOk then
		local captured = Metrics.Capture(build)
		for key, value in pairs(captured or { }) do
			if type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge then metricSet[key] = value end
		end
	end
	local config = { }
	for key, value in pairs(build.configTab and build.configTab.input or { }) do
		if type(value) == "string" or type(value) == "number" or type(value) == "boolean" then config[key] = value end
	end
	local targetVersion = tostring(build.targetVersion or "unknown")
	local ruleset = tostring(build.spec and build.spec.treeVersion or latestTreeVersion or "unknown")
	local gameplayFieldPaths, coverageErr = Snapshot.GameplayFieldPaths(fullXml)
	if not gameplayFieldPaths then return nil, coverageErr end
	local result = {
		schemaVersion = Snapshot.SCHEMA_VERSION,
		xml = xml,
		fingerprint = fingerprint(xml),
		engineVersion = tostring(_G.version or _G.buildVersion or "unknown"),
		dataVersion = tostring(_G.dataVersion or ruleset),
		ruleset = ruleset,
		targetVersion = targetVersion,
		outputRevision = tonumber(build.outputRevision) or 0,
		metrics = metricSet,
		config = config,
		buildState = {
			level = tonumber(build.characterLevel) or 1,
			class = build.spec and build.spec.curClassName or "Unknown",
			ascendancy = build.spec and build.spec.curAscendClassName or "None",
			mainSocketGroup = tonumber(build.mainSocketGroup) or 1,
		},
		gameplayFieldPaths = gameplayFieldPaths,
	}
	if options and options.includeRollback then result.rollbackXml = fullXml end
	return result
end

function Snapshot.Verify(build, expected)
	local current, err = Snapshot.Capture(build)
	if not current then
		return false, err
	end
	local expectedFingerprint = type(expected) == "table" and expected.fingerprint or expected
	if expectedFingerprint ~= current.fingerprint then
		return false, "build fingerprint changed", current
	end
	return true, nil, current
end

return Snapshot
