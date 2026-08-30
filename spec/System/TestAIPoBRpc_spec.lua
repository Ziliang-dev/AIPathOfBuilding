describe("AIPathOfBuilding RPC", function()
	local json = require("dkjson")
	local RpcClient = require("Modules.AIPoB.RpcClient")

	local function fakeSocket()
		local socket = { incoming = { }, outgoing = "", connected = false }
		function socket:settimeout() end
		function socket:setoption() end
		function socket:connect(host, port) self.connected = true self.host = host self.port = port return 1 end
		function socket:send(text) self.outgoing = self.outgoing .. text return #text end
		function socket:receive()
			if #self.incoming == 0 then return nil, "timeout", "" end
			return table.remove(self.incoming, 1)
		end
		function socket:close() self.closed = true end
		return socket
	end

	it("authenticates every request and dispatches protocol responses", function()
		local transport = fakeSocket()
		local client = RpcClient.new({ host = "127.0.0.1", port = 32123, token = string.rep("a", 32), socketFactory = function() return transport end })
		local result
		local id = assert(client:Request("hello", { clientName = "test", clientVersion = "1" }, function(value) result = value end))
		assert.is_true(client:OnFrame())
		local request = json.decode(transport.outgoing:match("([^\n]+)"))
		assert.are.equal("2.0", request.jsonrpc)
		assert.are.equal(4, request.protocolVersion)
		assert.are.equal(string.rep("a", 32), request.sessionToken)
		table.insert(transport.incoming, json.encode({ jsonrpc = "2.0", protocolVersion = 4, id = id, result = { ok = true } }))
		assert.is_true(client:OnFrame())
		assert.is_true(result.ok)
	end)

	it("dispatches notifications and rejects protocol mismatch", function()
		local transport = fakeSocket()
		local client = RpcClient.new({ host = "127.0.0.1", port = 32123, token = string.rep("b", 32), socketFactory = function() return transport end })
		local phase
		client:Register("run.progress", function(params) phase = params.phase end)
		assert.is_true(client:OnFrame())
		table.insert(transport.incoming, json.encode({ jsonrpc = "2.0", protocolVersion = 4, method = "run.progress", params = { phase = "search" } }))
		assert.is_true(client:OnFrame())
		assert.are.equal("search", phase)
		table.insert(transport.incoming, json.encode({ jsonrpc = "2.0", protocolVersion = 3, method = "run.progress", params = { } }))
		local ok, err = client:OnFrame()
		assert.is_nil(ok)
		assert.matches("version mismatch", err)
	end)

	it("fails closed for non-loopback endpoints", function()
		local client = RpcClient.new({ host = "0.0.0.0", port = 32123, token = string.rep("c", 32), socketFactory = fakeSocket })
		local ok, err = client:Connect()
		assert.is_nil(ok)
		assert.matches("127.0.0.1", err, nil, true)
	end)

	it("keeps sidecar launch lazy until Start or provider setup", function()
		local polls = 0
		local launcher = { Poll = function() polls = polls + 1 return false end, Shutdown = function() end }
		local fakeBuild = { SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }
		local Controller = require("Modules.AIPoB.PlannerController")
		local controller = Controller.new(fakeBuild, { launcher = launcher, transaction = { Apply = function() return { ok = true } end } })
		controller:OnFrame()
		assert.are.equal(0, polls)
		assert.is_true(controller:EnsureConnected())
		assert.are.equal("idle", controller.state.status)
		assert.are.equal("starting", controller.state.sidecarStatus)
		controller:OnFrame()
		assert.are.equal(1, polls)
		assert.is_nil(controller.pendingObjective)

		polls = 0
		controller.launchRequested = nil
		assert.is_true(controller:Start({ candidateSources = { currentBuild = true } }))
		controller:OnFrame()
		assert.are.equal(1, polls)
	end)

	it("keeps run state independent across sidecar failure, retry, and handshake", function()
		local failingLauncher = {
			state = "idle",
			Poll = function(self) self.state = "failed" return nil, "launch failed" end,
			Shutdown = function() end,
		}
		local Controller = require("Modules.AIPoB.PlannerController")
		local controller = Controller.new({ SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }, {
			launcher = failingLauncher, transaction = { Apply = function() return { ok = true } end },
		})
		assert.is_true(controller:EnsureConnected())
		controller:OnFrame()
		assert.are.equal("idle", controller.state.status)
		assert.are.equal("failed", controller.state.sidecarStatus)
		assert.matches("launch failed", controller.state.sidecarMessage)

		local rpc = {
			state = "connected",
			Register = function() end,
			OnFrame = function() return true end,
			Request = function(_, method, _, callback)
				if method == "hello" then callback({ capabilities = { providerConnectionTest = true, providerCompatibility = true } })
				elseif method == "provider.status" then callback({ configured = false, credentialConfigured = false, consent = "required" }) end
				return 1
			end,
		}
		controller.launcher = { state = "idle", Poll = function() return false end, Shutdown = function() end }
		controller.rpc = rpc
		controller.handlersRegistered = false
		controller:_registerHandlers()
		assert.is_true(controller:EnsureConnected())
		controller:OnFrame()
		assert.are.equal("idle", controller.state.status)
		assert.are.equal("connected", controller.state.sidecarStatus)
		assert.is_true(controller.state.sidecarCapabilities.providerConnectionTest)
		assert.is_true(controller.state.sidecarCapabilities.providerCompatibility)
	end)

	it("routes a one-time provider connection preview and test", function()
		local requests = { }
		local rpc = {
			Register = function() end,
			Request = function(_, method, params, callback)
				table.insert(requests, { method = method, params = params })
				if method == "provider.test.preview" then
					callback({
						endpoint = params.baseUrl, model = params.model, consentKey = "consent-key",
						payloadPreview = { redactedHash = "sha256:"..string.rep("a", 64) },
					})
				elseif method == "provider.test" then
					callback({ ok = true, latencyMs = 12, toolCallValidated = true, testId = "test-id" })
				elseif method == "provider.models.list" then
					callback({ models = { "model-a", "model-b" } })
				end
				return #requests
			end,
		}
		local Controller = require("Modules.AIPoB.PlannerController")
		local controller = Controller.new({ SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }, {
			rpc = rpc, transaction = { Apply = function() return { ok = true } end },
		})
		controller.helloComplete = true
		controller.state.sidecarCapabilities = { providerConnectionTest = true, providerCompatibility = true }
		local preview, result, models
		local profile = { baseUrl = "https://provider.invalid/v1", model = "test", apiKey = "secret", authMode = "bearer", apiMode = "auto", reasoningMode = "auto" }
		assert.is_true(controller:PreviewProviderTest(profile, function(value) preview = value end))
		assert.is_true(controller:TestProviderConnection(profile, preview, function(value) result = value end))
		assert.is_true(controller:ListProviderModels(profile, function(value) models = value.models end))
		assert.is_true(result.ok)
		assert.are.same({ "model-a", "model-b" }, models)
		assert.are.equal("provider.test.preview", requests[1].method)
		assert.are.equal("provider.test", requests[2].method)
		assert.are.equal("provider.models.list", requests[3].method)
		assert.are.equal("secret", requests[2].params.apiKey)
		assert.are.equal("auto", requests[2].params.apiMode)
		assert.are.equal("auto", requests[2].params.reasoningMode)
		assert.are.equal("passed", controller.state.providerTestStatus)
	end)

	it("refuses a second run while the first awaits approval", function()
		local launcher = { Poll = function() return false end, Shutdown = function() end }
		local fakeBuild = { SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }
		local Controller = require("Modules.AIPoB.PlannerController")
		local controller = Controller.new(fakeBuild, { launcher = launcher, transaction = { Apply = function() return { ok = true } end } })
		controller.state = { status = "awaitingApproval", runId = "run-1", candidates = { } }
		local started, err = controller:Start({ candidateSources = { currentBuild = true } })
		assert.is_nil(started)
		assert.matches("applied, rejected, or cancelled", err)
		assert.are.equal("run-1", controller.state.runId)
	end)

	it("restores a paused checkpoint as awaiting human approval", function()
		local rpc = {
			Register = function() end,
			Request = function(_, method, params, callback)
				if method == "run.stream" then
					callback({ status = "paused", candidates = { { id = "candidate-1" } } })
				else
					assert.are.equal("run.resume", method)
					assert.are.equal("checkpoint", params.mode)
					callback({ status = "paused", candidates = { { id = "candidate-1" } } })
				end
			end,
		}
		local fakeBuild = { SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }
		local Controller = require("Modules.AIPoB.PlannerController")
		local controller = Controller.new(fakeBuild, { rpc = rpc, transaction = { Apply = function() return { ok = true } end } })
		controller.reconnectRunId = "run-1"
		controller:_resumeCheckpoint()
		assert.are.equal("awaitingApproval", controller.state.status)
		assert.are.equal("candidate-1", controller.state.candidates[1].id)
	end)

	it("rolls back a successful Apply when its audit request cannot be queued", function()
		local rolledBack = false
		local rpc = {
			Register = function() end,
			Request = function() return nil, "RPC client is closed" end,
		}
		local transaction = {
			Apply = function()
				return { ok = true, fingerprint = "changed", metrics = { }, scenarioMetrics = { mapping = { }, standardBoss = { }, pinnacle = { }, uber = { } }, rollbackSnapshot = { xml = "base", fingerprint = "base" } }
			end,
			Rollback = function()
				rolledBack = true
				return { ok = false, stage = "audit", rolledBack = true, recoverable = true }
			end,
		}
		local fakeBuild = { SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }
		local Controller = require("Modules.AIPoB.PlannerController")
		local journal = { Load = function() end, Save = function() return true end, Clear = function() return true end }
		local controller = Controller.new(fakeBuild, { rpc = rpc, transaction = transaction, journal = journal })
		controller.state.runId = "run-1"
		controller:_applyCandidate({ id = "candidate-1", actions = { } })
		assert.is_true(rolledBack)
		assert.are.equal("error", controller.state.status)
		assert.matches("audit was not queued", controller.state.message)
	end)

	it("keeps an applied transaction pending when an audit ACK is lost", function()
		local rolledBack = false
		local rpc = {
			state = "connected",
			Register = function() end,
			Close = function(self) self.state = "closed" end,
			Request = function(_, method, _, callback)
				assert.are.equal("transaction.result", method)
				callback(nil, { message = "connection lost" })
				return 1
			end,
		}
		local transaction = {
			Apply = function()
				return { ok = true, fingerprint = "changed", metrics = { }, scenarioMetrics = { mapping = { }, standardBoss = { }, pinnacle = { }, uber = { } }, rollbackSnapshot = { xml = "base", fingerprint = "base" } }
			end,
			Rollback = function() rolledBack = true return { ok = false, rolledBack = true } end,
		}
		local fakeBuild = { SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }
		local Controller = require("Modules.AIPoB.PlannerController")
		local journal = { Load = function() end, Save = function() return true end, Clear = function() return true end }
		local controller = Controller.new(fakeBuild, { rpc = rpc, transaction = transaction, journal = journal })
		controller.state.runId = "run-1"
		controller:_applyCandidate({ id = "candidate-1", actions = { } })
		assert.is_false(rolledBack)
		assert.is_table(controller.pendingTransactionResult)
		assert.are.equal("reconnecting", controller.state.status)
	end)

	it("rolls back and does not journal an incomplete successful transaction", function()
		local rolledBack, journaled = false, false
		local transaction = {
			Apply = function() return { ok = true, fingerprint = "changed", rollbackSnapshot = { xml = "base", fingerprint = "base" } } end,
			Rollback = function()
				rolledBack = true
				return { ok = false, stage = "audit", rolledBack = true, recoverable = true }
			end,
		}
		local rpc = {
			Register = function() end,
			Request = function() return 1 end,
		}
		local journal = {
			Load = function() end,
			Save = function() journaled = true return true end,
			Clear = function() return true end,
		}
		local Controller = require("Modules.AIPoB.PlannerController")
		local controller = Controller.new({ SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }, {
			rpc = rpc, transaction = transaction, journal = journal,
		})
		controller.state.runId = "run-1"
		local result = controller:_applyCandidate({ id = "candidate-1", actions = { } })
		assert.is_true(rolledBack)
		assert.is_false(journaled)
		assert.is_false(result.ok)
		assert.matches("metrics missing", result.error)
	end)

	it("rolls back a pending local Apply when reconciliation finds a failed run", function()
		local rolledBack = false
		local rpc = {
			Register = function() end,
			Request = function(_, method, _, callback)
				assert.are.equal("run.stream", method)
				callback({ status = "failed", candidates = { } })
				return 1
			end,
		}
		local transaction = {
			Apply = function() return { ok = true } end,
			Rollback = function()
				rolledBack = true
				return { ok = false, stage = "audit", rolledBack = true, recoverable = true }
			end,
		}
		local fakeBuild = { SaveDB = function() return "<PathOfBuilding><Build/></PathOfBuilding>" end }
		local Controller = require("Modules.AIPoB.PlannerController")
		local journal = { Load = function() end, Save = function() return true end, Clear = function() return true end }
		local controller = Controller.new(fakeBuild, { rpc = rpc, transaction = transaction, journal = journal })
		controller.state.runId = "run-1"
		controller.reconnectRunId = "run-1"
		controller.pendingTransactionResult = { runId = "run-1", candidateId = "candidate-1" }
		controller.pendingAppliedResult = { ok = true, rollbackSnapshot = { xml = "base", fingerprint = "base" } }
		controller:_resumeCheckpoint()
		assert.is_true(rolledBack)
		assert.are.equal("error", controller.state.status)
		assert.matches("did not complete", controller.state.message)
	end)

	it("finds sidecar assets one level above the dev src directory", function()
		local Launcher = require("Modules.AIPoB.SidecarLauncher")
		local launcher = Launcher.new({ scriptPath = GetScriptPath(), userPath = main.userPath })
		local entry = io.open(launcher.assetRoot .. "/sidecar/dist/server.cjs", "rb")
		assert.is_not_nil(entry)
		entry:close()
	end)

	it("spawns sidecar with structured worker arguments", function()
		local Launcher = require("Modules.AIPoB.SidecarLauncher")
		local spawned = { }
		local launcher = Launcher.new({
			scriptPath = GetScriptPath(), userPath = main.userPath,
			spawn = function(command, args) spawned.command, spawned.args = command, args end,
			exists = function(path)
				return path:match("sidecar/dist/server%.cjs$") ~= nil
					or path:match("sidecar/runtime/node%.exe$") ~= nil
					or path:match("sidecar/runtime/aipob%-sidecar%-launcher%.exe$") ~= nil
					or path:match("Path of Building%.exe$") ~= nil
					or path:match("AIPoBWorker%.lua$") ~= nil
			end,
		})
		assert.is_true(launcher:Start())
		assert.matches("aipob%-sidecar%-launcher", spawned.command:lower())
		assert.matches("node%.exe", spawned.args:lower())
		assert.matches("--pob%-executable", spawned.args)
		assert.matches("--worker%-script", spawned.args)
		assert.matches("AIPoBWorker%.lua", spawned.args)
		assert.matches("--worker%-count", spawned.args)
		launcher:Shutdown()
	end)

	it("falls back to direct Node for older portable layouts", function()
		local Launcher = require("Modules.AIPoB.SidecarLauncher")
		local command
		local launcher = Launcher.new({
			scriptPath = GetScriptPath(), userPath = main.userPath,
			spawn = function(value) command = value end,
			exists = function(path)
				return path:match("sidecar/dist/server%.cjs$") ~= nil
					or path:match("sidecar/runtime/node%.exe$") ~= nil
					or path:match("Path of Building%.exe$") ~= nil
					or path:match("AIPoBWorker%.lua$") ~= nil
			end,
		})
		assert.is_true(launcher:Start())
		assert.matches("node", command:lower(), nil, true)
		launcher:Shutdown()
	end)
end)
