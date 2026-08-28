describe("AIPathOfBuilding Golden corpus", function()
	local json = require("dkjson")
	local BuildState = require("Modules.AIPoB.BuildState")
	local Metrics = require("Modules.AIPoB.Metrics")
	local Scenario = require("Modules.AIPoB.Scenario")
	local Snapshot = require("Modules.AIPoB.Snapshot")
	local manifest

	local scenarioIds = { "mapping", "standardBoss", "pinnacle", "uber" }

	local function readFile(path)
		local file = assert(io.open(path, "rb"), "cannot read Golden corpus file: " .. path)
		local value = file:read("*a")
		file:close()
		return value
	end

	local function normalizePath(path)
		local result = { }
		for segment in tostring(path):gsub("%[", "."):gsub("%]", ""):gmatch("[^%.]+") do
			table.insert(result, string.lower(segment))
		end
		return result
	end

	local function matches(pattern, path)
		local patternParts = normalizePath(pattern)
		local pathParts = normalizePath(path)
		local function visit(patternIndex, pathIndex)
			if patternIndex > #patternParts then return pathIndex > #pathParts end
			local part = patternParts[patternIndex]
			if part == "**" then
				if patternIndex == #patternParts then return true end
				for index = pathIndex, #pathParts + 1 do
					if visit(patternIndex + 1, index) then return true end
				end
				return false
			end
			if pathIndex > #pathParts or (part ~= "*" and part ~= pathParts[pathIndex]) then return false end
			return visit(patternIndex + 1, pathIndex + 1)
		end
		return visit(1, 1)
	end

	local function specificity(pattern)
		local score = 0
		for _, segment in ipairs(normalizePath(pattern)) do
			if segment == "**" then
				score = score
			elseif segment == "*" then
				score = score + 1
			else
				score = score + 4
			end
		end
		return score
	end

	local function classify(path)
		if path == "Build.targetVersion" or path == "Build.gameVersion" or path == "Build.league" or path == "Build.mode" then
			return "rules"
		elseif path == "Build.mainSocketGroup" then
			return "skills"
		elseif path:match("^Build%.TimelessData%.") then
			return "tree"
		elseif path:match("^Build%.Spectre%.") then
			return "actor"
		elseif path:match("^Build") then
			return "identity"
		elseif path:match("^Config") then
			return "config"
		elseif path:match("^Party") then
			return "actor"
		elseif path:match("^Tree") then
			return "tree"
		elseif path:match("^Items") then
			return "gear"
		elseif path:match("^Skills") then
			return "skills"
		end
		return nil
	end

	local function policyForPath(policies, path)
		local selected
		for _, policy in ipairs(policies or { }) do
			if matches(policy.pattern, path) and (not selected or specificity(policy.pattern) > specificity(selected.pattern)) then
				selected = policy
			end
		end
		return selected
	end

	local function assertMetricSet(expected, actual, label)
		assert.is_table(actual, label .. " metric set missing")
		for key, expectation in pairs(expected or { }) do
			local observed = actual[key]
			assert.is_number(observed, label .. "." .. key .. " metric missing")
			local delta = math.abs(observed - expectation.value)
			local scale = math.max(math.abs(observed), math.abs(expectation.value))
			local defaults = manifest.defaults or { }
			local absTolerance = tonumber(expectation.absTolerance or defaults.absTolerance or 0.000001)
			local relTolerance = tonumber(expectation.relTolerance or defaults.relTolerance or 0.0001)
			local tolerance = absTolerance + relTolerance * scale
			assert.is_true(delta <= tolerance, label .. "." .. key .. " metric drifted")
		end
	end

	manifest = json.decode(readFile("../spec/AIPoBGolden/manifest.json"))
	assert.is_table(manifest)

	for _, spec in ipairs(manifest.builds or { }) do
		it("replays " .. spec.id .. " with policy and sustainable scenarios", function()
			local xml = readFile("../" .. spec.xmlPath)
			local projectionText = readFile("../" .. spec.projectionPath)
			local projection = assert(json.decode(projectionText))
			assert.is_nil(xml:lower():find("oauth", 1, true))
			assert.is_nil(xml:lower():find("importlink", 1, true))
			assert.is_nil(projectionText:lower():find("api_key", 1, true))
			assert.are.equal(spec.ruleset, projection.ruleset)
			assert.is_table(projection.contentCatalog)
			assert.is_true(#projection.contentCatalog > 0)
			assert.is_table(projection.candidates)
			local candidateKinds = { }
			for _, candidate in ipairs(projection.candidates) do
				for _, action in ipairs(candidate.actions or { }) do
					candidateKinds[candidate.domain .. ":" .. tostring(action.kind)] = true
				end
			end
			for _, requirement in ipairs(spec.candidateRequirements or { }) do
				for _, kind in ipairs(requirement.actionKinds or { }) do
					assert.is_true(candidateKinds[requirement.domain .. ":" .. kind] == true,
						"Golden candidate action missing: " .. requirement.domain .. ":" .. kind)
				end
			end
			loadBuildFromXML(xml, spec.id)

			local snapshot = assert(Snapshot.Capture(build))
			assert.are.equal(spec.ruleset, snapshot.ruleset)
			assert.are.equal(spec.dataVersion, snapshot.dataVersion)
			assert.is_table(snapshot.gameplayFieldPaths)
			for _, path in ipairs(snapshot.gameplayFieldPaths) do
				local policy = policyForPath(spec.fieldPolicies, path)
				assert.is_table(policy, "field policy missing for " .. path)
				assert.are.equal(classify(path), policy.domain, "field policy domain mismatch for " .. path)
			end

			assertMetricSet(spec.baselineMetrics, snapshot.metrics, spec.id .. ".baseline")
			for _, scenarioId in ipairs(scenarioIds) do
				local scenario = assert(Scenario.Create(scenarioId, "sustainable"))
				local previous = assert(Scenario.Apply(build, scenario, { }))
				assert.is_true(assert(BuildState.Rebuild(build)))
				local metrics = assert(Metrics.Capture(build))
				assertMetricSet(spec.scenarios[scenarioId], metrics, spec.id .. "." .. scenarioId)
				assert.is_true(Scenario.Restore(build, previous))
			end
		end)
	end
end)
