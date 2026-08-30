local json = require("dkjson")

local Journal = { SCHEMA_VERSION = 1 }
Journal.__index = Journal

local function defaultPath()
	local root = main and main.userPath or GetUserPath and GetUserPath() or "."
	return root .. "/AIPathOfBuilding-transaction-journal.json"
end

local function validAppliedResult(result)
	if type(result) ~= "table" or result.applied ~= true or type(result.fingerprint) ~= "string"
		or type(result.metrics) ~= "table" or type(result.scenarioMetrics) ~= "table" then return false end
	for _, scenario in ipairs({ "mapping", "standardBoss", "pinnacle", "uber" }) do
		if type(result.scenarioMetrics[scenario]) ~= "table" then return false end
	end
	return true
end

function Journal.new(path)
	return setmetatable({ path = path or defaultPath() }, Journal)
end

local function loadPath(path)
	local file = io.open(path, "rb")
	if not file then return nil end
	local text = file:read("*a")
	file:close()
	local value, _, decodeErr = json.decode(text, 1, json.null)
	if decodeErr or type(value) ~= "table" or value.schemaVersion ~= Journal.SCHEMA_VERSION then
		return nil, "transaction journal is invalid: " .. tostring(decodeErr or "schema mismatch")
	end
	if type(value.runId) ~= "string" or not validAppliedResult(value.transactionResult)
		or type(value.rollbackSnapshot) ~= "table" or type(value.rollbackSnapshot.xml) ~= "string"
		or type(value.rollbackSnapshot.fingerprint) ~= "string" then
		return nil, "transaction journal is incomplete"
	end
	return value
end

function Journal:Load()
	local value, err = loadPath(self.path)
	if value then return value end
	local backup, backupErr = loadPath(self.path .. ".bak")
	if backup then return backup end
	return nil, err or backupErr
end

function Journal:Save(runId, transactionResult, rollbackSnapshot)
	if type(runId) ~= "string" or runId == "" then return nil, "runId is required" end
	if not validAppliedResult(transactionResult) then
		return nil, "applied transaction result is required"
	end
	if type(rollbackSnapshot) ~= "table" or type(rollbackSnapshot.xml) ~= "string" or rollbackSnapshot.xml == ""
		or type(rollbackSnapshot.fingerprint) ~= "string" or rollbackSnapshot.fingerprint == "" then
		return nil, "rollback snapshot is required"
	end
	local payload, encodeErr = json.encode({
		schemaVersion = Journal.SCHEMA_VERSION,
		runId = runId,
		transactionResult = transactionResult,
		rollbackSnapshot = rollbackSnapshot,
	})
	if not payload then return nil, tostring(encodeErr) end
	local temporary = self.path .. ".tmp"
	local file, openErr = io.open(temporary, "wb")
	if not file then return nil, tostring(openErr) end
	local wrote, writeErr = file:write(payload)
	local closed, closeErr = file:close()
	if not wrote or not closed then
		os.remove(temporary)
		return nil, tostring(writeErr or closeErr or "journal write failed")
	end
	local backup = self.path .. ".bak"
	os.remove(backup)
	local existing = io.open(self.path, "rb")
	if existing then
		existing:close()
		local backedUp, backupErr = os.rename(self.path, backup)
		if not backedUp then
			os.remove(temporary)
			return nil, tostring(backupErr or "journal backup failed")
		end
	end
	local renamed, renameErr = os.rename(temporary, self.path)
	if not renamed then
		os.remove(temporary)
		os.rename(backup, self.path)
		return nil, tostring(renameErr or "journal rename failed")
	end
	os.remove(backup)
	return true
end

function Journal:Clear()
	for _, path in ipairs({ self.path, self.path .. ".tmp", self.path .. ".bak" }) do
		local removed, err = os.remove(path)
		if not removed then
			local existing = io.open(path, "rb")
			if existing then
				existing:close()
				return nil, tostring(err or "journal removal failed")
			end
		end
	end
	return true
end

return Journal
