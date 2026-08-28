local BuildAction = require("Modules.AIPoB.BuildAction")
local BuildSandbox = require("Modules.AIPoB.BuildSandbox")
local BuildState = require("Modules.AIPoB.BuildState")
local Metrics = require("Modules.AIPoB.Metrics")
local Scenario = require("Modules.AIPoB.Scenario")
local Snapshot = require("Modules.AIPoB.Snapshot")

local Transaction = { SCHEMA_VERSION = 1 }
Transaction.__index = Transaction

function Transaction.new(build, options)
	assert(type(build) == "table", "build is required")
	options = options or { }
	return setmetatable({
		build = build,
		sandboxFactory = options.sandboxFactory or function(xml) return new("BuildSandbox"):BuildSandbox(xml) end,
		rebuild = options.rebuild or BuildState.Rebuild,
		restore = options.restore or BuildState.Restore,
		verify = options.verify,
		verifyScenarios = options.verifyScenarios,
	}, Transaction)
end

local function failure(stage, message, extra)
	local result = { ok = false, stage = stage, error = tostring(message) }
	for key, value in pairs(extra or { }) do result[key] = value end
	return result
end

local function applyAll(build, ordered, beforeApply)
	for index, action in ipairs(ordered) do
		if beforeApply then beforeApply(index, action) end
		local ok, err = BuildAction.Apply(build, action)
		if not ok then return nil, err, index, action.id end
	end
	return true
end

local function metricsMatch(expected, actual)
	for key, expectedValue in pairs(expected or { }) do
		local actualValue = actual and actual[key]
		if type(expectedValue) == "number" then
			if type(actualValue) ~= "number" then return nil, "commit metric missing: " .. tostring(key) end
			local scale = math.max(1, math.abs(expectedValue), math.abs(actualValue))
			if math.abs(expectedValue - actualValue) > scale * 0.000001 then
				return nil, string.format("commit metric mismatch for %s: preflight=%s commit=%s", tostring(key), tostring(expectedValue), tostring(actualValue))
			end
		elseif actualValue ~= expectedValue then
			return nil, "commit metric mismatch for " .. tostring(key)
		end
	end
	return true
end

local function exceptionText(err)
	local message = tostring(err)
	if debug and type(debug.traceback) == "function" then return debug.traceback(message, 2) end
	return message
end

local function rollback(self, base, causeStage, cause, index, actionId)
	local restoreCalled, restored, restoreErr = pcall(self.restore, self.build, base.xml)
	if not restoreCalled then
		return failure("rollback.exception", restored, {
			causeStage = causeStage, cause = cause, actionIndex = index, actionId = actionId, recoverable = false,
		})
	end
	if not restored then
		return failure("rollback", restoreErr, {
			causeStage = causeStage, cause = cause, actionIndex = index, actionId = actionId, recoverable = false,
		})
	end
	local verifyCalled, rollbackMatches, rollbackErr, current = pcall(Snapshot.Verify, self.build, base.fingerprint)
	if not verifyCalled then
		return failure("rollback.verify.exception", rollbackMatches, {
			causeStage = causeStage, cause = cause, expected = base.fingerprint, recoverable = false,
		})
	end
	if not rollbackMatches then
		return failure("rollback.verify", rollbackErr, {
			causeStage = causeStage, cause = cause, expected = base.fingerprint,
			actual = current and current.fingerprint, recoverable = false,
		})
	end
	return failure(causeStage, cause or "transaction failed", {
		actionIndex = index, actionId = actionId, rolledBack = true, recoverable = true,
	})
end

local requiredScenarios = { mapping = true, standardBoss = true, pinnacle = true, uber = true }

local function validateScenarios(scenarios)
	if type(scenarios) ~= "table" then return nil, "exact sustainable scenario specs are required" end
	local seen = { }
	local validated = { }
	for _, scenario in ipairs(scenarios) do
		local id = type(scenario) == "table" and scenario.id or nil
		if not requiredScenarios[id] or scenario.profile ~= "sustainable" then
			return nil, "invalid sustainable transaction scenario: " .. tostring(id)
		end
		if seen[id] then return nil, "duplicate sustainable transaction scenario: " .. id end
		seen[id] = true
		table.insert(validated, scenario)
	end
	for id in pairs(requiredScenarios) do
		if not seen[id] then return nil, "missing sustainable transaction scenario: " .. id end
	end
	return validated
end

