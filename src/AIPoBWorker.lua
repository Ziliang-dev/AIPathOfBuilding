#@ AIPoBWorker
---@diagnostic disable: lowercase-global

local source = debug.getinfo(1, "S").source:gsub("^@", "")
local scriptDir = source:match("^(.*)[/\\][^/\\]+$") or "."
dofile(scriptDir .. "/_SimpleGraphic.def.lua")
SetWorkDir(scriptDir)

function GetVirtualScreenSize() return 1920, 1080 end
__callbackTable__ = { }
function runCallback(name, ...)
	if __callbackTable__[name] then return __callbackTable__[name](...) end
	if __mainObject__ and __mainObject__[name] then return __mainObject__[name](__mainObject__, ...) end
end

local originalRequire = require
function require(name)
	if name == "lcurl.safe" then return end
	return originalRequire(name)
end

dofile(scriptDir .. "/Launch.lua")
__mainObject__.continuousIntegrationMode = os.getenv("CI")
runCallback("OnInit")
runCallback("OnFrame")
if __mainObject__.promptMsg then error(__mainObject__.promptMsg) end

local json = require("dkjson")
local socket = require("socket")
local BuildAction = require("Modules.AIPoB.BuildAction")
require("Modules.AIPoB.BuildSandbox")
local BuildState = require("Modules.AIPoB.BuildState")
local Metrics = require("Modules.AIPoB.Metrics")
local Scenario = require("Modules.AIPoB.Scenario")
local Snapshot = require("Modules.AIPoB.Snapshot")
local NativeLinkProbe = require("Modules.AIPoB.NativeLinkProbe")
local NativeEvidence = require("Modules.AIPoB.NativeEvidence")

local function option(name)
	for index = 1, #(arg or { }) - 1 do
		if arg[index] == name then return arg[index + 1] end
	end
end

local host = option("--aipob-worker-host")
local port = tonumber(option("--aipob-worker-port"))
local token = option("--aipob-worker-token")
local workerId = tonumber(option("--aipob-worker-id"))
if host ~= "127.0.0.1" or not port or not token or not workerId then error("invalid AIPathOfBuilding worker arguments") end

local client, createErr = socket.tcp()
if not client then error("worker socket failed: " .. tostring(createErr)) end
client:settimeout(10)
local connected, connectErr = client:connect(host, port)
if not connected then error("worker connection failed: " .. tostring(connectErr)) end
client:setoption("tcp-nodelay", true)

local function send(value)
	local text, encodeErr = json.encode(value)
	if not text then error("worker JSON encode failed: " .. tostring(encodeErr)) end
	local sent, sendErr = client:send(text .. "\n")
	if not sent then error("worker send failed: " .. tostring(sendErr)) end
end

local function finiteMetrics(metrics)
	local result = { }
	for key, value in pairs(metrics or { }) do
		if type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge then result[key] = value end
	end
	return result
end

