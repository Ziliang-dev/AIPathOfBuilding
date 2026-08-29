local json = require("dkjson")
local sha = require("sha2")
local Util = require("Modules.AIPoB.Util")

local SidecarLauncher = { PROTOCOL_VERSION = 3 }
SidecarLauncher.__index = SidecarLauncher

local function exists(path)
	local file = io.open(path, "rb")
	if not file then return false end
	file:close()
	return true
end

local function findAssetRoot(scriptPath, fileExists)
	for _, candidate in ipairs({ scriptPath, scriptPath .. "/..", ".", ".." }) do
		if fileExists(candidate .. "/sidecar/dist/server.cjs") then return candidate end
	end
	return scriptPath
end

local function quoted(value)
	value = tostring(value)
	if value:find('[%z\r\n"]') then return nil, "unsafe process argument" end
	return '"' .. value .. '"'
end

local function randomToken()
	local seed = table.concat({ tostring(Util.now()), tostring(os.clock()), tostring(math.random()), tostring({ }) }, ":")
	return sha.sha256(seed)
end

function SidecarLauncher.new(options)
	options = options or { }
	local scriptPath = options.scriptPath or (type(GetScriptPath) == "function" and GetScriptPath()) or "."
	local userPath = options.userPath or (main and main.userPath) or scriptPath .. "/"
	local dataDir = options.dataDir or userPath .. "AIPathOfBuilding"
	local runtimePath = options.runtimePath or (type(GetRuntimePath) == "function" and GetRuntimePath()) or scriptPath .. "/../runtime"
	local processors = tonumber(os.getenv("NUMBER_OF_PROCESSORS")) or 2
	local defaultWorkerCount = math.min(4, math.max(1, math.floor(processors / 2)))
	local fileExists = options.exists or exists
	local assetRoot = options.assetRoot
	if not assetRoot then
		assetRoot = findAssetRoot(scriptPath, fileExists)
	end
	return setmetatable({
		scriptPath = scriptPath,
		assetRoot = assetRoot,
		runtimePath = runtimePath,
		dataDir = dataDir,
		workerCount = math.max(1, math.min(tonumber(options.workerCount) or defaultWorkerCount, 8)),
		timeout = options.timeout or 30000,
		spawn = options.spawn or SpawnProcess,
		exists = fileExists,
		token = options.token or randomToken(),
		startedAt = nil,
		readyFile = nil,
		state = "idle",
	}, SidecarLauncher)
end

function SidecarLauncher:Start()
	if self.state ~= "idle" then return nil, "sidecar launcher already started" end
	if type(self.spawn) ~= "function" then return nil, "SpawnProcess is unavailable" end
	if type(MakeDir) == "function" then
		local ok, err = MakeDir(self.dataDir)
		if ok == false then return nil, "cannot create sidecar data directory: " .. tostring(err) end
	end
	local entry = self.assetRoot .. "/sidecar/dist/server.cjs"
	if not self.exists(entry) then return nil, "sidecar/dist/server.cjs missing; run pnpm --dir sidecar build" end
	local pobExecutable
	for _, name in ipairs({ "Path of Building.exe", "Path{space}of{space}Building.exe", "PathOfBuilding.exe" }) do
		local candidate = self.runtimePath .. "/" .. name
		if self.exists(candidate) then pobExecutable = candidate break end
	end
	if not pobExecutable then return nil, "Path of Building worker executable missing from runtime directory" end
	local workerScript = self.scriptPath .. "/AIPoBWorker.lua"
	if not self.exists(workerScript) then return nil, "AIPoBWorker.lua missing" end
	local bundledNode = self.assetRoot .. "/sidecar/runtime/node.exe"
	local credentialHelper = self.assetRoot .. "/sidecar/runtime/aipob-credential-helper.exe"
	local hiddenLauncher = self.assetRoot .. "/sidecar/runtime/aipob-sidecar-launcher.exe"
	local command
	if self.exists(bundledNode) then
		command = bundledNode
	elseif launch and launch.devMode then
		command = "node"
	else
		return nil, "bundled sidecar Node runtime missing"
	end
	self.readyFile = self.dataDir .. "/ready-" .. self.token:sub(1, 20) .. ".json"
	local args = {
		entry, "--host", "127.0.0.1", "--port", "0", "--session-token", self.token,
		"--data-dir", self.dataDir, "--ready-file", self.readyFile,
		"--pob-executable", pobExecutable, "--worker-script", workerScript,
		"--worker-count", tostring(self.workerCount),
		"--owner-connect-timeout-ms", tostring(self.timeout),
	}
	if self.exists(credentialHelper) then
		table.insert(args, "--credential-helper")
		table.insert(args, credentialHelper)
	end
	if self.exists(hiddenLauncher) then
		table.insert(args, 1, command)
		command = hiddenLauncher
	end
	local encoded = { }
	for _, value in ipairs(args) do
		local item, err = quoted(value)
		if not item then return nil, err end
		table.insert(encoded, item)
	end
	local ok, spawnErr = pcall(self.spawn, command, table.concat(encoded, " "))
	if not ok then return nil, "failed to launch sidecar: " .. tostring(spawnErr) end
	self.startedAt = Util.now()
	self.state = "waiting"
	return true
end

function SidecarLauncher:Poll()
	if self.state == "idle" then
		local ok, err = self:Start()
		if not ok then self.state = "failed" return nil, err end
	end
	if self.state == "ready" then return self.endpoint end
	if self.state == "failed" then return nil, self.error or "sidecar launch failed" end
	if Util.now() - self.startedAt >= self.timeout then
		self.state, self.error = "failed", "sidecar ready-file timeout"
		return nil, self.error
	end
	local file = io.open(self.readyFile, "rb")
	if not file then return false end
	local text = file:read("*a")
	file:close()
	local ready, _, err = json.decode(text, 1, json.null)
	if err or type(ready) ~= "table" then return false end
	if ready.protocolVersion ~= SidecarLauncher.PROTOCOL_VERSION then
		self.state, self.error = "failed", "sidecar protocol version mismatch"
		return nil, self.error
	end
	if ready.host ~= "127.0.0.1" then
		self.state, self.error = "failed", "sidecar advertised a non-loopback host"
		return nil, self.error
	end
	local port = tonumber(ready.port)
	if not port or port < 1 or port > 65535 or port % 1 ~= 0 then
		self.state, self.error = "failed", "sidecar advertised an invalid port"
		return nil, self.error
	end
	self.endpoint = { host = ready.host, port = port, token = self.token, pid = tonumber(ready.pid), protocolVersion = ready.protocolVersion }
	self.state = "ready"
	return self.endpoint
end

function SidecarLauncher:Shutdown()
	if self.readyFile then pcall(os.remove, self.readyFile) end
	self.state = "closed"
end

return SidecarLauncher
