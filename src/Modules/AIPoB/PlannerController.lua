local ContentCatalog = require("Modules.AIPoB.ContentCatalog")
local RpcClient = require("Modules.AIPoB.RpcClient")
local SidecarLauncher = require("Modules.AIPoB.SidecarLauncher")
local Snapshot = require("Modules.AIPoB.Snapshot")
local Transaction = require("Modules.AIPoB.Transaction")
local TransactionJournal = require("Modules.AIPoB.TransactionJournal")
local TradeBroker = require("Modules.AIPoB.TradeBroker")

local Controller = { }
Controller.__index = Controller

local restartableStatus = {
	idle = true, completed = true, complete = true,
	failed = true, error = true, cancelled = true, canceled = true,
}

local function initialState()
	return {
		status = "idle", message = "Ready", progress = 0, runId = nil,
		candidates = { }, error = nil, preview = nil,
		sidecarStatus = "stopped", sidecarMessage = "Sidecar not started",
		providerTestStatus = "idle",
		mechanicReport = nil,
		mechanicAnalysisId = nil,
		mechanicProgress = nil,
	}
end

local function errorText(rpcError)
	if type(rpcError) == "table" then return tostring(rpcError.message or rpcError.code or "RPC error") end
	return tostring(rpcError or "unknown error")
end

local function validateAppliedResult(result)
	if type(result) ~= "table" or result.ok ~= true then return nil, "transaction did not return success" end
	if type(result.fingerprint) ~= "string" or result.fingerprint == "" then return nil, "fingerprint missing" end
	if type(result.metrics) ~= "table" then return nil, "metrics missing" end
	if type(result.scenarioMetrics) ~= "table" then return nil, "scenario metrics missing" end
	for _, scenario in ipairs({ "mapping", "standardBoss", "pinnacle", "uber" }) do
		if type(result.scenarioMetrics[scenario]) ~= "table" then return nil, scenario .. " scenario metrics missing" end
	end
	local rollback = result.rollbackSnapshot
	if type(rollback) ~= "table" or type(rollback.xml) ~= "string" or rollback.xml == ""
		or type(rollback.fingerprint) ~= "string" or rollback.fingerprint == "" then
		return nil, "rollback snapshot missing"
	end
	return true
end

function Controller.new(build, options)
	assert(type(build) == "table", "build is required")
	options = options or { }
	local self = setmetatable({
		build = build,
		options = options,
		state = initialState(),
		rpc = options.rpc,
		launcher = options.launcher,
		transaction = options.transaction or Transaction.new(build, options.transactionOptions),
		journal = options.journal or TransactionJournal.new(options.journalPath),
		pendingObjective = nil,
		pendingAnalysis = false,
		pendingTransactionResult = nil,
		pendingAppliedResult = nil,
		transactionResultEverQueued = false,
		helloComplete = false,
		shutdown = false,
	}, Controller)
	if options.tradeBroker then
		self.tradeBroker = options.tradeBroker
	else
		local tradeQuery = build.itemsTab and build.itemsTab.tradeQuery
		self.tradeBroker = TradeBroker.new({
			currencyToDivine = function(currency, amount)
				if string.lower(tostring(currency)) == "divine" then return amount end
				if tradeQuery and type(tradeQuery.ConvertCurrencyToDivs) == "function" then
					return tradeQuery:ConvertCurrencyToDivs(currency, amount)
				end
			end,
		})
	end
	local pending, journalErr = self.journal:Load()
	if pending then
		self.state.runId = pending.runId
		self.state.status = "reconnecting"
		self.state.message = "Recovering pending transaction audit"
		self.pendingTransactionResult = pending.transactionResult
		self.pendingAppliedResult = { ok = true, rollbackSnapshot = pending.rollbackSnapshot }
		self.transactionResultEverQueued = true
		self.reconnectRunId = pending.runId
		self.launchRequested = true
	elseif journalErr then
		self:_setError(journalErr)
	end
	if not self.rpc then
		local envPort = tonumber(os.getenv("AIPOB_SIDECAR_PORT") or "")
		local envToken = os.getenv("AIPOB_SIDECAR_TOKEN")
		if envPort and envToken then
			self:_createRpc({ host = "127.0.0.1", port = envPort, token = envToken })
		else
			self.launcher = self.launcher or SidecarLauncher.new(options.launcherOptions)
		end
	else
		self:_registerHandlers()
		self.state.sidecarStatus = "connecting"
		self.state.sidecarMessage = "Connecting to sidecar"
	end
	return self
end

function Controller:_setError(message)
	self.state.status = "error"
	self.state.error = tostring(message)
	self.state.message = self.state.error
end

function Controller:_setSidecarError(message)
	self.state.sidecarStatus = "failed"
	self.state.sidecarMessage = tostring(message or "Sidecar connection failed")
	if self.state.runId then
		self:_setError(self.state.sidecarMessage)
	else
		self.state.message = self.state.sidecarMessage
	end
end

function Controller:_createRpc(endpoint)
	local owner = self
	self.rpc = RpcClient.new({
		host = endpoint.host, port = endpoint.port, token = endpoint.token,
		onError = function(message) owner:_scheduleReconnect(message) end,
		onClose = function(reason)
			if not owner.shutdown and owner.launchRequested then owner:_scheduleReconnect(reason) end
		end,
	})
	self.state.sidecarStatus = "connecting"
	self.state.sidecarMessage = "Connecting to sidecar"
	self:_registerHandlers()
