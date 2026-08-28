local sha = require("sha2")

local Snapshot = {
	SCHEMA_VERSION = 1,
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

function Snapshot.Fingerprint(xml)
	return fingerprint(xml)
end

function Snapshot.Capture(build)
	if type(build) ~= "table" or type(build.SaveDB) ~= "function" then
		return nil, "build does not support SaveDB"
	end
	local ok, xml = pcall(build.SaveDB, build, "AIPathOfBuilding")
	if not ok then
		return nil, "SaveDB failed: " .. tostring(xml)
	end
	if type(xml) ~= "string" or xml == "" then
		return nil, "SaveDB returned no XML"
	end
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
	local gameplayFieldPaths, coverageErr = Snapshot.GameplayFieldPaths(xml)
	if not gameplayFieldPaths then return nil, coverageErr end
	return {
		schemaVersion = Snapshot.SCHEMA_VERSION,
		xml = xml,
		fingerprint = fingerprint(xml),
		engineVersion = tostring(_G.version or _G.buildVersion or "unknown"),
		dataVersion = tostring(_G.dataVersion or targetVersion),
		ruleset = targetVersion,
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
