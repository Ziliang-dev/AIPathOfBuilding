local ContentCatalog = require("Modules.AIPoB.ContentCatalog")
local RpcClient = require("Modules.AIPoB.RpcClient")
local SidecarLauncher = require("Modules.AIPoB.SidecarLauncher")
local Snapshot = require("Modules.AIPoB.Snapshot")
local Transaction = require("Modules.AIPoB.Transaction")
local TransactionJournal = require("Modules.AIPoB.TransactionJournal")

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
		pendingTransactionResult = nil,
		pendingAppliedResult = nil,
		transactionResultEverQueued = false,
		helloComplete = false,
		shutdown = false,
	}, Controller)
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
	end
	return self
end

function Controller:_setError(message)
	self.state.status = "error"
	self.state.error = tostring(message)
	self.state.message = self.state.error
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
	self.state.status = "reconnecting"
	self.state.message = self.pendingTransactionResult and "Reconciling transaction audit" or "Reconnecting to sidecar checkpoint"
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
				self.state.status = "awaitingApproval"
				self.state.message = "Checkpoint restored; review verified candidates"
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
end

function Controller:_hello()
	if self.helloComplete or self.helloPending or not self.rpc then return end
	self.helloPending = true
	self.state.status = "connecting"
	self.state.message = "Connecting to AIPathOfBuilding sidecar"
	self.rpc:Request("hello", { clientName = "pob-lua", clientVersion = tostring(_G.version or "1") }, function(result, err)
		self.helloPending = false
		if err then self:_setError("Sidecar handshake failed: " .. errorText(err)) return end
		self.helloComplete = true
		self.state.status = "idle"
		self.state.message = "Sidecar connected"
		if self.reconnectRunId then self:_resumeCheckpoint()
		elseif self.pendingObjective then self:_captureAndStart() end
	end, 10000)
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
		self.rpc:Request("run.start", { snapshotFingerprint = fingerprint, objective = objective }, function(started, startErr)
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
	if objective.candidateSources and objective.candidateSources.trade then
		return nil, "Trade search is unavailable until the main-process Trade broker is connected"
	end
	if self.state.runId and not restartableStatus[self.state.status] then
		return nil, "current optimization must be applied, rejected, or cancelled before starting another"
	end
	if self.state.status == "running" or self.state.status == "starting" or self.state.status == "capturing" then return nil, "optimization already running" end
	self.state = initialState()
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
	if not self.rpc and self.launcher and self.launchRequested then
		local endpoint, err = self.launcher:Poll()
		if endpoint then
			self:_createRpc(endpoint)
		elseif endpoint == nil then
			self:_setError(err)
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
end

function Controller:GetState()
	return self.state
end

return Controller