end

function Controller:_scheduleReconnect(reason)
	if self.shutdown or self.reconnecting then return end
	if not self.rpc and self.state.status == "reconnecting" then return end
	self.reconnecting = true
	local oldRpc = self.rpc
	self.rpc = nil
	if oldRpc and oldRpc.state ~= "closed" then pcall(oldRpc.Close, oldRpc, reason or "reconnecting") end
	self.handlersRegistered = false
	self.helloComplete = false
	self.helloPending = false
	self.reconnectRunId = self.state.runId
	self.launcher = SidecarLauncher.new(self.options.launcherOptions)
	self.launchRequested = true
	self.state.sidecarStatus = "reconnecting"
	self.state.sidecarMessage = "Reconnecting to sidecar"
	if self.state.runId or self.pendingTransactionResult then
		self.state.status = "reconnecting"
		self.state.message = self.pendingTransactionResult and "Reconciling transaction audit" or "Reconnecting to sidecar checkpoint"
	else
		self.state.message = self.state.sidecarMessage
	end
	self.reconnecting = false
end

function Controller:_resumeCheckpoint()
	local runId = self.reconnectRunId
	if not runId or not self.rpc then return end
	self.rpc:Request("run.stream", { runId = runId }, function(stream, streamErr)
		if streamErr then
			self.state.status = "reconnecting"
			self.state.message = "Checkpoint status unavailable; retrying"
			self:_scheduleReconnect(errorText(streamErr))
			return
		end
		if type(stream) == "table" and type(stream.candidates) == "table" then self.state.candidates = stream.candidates end
		local status = type(stream) == "table" and stream.status or nil
		if type(stream) == "table" and type(stream.awaitingProvider) == "table" then
			self.reconnectRunId = nil
			self.state.status = "awaitingProvider"
			self.state.providerAwaiting = stream.awaitingProvider
			self.state.message = "Checkpoint awaits LLM; Retry or Cancel"
			return
		end
		if status == "completed" then
			self.reconnectRunId = nil
			if self.pendingAppliedResult then self.pendingAppliedResult.rollbackSnapshot = nil end
			self:_clearPendingTransaction()
			self.state.status = status
			self.state.message = "Optimization checkpoint restored"
			return
		end
		if status == "failed" or status == "cancelled" then
			self.reconnectRunId = nil
			if self.pendingTransactionResult then
				self:_rollbackPendingTransaction("sidecar run is " .. status, "Transaction did not complete")
			else
				self.state.status = status
				self.state.message = "Optimization checkpoint restored"
			end
			return
		end
		if self.pendingTransactionResult then
			self.reconnectRunId = nil
			self:_sendTransactionResult()
			return
		end
		self.rpc:Request("run.resume", { runId = runId, mode = "checkpoint" }, function(result, err)
			if err then self:_setError("Checkpoint resume failed: " .. errorText(err)) return end
			self.reconnectRunId = nil
			if type(result) == "table" and type(result.candidates) == "table" then self.state.candidates = result.candidates end
			local resumedStatus = type(result) == "table" and result.status or nil
			if resumedStatus == "paused" then
				local mechanicReport = type(result) == "table" and result.mechanicReport or nil
				if type(mechanicReport) == "table" and mechanicReport.status == "blocked" then
					self.state.mechanicReport = mechanicReport
					self.state.status = "awaitingMechanicReview"
					self.state.message = "Checkpoint restored; correct critical mechanic findings"
				else
					self.state.status = "awaitingApproval"
					self.state.message = "Checkpoint restored; review verified candidates"
				end
			elseif resumedStatus == "running" then
				self.state.status = "running"
				self.state.message = "Optimization checkpoint restored"
			else
				self.state.status = resumedStatus or "error"
				self.state.message = "Optimization checkpoint restored"
			end
		end, 30000)
	end, 30000)
end

function Controller:_resumeMechanicAnalysis()
	local analysisId = self.state.mechanicAnalysisId
	if not analysisId or not self.rpc then return end
	self.rpc:Request("mechanics.status", { analysisId = analysisId }, function(result, err)
		if err then
			self:_setError("Mechanic checkpoint unavailable; select Analyze Build to resume: " .. errorText(err))
			return
		end
		local status = type(result) == "table" and result.status or "failed"
		if type(result) == "table" and type(result.progress) == "table" then
			self.state.mechanicProgress = result.progress
			self.state.progress = tonumber(result.progress.progress) or self.state.progress
		end
		if status == "completed" and type(result.report) == "table" then
			self.state.mechanicReport = result.report
			self.state.status = result.report.status
			self.state.message = result.report.summary or "Mechanic report restored"
		elseif status == "running" then
			self.state.status = "analyzingMechanics"
			self.state.message = "Mechanic analysis reconnected"
		elseif status == "cancelled" then
			self.state.status = "cancelled"
			self.state.message = "Mechanic analysis cancelled"
		else
			self:_setError("Mechanic analysis failed: " .. errorText(type(result) == "table" and result.error or status))
		end
	end, 10000)