local function evaluate(job)
	if type(job) ~= "table" or type(job.id) ~= "string" or type(job.candidateId) ~= "string" then error("worker job identifiers are invalid") end
	local payload = job.payload or { }
	if type(payload) ~= "table" then error("worker job payload is invalid") end
	local operation = payload.operation or "evaluate"
	if operation ~= "evaluate" and operation ~= "probe" then error("unsupported worker operation: " .. tostring(operation)) end
	local xml = payload.xml or payload.buildXml or job.xml
	if type(xml) ~= "string" or xml == "" then error("worker job payload is missing build XML") end
	local build = new("BuildSandbox"):BuildSandbox(xml, "AIPoB Worker")
	if build.loadError then error(build.loadError) end
	local ordered, orderErr = BuildAction.Order(payload.actions or { })
	if not ordered then error(orderErr) end
	for _, action in ipairs(ordered) do
		local ok, actionErr = BuildAction.Apply(build, action)
		if not ok then error("action " .. tostring(action.id) .. " failed: " .. tostring(actionErr)) end
	end
	local rebuilt, rebuildErr = BuildState.Rebuild(build)
	if not rebuilt then error(rebuildErr) end
	local candidateXml, saveErr = build:SaveDB()
	if not candidateXml then error(saveErr) end
	local candidateFingerprint = Snapshot.Fingerprint(candidateXml)
	if operation == "probe" then
		local linkProbe, linkErr = NativeLinkProbe.Extract(build, payload.probeOptions)
		if not linkProbe then error(linkErr) end
		local nativeEvidence, evidenceErr = NativeEvidence.Extract(build, payload.probeOptions)
		if not nativeEvidence then error(evidenceErr) end
		local evidenceByScenario = { }
		for _, spec in ipairs(payload.scenarios or { }) do
			if type(spec) == "table" and type(spec.id) == "string" then
				local scenario, scenarioErr = Scenario.Create(spec.id, spec.profile or "sustainable", spec)
				if not scenario then error(scenarioErr) end
				local scenarioBuild = new("BuildSandbox"):BuildSandbox(candidateXml, "AIPoB Evidence Probe")
				if scenarioBuild.loadError then error(scenarioBuild.loadError) end
				local applied, applyErr = Scenario.Apply(scenarioBuild, scenario, { })
				if not applied then error(applyErr) end
				local rebuiltScenario, rebuildScenarioErr = BuildState.Rebuild(scenarioBuild)
				if not rebuiltScenario then error(rebuildScenarioErr) end
				local scenarioEvidence, scenarioEvidenceErr = NativeEvidence.Extract(scenarioBuild, payload.probeOptions)
				if not scenarioEvidence then error(scenarioEvidenceErr) end
				evidenceByScenario[scenario.id .. ":" .. tostring(scenario.profile or "sustainable")] = scenarioEvidence
			end
		end
		return {
			jobId = job.id,
			candidateId = job.candidateId,
			operation = "probe",
			candidateFingerprint = candidateFingerprint,
			nativeLinkProbe = linkProbe,
			nativeEvidence = nativeEvidence,
			nativeProbeFingerprint = linkProbe.nativeProbeFingerprint or linkProbe.probeFingerprint,
			evidenceFingerprint = nativeEvidence.evidenceFingerprint or nativeEvidence.probeFingerprint,
			nativeEvidenceByScenario = evidenceByScenario,
			diagnostics = { },
		}
	end
	local metricsByScenario = { }
	local scenarioSpecs = { }
	for _, spec in ipairs(payload.scenarios or { }) do
		if type(spec) == "table" and type(spec.id) == "string" then
			scenarioSpecs[spec.id .. ":" .. tostring(spec.profile or "sustainable")] = spec
			if spec.profile == "sustainable" or scenarioSpecs[spec.id] == nil then scenarioSpecs[spec.id] = spec end
		end
	end
	for _, scenarioRef in ipairs(job.scenarios or { "mapping", "standardBoss", "pinnacle", "uber" }) do
		local scenarioId, requestedProfile = tostring(scenarioRef):match("^([^:]+):?(.*)$")
		if requestedProfile == "" then requestedProfile = "sustainable" end
		local scenario = scenarioSpecs[tostring(scenarioRef)] or scenarioSpecs[scenarioId .. ":" .. requestedProfile] or scenarioSpecs[scenarioId]
		local scenarioErr
		if scenario then
			local normalized, normalizeErr = Scenario.Create(scenario.id, scenario.profile or requestedProfile, scenario)
			scenario, scenarioErr = normalized, normalizeErr
		else
			scenario, scenarioErr = Scenario.Create(scenarioId, requestedProfile)
		end
		if not scenario then error(scenarioErr) end
		local scenarioBuild = new("BuildSandbox"):BuildSandbox(candidateXml, "AIPoB Scenario")
		if scenarioBuild.loadError then error(scenarioBuild.loadError) end
		local evidence = payload.evidence
		if type(evidence) == "table" then
			local byProfile = evidence[scenario.id .. ":" .. tostring(scenario.profile or "sustainable")]
			if type(byProfile) == "table" then
				evidence = byProfile
			elseif type(evidence[scenario.id]) == "table" then
				evidence = evidence[scenario.id]
			end
		end
		local previous, applyErr = Scenario.Apply(scenarioBuild, scenario, evidence)
		if not previous then error(applyErr) end
		local scenarioRebuilt, scenarioRebuildErr = BuildState.Rebuild(scenarioBuild)
		if not scenarioRebuilt then error(scenarioRebuildErr) end
		local metrics, metricsErr = Metrics.Capture(scenarioBuild)
		if not metrics then error(metricsErr) end
		local metricKey = scenario.profile == "sustainable" and scenario.id or scenario.id .. ":" .. scenario.profile
		metricsByScenario[metricKey] = finiteMetrics(metrics)
	end
	return {
		jobId = job.id,
		candidateId = job.candidateId,
		operation = "evaluate",
		candidateFingerprint = candidateFingerprint,
		metricsByScenario = metricsByScenario,
		diagnostics = { },
	}
end

send({ type = "hello", token = token, workerId = workerId })
client:settimeout(nil)
while true do
	local line, receiveErr = client:receive("*l")
	if not line then error("worker receive failed: " .. tostring(receiveErr)) end
	if #line > 8 * 1024 * 1024 then error("worker frame exceeds maximum size") end
	local message, _, decodeErr = json.decode(line, 1, json.null)
	if decodeErr or type(message) ~= "table" then error("worker received invalid JSON") end
	if message.type == "shutdown" then
		break
	elseif message.type == "cancel" then
		-- The process pool terminates a busy worker after cancellation. Idle cancellation is acknowledged by ignoring it.
	elseif message.type == "evaluate" then
		local ok, result = pcall(evaluate, message.job)
		if ok then
			send({ type = "result", jobId = message.job.id, result = result })
		else
			send({ type = "error", jobId = message.job and message.job.id, error = tostring(result) })
		end
	end
end
client:close()
