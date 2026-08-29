-- Portable/update path resolution for the repository-style package layout.

local UpdatePaths = { }

local function usablePath(primary, fallback, default)
	if type(primary) == "string" and primary ~= "" then return primary end
	if type(fallback) == "string" and fallback ~= "" then return fallback end
	return default
end

local function addCandidate(candidates, seen, path)
	if type(path) == "string" and path ~= "" and not seen[path] then
		seen[path] = true
		table.insert(candidates, path)
	end
end

function UpdatePaths.Resolve(xml, api)
	api = api or _G
	local scriptPath, scriptFallback = api.GetScriptPath()
	scriptPath = usablePath(scriptPath, scriptFallback, ".")
	local runtimePath, runtimeFallback = api.GetRuntimePath()
	runtimePath = usablePath(runtimePath, runtimeFallback, scriptPath)
	local workPath = usablePath(api.GetWorkDir and api.GetWorkDir(), nil, scriptPath)

	local candidates, seen = { }, { }
	addCandidate(candidates, seen, scriptPath)
	addCandidate(candidates, seen, workPath)
	addCandidate(candidates, seen, scriptPath .. "/..")
	for _, installPath in ipairs(candidates) do
		local manifestPath = installPath .. "/manifest.xml"
		local manifest = xml.LoadXMLFile(manifestPath)
		if manifest and manifest[1] and manifest[1].elem == "PoBVersion" then
			return {
				scriptPath = scriptPath,
				runtimePath = runtimePath,
				workPath = workPath,
				installPath = installPath,
				manifestPath = manifestPath,
				updatePath = workPath .. "/Update",
			}, manifest
		end
	end

	return {
		scriptPath = scriptPath,
		runtimePath = runtimePath,
		workPath = workPath,
		installPath = workPath,
		manifestPath = workPath .. "/manifest.xml",
		updatePath = workPath .. "/Update",
	}, nil
end

function UpdatePaths.FilePath(paths, name, part)
	local localName = name:gsub("{space}", " ")
	local basePath
	if part == "runtime" then
		basePath = paths.runtimePath
	elseif part == "program" or part == "tree" then
		basePath = paths.scriptPath
	else
		basePath = paths.installPath
	end
	return basePath .. "/" .. localName
end

return UpdatePaths