end

function Controller:_registerHandlers()
	if not self.rpc or self.handlersRegistered then return end
	self.handlersRegistered = true
	self.rpc:Register("run.progress", function(params)
		if params.runId and self.state.runId and params.runId ~= self.state.runId then return end
		self.state.status = "running"
		self.state.progress = math.max(0, math.min(1, tonumber(params.progress) or self.state.progress))
		self.state.message = params.message or params.phase or "Optimizing"
		if type(params.candidates) == "table" then self.state.candidates = params.candidates end
	end)
	self.rpc:Register("run.mechanicsReady", function(params)
		if params.runId and self.state.runId and params.runId ~= self.state.runId then return end
		self.state.mechanicReport = params.report
		local findings = type(params.report) == "table" and params.report.findings or { }
		self.state.message = type(params.report) == "table" and params.report.summary
			or ("Mechanics understood: " .. tostring(#findings) .. " finding(s)")
	end)
	self.rpc:Register("run.awaitingMechanicReview", function(params)
		if params.runId and self.state.runId and params.runId ~= self.state.runId then return end
		self.state.mechanicReport = params.report
		self.state.status = "awaitingMechanicReview"
		self.state.message = "Critical mechanics must be corrected before optimization"
	end)
	self.rpc:Register("run.awaitingProvider", function(params)
		if params.runId and self.state.runId and params.runId ~= self.state.runId then return end
		self.state.status = "awaitingProvider"
		self.state.message = "LLM unavailable during " .. tostring(params.phase or "workflow") .. "; Retry or Cancel"
		self.state.providerAwaiting = params
	end)
	self.rpc:Register("mechanics.progress", function(params)
		if params.analysisId ~= self.state.mechanicAnalysisId then return end
		self.state.status = "analyzingMechanics"
		self.state.progress = tonumber(params.progress) or self.state.progress
		self.state.mechanicProgress = params
		self.state.message = tostring(params.phase or "Mechanics")
			.. ": " .. tostring(params.message or "Understanding Build mechanics")
			.. "; entities=" .. tostring(params.inspectedCount or 0) .. "/" .. tostring(params.entityCount or 0)
			.. "; LLM=" .. tostring(params.modelCalls or 0)
			.. "; experiments=" .. tostring(params.experimentCount or 0)
	end)
	self.rpc:Register("mechanics.completed", function(params)
		if params.analysisId ~= self.state.mechanicAnalysisId then return end
		self.state.mechanicReport = params.report
		self.state.status = type(params.report) == "table" and params.report.status or "error"
		self.state.progress = 1
		self.state.message = type(params.report) == "table" and params.report.summary or "Mechanic analysis returned no report"
	end)
	self.rpc:Register("mechanics.failed", function(params)
		if params.analysisId ~= self.state.mechanicAnalysisId then return end
		self:_setError("Mechanic analysis failed: " .. errorText(params.error))
	end)
	self.rpc:Register("run.awaitingApproval", function(params)
		if params.runId and self.state.runId and params.runId ~= self.state.runId then return end
		self.state.status = "awaitingApproval"
		self.state.progress = 1
		self.state.message = params.message or "Review verified candidates"
		self.state.candidates = params.candidates or self.state.candidates
	end)
	self.rpc:Register("run.completed", function(params)
		if params.runId and self.state.runId and params.runId ~= self.state.runId then return end
		self.state.status = "completed"
		self.state.progress = 1
		self.state.message = params.message or "Optimization complete"
		self.state.candidates = params.candidates or params.frontier or self.state.candidates
	end)
	self.rpc:Register("run.failed", function(params)
		if params.runId and self.state.runId and params.runId ~= self.state.runId then return end
		self:_setError(params.error or params.message or "Optimization failed")
	end)
	self.rpc:Register("transaction.apply", function(params)
		local candidate = params.candidate
		local candidateId = params.candidateId or (candidate and candidate.id)
		if not self.pendingApplyCandidateId or candidateId ~= self.pendingApplyCandidateId then
			self.state.preview = candidate
			self.state.status = "awaitingApproval"
			self.state.message = "Candidate ready for human approval"
			return { accepted = false, reason = "human approval required" }
		end
		if type(candidate) ~= "table" or type(candidate.actions) ~= "table" then
			return nil, "transaction.apply candidate is invalid"
		end
		self:_applyCandidate(candidate, params.scenarios)
		return { accepted = true }
	end)
	self.rpc:Register("trade.catalog.query", function(params, _, respond)
		if type(params) ~= "table" or type(params.requestId) ~= "string" or type(params.queryHash) ~= "string" then
			return nil, "Trade catalog request is invalid"
		end
		if self.state.runId and params.runId ~= self.state.runId then return nil, "Trade catalog runId does not match" end
		local objective = self.activeObjective
		if type(objective) ~= "table" or type(objective.budgetDivine) ~= "number" then
			return nil, "Trade catalog requires an active Divine budget"
		end
		local query, queryErr = TradeBroker.BuildTypedQuery(params.constraints)
		if not query then return nil, errorText(queryErr) end
		local spec = {
			requestId = params.requestId, idempotencyKey = params.queryHash,
			realm = params.realm, league = params.league, slot = params.slot,
			itemSetId = params.itemSetId, ruleset = params.ruleset,
			query = query, budgetDivine = objective.budgetDivine,
			maxResults = params.limit,
		}
		self.tradeBroker:Search(spec, function(items, brokerErr)
			if brokerErr then
				respond(nil, { code = -32040, message = errorText(brokerErr), data = { tradeCode = brokerErr.code } })
				return
			end
			local catalogItems = { }
			for _, item in ipairs(items or { }) do
				table.insert(catalogItems, {
					catalogId = item.id, queryHash = params.queryHash, ruleset = params.ruleset,
					league = params.league, slot = item.slot, itemSetId = item.itemSetId,
					itemRaw = item.itemRaw, itemHash = "sha256:" .. item.itemHash, price = item.price,
				})
			end
			local now = os.date("!%Y-%m-%dT%H:%M:%SZ")
			respond({
				runId = params.runId, requestId = params.requestId, queryHash = params.queryHash,
				fetchedAt = now, currencySnapshotAt = now, items = catalogItems, warnings = { },
			})
		end)
		return RpcClient.ASYNC
	end)
	self.rpc:Register("trade.catalog.cancel", function(params)
		if type(params) == "table" and type(params.requestId) == "string" then
			self.tradeBroker:Cancel(params.requestId)
		end
		return { cancelled = true }
	end)
end

function Controller:_hello()
	if self.helloComplete or self.helloPending or not self.rpc then return end
	self.helloPending = true
	if self.state.runId or self.pendingObjective or self.pendingTransactionResult then
		self.state.status = "connecting"
	end
	self.state.sidecarStatus = "connecting"
	self.state.sidecarMessage = "Negotiating sidecar capabilities"
	self.state.message = self.state.sidecarMessage
	self.rpc:Request("hello", {
		clientName = "pob-lua", clientVersion = tostring(_G.version or "1"),
		capabilities = { "nativeLinkProbe", "nativeEvidence", "tradeBroker", "providerConsent", "providerConnectionTest", "providerCompatibility", "objectiveDraft", "mechanicAnalysis" },
	}, function(result, err)
		self.helloPending = false
		if err then self:_setSidecarError("Sidecar handshake failed: " .. errorText(err)) return end
		self.helloComplete = true
		self.state.sidecarStatus = "connected"
		self.state.sidecarMessage = "Sidecar connected"
		self.state.sidecarCapabilities = type(result) == "table" and result.capabilities or { }
		if not self.state.runId and not self.pendingObjective and not self.pendingTransactionResult then
			self.state.status = "idle"
		end
		self.state.message = "Sidecar connected"
		self:RefreshProviderStatus()
		if self.reconnectRunId then self:_resumeCheckpoint()
		elseif self.pendingObjective then self:_captureAndStart()
		elseif self.pendingAnalysis then self:_captureAndAnalyze()
		elseif self.state.mechanicAnalysisId then self:_resumeMechanicAnalysis() end
	end, 10000)
end

function Controller:_captureAndAnalyze()
	if not self.helloComplete or not self.rpc then return end
	self.pendingAnalysis = false
	local snapshot, snapshotErr = Snapshot.Capture(self.build)
	if not snapshot then self:_setError(snapshotErr) return end
	local catalog, catalogErr = ContentCatalog.Export(self.build, { limit = 1000 })
	if not catalog then self:_setError(catalogErr) return end
	snapshot.contentCatalog = ContentCatalog.ToEntries(catalog)
	self.state.status = "analyzingMechanics"
	self.state.message = "Understanding Build mechanics"
	self.rpc:Request("build.capture", { snapshot = snapshot }, function(result, err)
		if err then self:_setError("Build capture failed: " .. errorText(err)) return end
		local fingerprint = type(result) == "table" and result.snapshotFingerprint or snapshot.fingerprint
		self.rpc:Request("mechanics.start", {
			snapshotFingerprint = fingerprint,
			contexts = { "weaponSet1", "weaponSet2" },
			force = false,
		}, function(started, analyzeErr)
			if analyzeErr then self:_setError("Mechanic analysis failed: " .. errorText(analyzeErr)) return end
			self.state.mechanicAnalysisId = type(started) == "table" and started.analysisId or nil
			self.state.status = "analyzingMechanics"
			self.state.message = "LLM analyst is reading local PoB facts"
		end, 30000)
	end, 30000)
end

function Controller:AnalyzeBuild()
	if self.shutdown then return nil, "controller is shut down" end
	self.pendingAnalysis = true
	self.launchRequested = true
	if self.helloComplete then self:_captureAndAnalyze()
	else
		self.state.status = "connecting"
		self.state.message = "Starting sidecar for mechanic analysis"
	end
	return true
end

function Controller:EnsureConnected()
	if self.shutdown then return nil, "controller is shut down" end
	if self.rpc and self.helloComplete then
		self.state.sidecarStatus = "connected"
		self.state.sidecarMessage = "Sidecar connected"
		return true
	end
	if not self.rpc and (not self.launcher or self.launcher.state == "failed" or self.launcher.state == "closed") then
		self.launcher = SidecarLauncher.new(self.options.launcherOptions)
	end
	self.launchRequested = true
	self.state.error = nil
	if self.state.status == "error" and not self.state.runId then self.state.status = "idle" end
	self.state.sidecarStatus = self.rpc and "connecting" or "starting"
	self.state.sidecarMessage = self.rpc and "Connecting to sidecar" or "Starting sidecar"
	self.state.message = self.state.sidecarMessage
	return true
end

function Controller:RefreshProviderStatus()
	if not self.rpc or not self.helloComplete then return nil, "sidecar is not connected" end
	self.rpc:Request("provider.status", { providerId = "openai" }, function(result, err)
		if err then
			self.state.providerStatus = { configured = false, credentialConfigured = false, error = errorText(err) }
			return
		end
		self.state.providerStatus = result
	end, 10000)
	return true
end

function Controller:ConfigureProvider(profile, callback)
	if not self.rpc or not self.helloComplete then return nil, "sidecar is not connected" end
	if type(profile) ~= "table" then return nil, "provider profile is required" end
	local params = {
		providerId = "openai", baseUrl = profile.baseUrl, model = profile.model,
		authMode = profile.authMode, apiMode = profile.apiMode, reasoningMode = profile.reasoningMode,
		testId = profile.testId,
	}
	if type(profile.apiKey) == "string" and profile.apiKey ~= "" then params.apiKey = profile.apiKey end
	self.rpc:Request("provider.configure", params, function(result, err)
		if err then
			self.state.providerError = "LLM configuration failed: " .. errorText(err)
			self.state.message = self.state.providerError
			if callback then callback(nil, self.state.providerError) end
			return
		end
		self.state.providerStatus = result
		self.state.providerError = nil
		self.state.providerTestStatus = "idle"
		self.state.message = "LLM configured; review and grant first-call consent"
		self:PreviewProviderConsent()
		if callback then callback(result) end
	end, 30000)
	return true
end

function Controller:PreviewProviderTest(profile, callback)
	if not self.rpc or not self.helloComplete then return nil, "sidecar is not connected" end
	if type(profile) ~= "table" then return nil, "provider profile is required" end
	local capabilities = self.state.sidecarCapabilities
	if type(capabilities) == "table" and capabilities.providerConnectionTest ~= true then
		return nil, "sidecar does not support provider connection tests"
	end
	self.state.providerTestStatus = "previewing"
	self.state.providerTestMessage = "Preparing one-time connection-test authorization"
	self.rpc:Request("provider.test.preview", {
		providerId = "openai", baseUrl = profile.baseUrl, model = profile.model,
		authMode = profile.authMode, apiMode = profile.apiMode, reasoningMode = profile.reasoningMode,
	}, function(result, err)
		if err then
			self.state.providerTestStatus = "failed"
			self.state.providerTestMessage = "Connection test preview failed: " .. errorText(err)
			if callback then callback(nil, self.state.providerTestMessage) end
			return
		end
		self.state.providerTestStatus = "awaitingConsent"
		self.state.providerTestMessage = "Review the one-time synthetic probe authorization"
		if callback then callback(result) end
	end, 10000)
	return true
end

function Controller:TestProviderConnection(profile, preview, callback)
	if not self.rpc or not self.helloComplete then return nil, "sidecar is not connected" end
	if type(profile) ~= "table" or type(preview) ~= "table" then return nil, "connection test preview is required" end
	local payload = preview.payloadPreview
	if type(preview.consentKey) ~= "string" or type(payload) ~= "table" or type(payload.redactedHash) ~= "string" then
		return nil, "connection test authorization is invalid"
	end
	local params = {
		providerId = "openai", baseUrl = profile.baseUrl, model = profile.model,
		authMode = profile.authMode, apiMode = profile.apiMode, reasoningMode = profile.reasoningMode,
		consentKey = preview.consentKey, payloadHash = payload.redactedHash,
	}
	if type(profile.apiKey) == "string" and profile.apiKey ~= "" then params.apiKey = profile.apiKey end
	self.state.providerTestStatus = "testing"
	self.state.providerTestMessage = "Testing endpoint, authentication, model, and tool calling"
	self.rpc:Request("provider.test", params, function(result, err)
		if err then
			self.state.providerTestStatus = "failed"
			self.state.providerTestMessage = "Connection test failed: " .. errorText(err)
			if callback then callback(nil, self.state.providerTestMessage) end
			return
		end
		self.state.providerTestStatus = "passed"
		self.state.providerTestResult = result
		self.state.providerTestMessage = "Connection test passed"
		if callback then callback(result) end
	end, 45000)
	return true
end

function Controller:ListProviderModels(profile, callback)
	if not self.rpc or not self.helloComplete then return nil, "sidecar is not connected" end
	if type(profile) ~= "table" then return nil, "provider profile is required" end
	local params = {
		providerId = "openai", baseUrl = profile.baseUrl, authMode = profile.authMode,
	}
	if type(profile.apiKey) == "string" and profile.apiKey ~= "" then params.apiKey = profile.apiKey end
	self.rpc:Request("provider.models.list", params, function(result, err)
		if err then
			local message = "Model list failed: " .. errorText(err)
			if callback then callback(nil, message) end
			return
		end
		if callback then callback(result) end
	end, 30000)
	return true
end

function Controller:ClearProvider(callback)
	if not self.rpc or not self.helloComplete then return nil, "sidecar is not connected" end
	self.rpc:Request("provider.clear", { providerId = "openai" }, function(result, err)
		if err then
			self.state.providerError = "LLM configuration clear failed: " .. errorText(err)
			self.state.message = self.state.providerError
			if callback then callback(nil, self.state.providerError) end
			return
		end
		self.state.providerStatus = result
		self.state.consentPreview = nil
		self.state.objectiveDraft = nil
		self.state.message = "LLM credential and consent cleared"
		if callback then callback(result) end
	end, 10000)
	return true
end

function Controller:PreviewProviderConsent()
	if not self.rpc or not self.helloComplete then return nil, "sidecar is not connected" end
	self.rpc:Request("consent.preview", {
		providerId = "openai",
		dataCategories = { "objective", "build_snapshot", "metrics", "tool_outputs", "chat_messages", "mechanic_report", "mechanic_facts", "mechanic_experiment_results" },
	}, function(result, err)
		if err then self:_setError("Consent preview failed: " .. errorText(err)) return end
		self.state.consentPreview = result
		self.state.message = "LLM consent preview ready"
	end, 10000)
	return true
end

function Controller:GrantProviderConsent()
	local preview = self.state.consentPreview
	if not self.rpc or type(preview) ~= "table" then return nil, "consent preview is unavailable" end
	local payload = preview.payloadPreview
	if type(payload) ~= "table" or type(payload.redactedHash) ~= "string" then return nil, "consent payload hash is unavailable" end
	self.rpc:Request("consent.grant", {
		providerId = "openai", consentKey = preview.consentKey, payloadHash = payload.redactedHash,
	}, function(result, err)
		if err then self:_setError("Consent grant failed: " .. errorText(err)) return end
		self.state.providerConsent = result
		self.state.consentPreview = nil
		self.state.message = "LLM consent granted"
		self:RefreshProviderStatus()
	end, 10000)
	return true
end

function Controller:DraftObjective(message, currentObjective)
	if not self.rpc or not self.helloComplete then return nil, "sidecar is not connected" end
	if type(message) ~= "string" or message == "" then return nil, "Planner Chat message is required" end
	self.rpc:Request("objective.draft", {
		providerId = "openai", message = message, currentObjective = currentObjective,
	}, function(result, err)
		if err then self:_setError("Planner Chat failed: " .. errorText(err)) return end
		if type(result) == "table" and result.kind == "draft" and type(result.draft) == "table" then
			self.state.objectiveDraft = result.draft
			self.state.objectiveDraftWarnings = result.warnings
			self.state.objectiveDraftUnresolved = result.unresolved
			self.state.message = "Planner Chat draft ready; review before confirmation"
		elseif type(result) == "table" and result.kind == "question" then
			self.state.draftQuestion = result.question
			self.state.message = result.question or "Planner Chat needs clarification"
		else
			self:_setError("Planner Chat returned an invalid draft")
		end
	end, 120000)
	return true
end

function Controller:_captureAndStart()
	local objective = self.pendingObjective
	if not objective or not self.helloComplete then return end
	self.pendingObjective = nil
	local snapshot, snapshotErr = Snapshot.Capture(self.build)
	if not snapshot then self:_setError(snapshotErr) return end
	local catalog, catalogErr = ContentCatalog.Export(self.build, { limit = 1000 })
	if not catalog then self:_setError(catalogErr) return end
	snapshot.contentCatalog = ContentCatalog.ToEntries(catalog)
	self.state.status = "capturing"
	self.state.message = "Capturing build"
	self.rpc:Request("build.capture", { snapshot = snapshot }, function(result, err)
		if err then self:_setError("Build capture failed: " .. errorText(err)) return end
		local fingerprint = type(result) == "table" and result.snapshotFingerprint or snapshot.fingerprint
		self.state.status = "starting"
		self.state.message = "Starting optimization"
		local startParams = { snapshotFingerprint = fingerprint, objective = objective }
		local report = self.state.mechanicReport
		if type(report) == "table" and report.status == "verified"
			and report.snapshotFingerprint == fingerprint and type(report.analysisFingerprint) == "string" then
			startParams.mechanicAnalysisFingerprint = report.analysisFingerprint
		end
		self.rpc:Request("run.start", startParams, function(started, startErr)
			if startErr then self:_setError("Optimization start failed: " .. errorText(startErr)) return end
			self.state.runId = type(started) == "table" and started.runId or nil
			self.state.status = "running"
			self.state.message = type(started) == "table" and type(started.warnings) == "table" and started.warnings[1] or "Optimizing"
			self.state.progress = 0
		end, 30000)
	end, 30000)
end

function Controller:Start(objective)
	if self.shutdown then return nil, "controller is shut down" end
	if type(objective) ~= "table" then return nil, "objective must be an object" end
	if self.state.runId and not restartableStatus[self.state.status] then
		return nil, "current optimization must be applied, rejected, or cancelled before starting another"
	end
	if self.state.status == "running" or self.state.status == "starting" or self.state.status == "capturing" then return nil, "optimization already running" end
	local previousState = self.state
	self.state = initialState()
	self.state.sidecarStatus = previousState.sidecarStatus or (self.helloComplete and "connected" or "stopped")
	self.state.sidecarMessage = previousState.sidecarMessage or (self.helloComplete and "Sidecar connected" or "Sidecar not started")
	self.state.sidecarCapabilities = previousState.sidecarCapabilities
	self.state.providerStatus = previousState.providerStatus
	self.activeObjective = objective
	self.pendingObjective = objective
	self.launchRequested = true
	if self.helloComplete then
		self:_captureAndStart()
	else
		self.state.status = "connecting"
		self.state.message = "Starting sidecar"
	end
	return true
end

function Controller:Cancel()
	if self.state.status == "analyzingMechanics" and self.state.mechanicAnalysisId and self.rpc then
		self.rpc:Request("mechanics.cancel", { analysisId = self.state.mechanicAnalysisId }, function(_, err)
			if err then self:_setError("Mechanic cancel failed: " .. errorText(err)) return end
			self.state.status = "cancelled"
			self.state.message = "Mechanic analysis cancelled"
		end, 10000)
		return true
	end
	if not self.state.runId or not self.rpc then return false, "no active run" end
	self.state.status = "cancelling"
	self.state.message = "Cancelling"
	self.rpc:Request("run.cancel", { runId = self.state.runId }, function(_, err)
		if err then self:_setError("Cancel failed: " .. errorText(err)) return end
		self.state.status = "cancelled"
		self.state.message = "Cancelled; current frontier preserved"
	end, 10000)
	return true
end

function Controller:RetryProvider()
	if not self.rpc or not self.state.runId or self.state.status ~= "awaitingProvider" then
		return nil, "run is not awaiting Provider"
	end
	self.state.status = "running"
	self.state.message = "Retrying LLM from checkpoint"
	self.rpc:Request("run.resume", { runId = self.state.runId, decision = "retryProvider" }, function(result, err)
		if err then self:_setError("Provider retry failed: " .. errorText(err)) return end
		if type(result) == "table" and result.status == "awaitingProvider" then
			self.state.status = "awaitingProvider"
			self.state.message = "LLM still unavailable; Retry or Cancel"
		end
	end, 120000)
	return true
end

function Controller:Preview(candidateId)
	if not self.rpc or not self.state.runId then return nil, "no optimization run" end
	if type(candidateId) ~= "string" or candidateId == "" then return nil, "candidateId is required" end
	self.state.status = "loadingCandidate"
	self.state.message = "Loading candidate preview"
	self.rpc:Request("candidate.preview", { runId = self.state.runId, candidateId = candidateId }, function(result, err)
		if err then self:_setError("Preview failed: " .. errorText(err)) return end
		self.state.preview = result and (result.candidate or result) or nil
		self.state.status = "preview"
		self.state.message = "Review changes before Apply"
	end, 30000)
	return true
end

function Controller:_findCandidate(candidateId)
	if self.state.preview and self.state.preview.id == candidateId then return self.state.preview end
	for _, candidate in ipairs(self.state.candidates or { }) do if candidate.id == candidateId then return candidate end end
end

function Controller:_clearPendingTransaction()
	self.pendingTransactionResult = nil
	self.pendingAppliedResult = nil
	self.transactionResultEverQueued = false
	if self.journal then
		local cleared, clearErr = self.journal:Clear()
		if not cleared then ConPrintf("AI Planner transaction journal cleanup failed: %s", tostring(clearErr)) end
	end
end

function Controller:_rollbackPendingTransaction(reason, context)
	context = context or "Transaction audit was not queued"
	local result = self.pendingAppliedResult
	if result and result.ok and type(self.transaction.Rollback) == "function" then
		local rollbackOk, rollbackResult = pcall(self.transaction.Rollback, self.transaction, result, errorText(reason))
		if rollbackOk and rollbackResult and rollbackResult.rolledBack then
			self:_clearPendingTransaction()
			self:_setError(context .. "; applied Build was rolled back: " .. errorText(reason))
			return rollbackResult
		end
		local rollbackError = rollbackOk and rollbackResult and rollbackResult.error or rollbackResult
		self:_setError(context .. " and rollback could not be verified: " .. errorText(rollbackError or reason))
		return rollbackResult
	end
	self:_clearPendingTransaction()
	self:_setError(context .. ": " .. errorText(reason))
end

function Controller:_sendTransactionResult()
	if not self.rpc or not self.pendingTransactionResult then return nil, "transaction result is unavailable" end
	local result = self.pendingAppliedResult
	local requestId, requestErr = self.rpc:Request("transaction.result", { result = self.pendingTransactionResult }, function(_, recordErr)
		if recordErr then
			self.state.status = "reconnecting"
			self.state.message = "Transaction outcome unknown; reconciling checkpoint"
			self:_scheduleReconnect(errorText(recordErr))
			return
		end
		if result then result.rollbackSnapshot = nil end
		self:_clearPendingTransaction()
		if result and result.ok and self.state.status ~= "completed" then
			self.state.status = "finalVerify"
			self.state.message = "Final verification"
		end
	end, 30000)
	if not requestId then
		if not self.transactionResultEverQueued then
			return nil, self:_rollbackPendingTransaction(requestErr or "transaction result could not be queued")
		end
		self:_scheduleReconnect(requestErr or "transaction result retry could not be queued")
		return nil, requestErr
	end
	self.transactionResultEverQueued = true
	return requestId
end

function Controller:_applyCandidate(candidate, scenarios)
	self.state.status = "applying"
	self.state.message = "Applying candidate transaction"
	local callOk, result = pcall(self.transaction.Apply, self.transaction, candidate, scenarios)
	if not callOk then
		result = { ok = false, stage = "transaction.exception", error = tostring(result), recoverable = false }
	end
	if result.ok then
		local valid, contractErr = validateAppliedResult(result)
		if not valid then
			local rollbackOk, rollbackResult = pcall(self.transaction.Rollback, self.transaction, result, "invalid successful transaction result: " .. contractErr)
			if rollbackOk and rollbackResult and rollbackResult.rolledBack then
				result = rollbackResult
				result.error = "invalid successful transaction result; Build rolled back: " .. contractErr
			else
				result = {
					ok = false, stage = "transaction.contract", rolledBack = false, recoverable = false,
					error = "invalid successful transaction result and rollback was not verified: " .. contractErr,
				}
			end
		end
	end
	local transactionResult = {
		runId = self.state.runId,
		candidateId = candidate.id,
		accepted = true,
		applied = result.ok == true,
		rolledBack = result.rolledBack == true,
		fingerprint = result.fingerprint,
		metrics = result.metrics,
		scenarioMetrics = result.scenarioMetrics,
		error = result.ok and nil or tostring(result.error or "transaction failed"),
	}
	self.pendingApplyCandidateId = nil
	if result.ok then
		local journaled, journalErr = self.journal:Save(self.state.runId, transactionResult, result.rollbackSnapshot)
		if not journaled then
			local rollbackOk, rollbackResult = pcall(self.transaction.Rollback, self.transaction, result, "transaction journal failed: " .. tostring(journalErr))
			if rollbackOk and rollbackResult and rollbackResult.rolledBack then
				result = rollbackResult
				transactionResult.applied = false
				transactionResult.rolledBack = true
				transactionResult.fingerprint = nil
				transactionResult.metrics = nil
				transactionResult.scenarioMetrics = nil
				transactionResult.error = "transaction journal failed; Build rolled back: " .. tostring(journalErr)
			else
				result = rollbackOk and type(rollbackResult) == "table" and rollbackResult
					or { ok = false, stage = "journal.rollback", error = tostring(rollbackResult), recoverable = false }
				transactionResult.applied = false
				transactionResult.error = "transaction journal failed and rollback was not verified: " .. tostring(journalErr)
			end
		end
	end
	self.pendingTransactionResult = transactionResult
	self.pendingAppliedResult = result
	self.transactionResultEverQueued = false
	if result.ok then
		self.state.status = "applying"
		self.state.message = "Recording transaction"
	else
		self:_setError("Apply failed at " .. tostring(result.stage) .. ": " .. tostring(result.error))
	end
	self:_sendTransactionResult()
	return result
end

function Controller:Apply(candidateId)
	if type(candidateId) ~= "string" or candidateId == "" then return nil, "candidateId is required" end
	if not self.rpc or not self.state.runId then return nil, "candidate details unavailable" end
	self.pendingApplyCandidateId = candidateId
	self.state.status = "applying"
	self.state.message = "Requesting approved transaction"
	self.rpc:Request("run.resume", { runId = self.state.runId, decision = "apply", candidateId = candidateId }, function(result, err)
		if err then
			self.pendingApplyCandidateId = nil
			self:_setError("Apply approval failed: " .. errorText(err))
			return
		end
		if self.pendingApplyCandidateId and type(result) == "table" and result.kind == "transaction-apply" and type(result.candidate) == "table" then
			self:_applyCandidate(result.candidate, result.scenarios)
		else
			self.state.message = "Waiting for transaction payload"
		end
	end, 30000)
	return true
end

function Controller:OnFrame()
	if self.shutdown then return end
	if self.tradeBroker then self.tradeBroker:OnFrame() end
	if not self.rpc and self.launcher and self.launchRequested then
		local endpoint, err = self.launcher:Poll()
		if endpoint then
			self:_createRpc(endpoint)
		elseif endpoint == nil then
			self:_setSidecarError(err)
			return
		end
	end
	if self.rpc then
		local rpc = self.rpc
		local ok, err = rpc:OnFrame()
		if not ok then
			if self.rpc == rpc then self:_scheduleReconnect(err) end
			return
		end
		if self.rpc == rpc and rpc.state == "connected" and not self.helloComplete then self:_hello() end
	end
end

function Controller:Shutdown()
	if self.shutdown then return end
	self.shutdown = true
	if self.state.runId and self.rpc and not self.pendingTransactionResult then
		pcall(self.rpc.Request, self.rpc, "run.cancel", { runId = self.state.runId }, nil, 1000)
		pcall(self.rpc.OnFrame, self.rpc)
	end
	if self.rpc then self.rpc:Close("controller shutdown") end
	if self.launcher then self.launcher:Shutdown() end
	self.state.status = "shutdown"
	self.state.message = "Planner stopped"
	self.state.sidecarStatus = "stopped"
	self.state.sidecarMessage = "Sidecar stopped"
end

function Controller:GetState()
	return self.state
end

return Controller