function Transaction:VerifyScenarios(candidate, xml, scenarios)
	if self.verifyScenarios then return self.verifyScenarios(candidate, xml, scenarios) end
	if type(candidate.scenarioMetrics) ~= "table" or next(candidate.scenarioMetrics) == nil then return true, { } end
	local validated, validateErr = validateScenarios(scenarios)
	if not validated then return nil, validateErr end
	local actualByScenario = { }
	for _, scenario in ipairs(validated) do
		local expected = candidate.scenarioMetrics[scenario.id]
		if type(expected) ~= "table" then return nil, "candidate missing sustainable scenario metrics for " .. scenario.id end
		local sandbox = self.sandboxFactory(xml)
		if not sandbox or sandbox.loadError then return nil, sandbox and sandbox.loadError or "scenario sandbox unavailable" end
		local applied, applyErr = Scenario.Apply(sandbox, scenario, candidate.evidence)
		if not applied then return nil, "scenario apply failed for " .. scenario.id .. ": " .. tostring(applyErr) end
		local rebuilt, rebuildErr = self.rebuild(sandbox)
		if not rebuilt then return nil, "scenario rebuild failed for " .. scenario.id .. ": " .. tostring(rebuildErr) end
		local actual, metricsErr = Metrics.Capture(sandbox)
		if not actual then return nil, "scenario metrics failed for " .. scenario.id .. ": " .. tostring(metricsErr) end
		local matches, matchErr = metricsMatch(expected, actual)
		if not matches then return nil, scenario.id .. " " .. tostring(matchErr) end
		actualByScenario[scenario.id] = actual
	end
	return true, actualByScenario
end

function Transaction:Preflight(candidate, baseSnapshot, ordered)
	local sandbox = self.sandboxFactory(baseSnapshot.xml)
	if not sandbox or sandbox.loadError then return failure("preflight.load", sandbox and sandbox.loadError or "sandbox unavailable") end
	local ok, err, index, actionId = applyAll(sandbox, ordered)
	if not ok then return failure("preflight.apply", err, { actionIndex = index, actionId = actionId }) end
	local rebuilt, rebuildErr = self.rebuild(sandbox)
	if not rebuilt then return failure("preflight.rebuild", rebuildErr) end
	local metrics, metricsErr = Metrics.Capture(sandbox)
	if not metrics then return failure("preflight.metrics", metricsErr) end
	if self.verify then
		local verified, verifyErr = self.verify(sandbox, candidate, metrics, "preflight")
		if not verified then return failure("preflight.verify", verifyErr or "candidate verification failed") end
	end
	return { ok = true, metrics = metrics }
end

function Transaction:Apply(candidate, scenarios)
	local base
	local stage = "validate"
	local mutated = false
	local actionIndex
	local actionId

	local function execute()
		if type(candidate) ~= "table" then return failure("validate", "candidate is required") end
		if type(candidate.actions) ~= "table" then return failure("validate", "candidate actions are required") end
		local ordered, orderErr = BuildAction.Order(candidate.actions)
		if not ordered then return failure("validate", orderErr) end

		stage = "snapshot"
		local captureErr
		base, captureErr = Snapshot.Capture(self.build)
		if not base then return failure("snapshot", captureErr) end
		if candidate.baseFingerprint and candidate.baseFingerprint ~= base.fingerprint then
			return failure("fingerprint", "build changed since candidate search", { expected = candidate.baseFingerprint, actual = base.fingerprint })
		end

		stage = "preflight"
		local preflight = self:Preflight(candidate, base, ordered)
		if not preflight.ok then return preflight end

		stage = "apply"
		mutated = true
		local ok, err
		ok, err, actionIndex, actionId = applyAll(self.build, ordered, function(index, action)
			actionIndex = index
			actionId = action.id
		end)
		if ok then
			stage = "rebuild"
			ok, err = self.rebuild(self.build)
		end
		local metrics
		if ok then
			stage = "metrics"
			metrics, err = Metrics.Capture(self.build)
			ok = metrics ~= nil
		end
		if ok then
			stage = "verify"
			ok, err = metricsMatch(preflight.metrics, metrics)
		end
		if ok and self.verify then
			stage = "verify"
			ok, err = self.verify(self.build, candidate, metrics, "commit")
		end
		if ok then
			stage = "finalSnapshot"
			local final, finalErr = Snapshot.Capture(self.build)
			if final then
				stage = "finalScenarioVerify"
				local scenariosOk, scenarioMetricsOrErr = self:VerifyScenarios(candidate, final.xml, scenarios)
				if scenariosOk then
					return {
						ok = true, schemaVersion = Transaction.SCHEMA_VERSION, candidateId = candidate.id,
						baseFingerprint = base.fingerprint, fingerprint = final.fingerprint,
						metrics = metrics, preflightMetrics = preflight.metrics,
						scenarioMetrics = scenarioMetricsOrErr,
						rollbackSnapshot = { xml = base.xml, fingerprint = base.fingerprint },
					}
				end
				ok, err = false, scenarioMetricsOrErr
			else
				ok, err = false, finalErr
			end
		end

		return rollback(self, base, stage, err, actionIndex, actionId)
	end

	local completed, result = xpcall(execute, exceptionText)
	if completed then return result end
	local exceptionStage = stage .. ".exception"
	if mutated and base then return rollback(self, base, exceptionStage, result, actionIndex, actionId) end
	return failure(exceptionStage, result)
end

function Transaction:Rollback(appliedResult, cause)
	local base = type(appliedResult) == "table" and appliedResult.rollbackSnapshot or nil
	if type(base) ~= "table" or type(base.xml) ~= "string" or type(base.fingerprint) ~= "string" then
		return failure("rollback", "successful transaction has no rollback snapshot", { cause = cause, recoverable = false })
	end
	return rollback(self, base, "audit", cause or "transaction audit failed")
end

return Transaction
