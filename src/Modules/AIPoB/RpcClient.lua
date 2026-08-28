local json = require("dkjson")
local Util = require("Modules.AIPoB.Util")

local RpcClient = { PROTOCOL_VERSION = 1 }
RpcClient.__index = RpcClient

local function encode(value)
	local text, err = json.encode(value)
	if not text then return nil, tostring(err) end
	return text
end

function RpcClient.new(options)
	options = options or { }
	return setmetatable({
		host = options.host or "127.0.0.1",
		port = tonumber(options.port),
		token = options.token,
		maxFrameSize = tonumber(options.maxFrameSize) or 8 * 1024 * 1024,
		defaultDeadline = tonumber(options.defaultDeadline) or 30000,
		socketFactory = options.socketFactory,
		onError = options.onError,
		onClose = options.onClose,
		socket = nil,
		state = "disconnected",
		nextId = 1,
		pending = { },
		handlers = { },
		sendBuffer = "",
		receiveBuffer = "",
	}, RpcClient)
end

function RpcClient:_fail(message)
	self.lastError = tostring(message)
	if self.onError then pcall(self.onError, self.lastError) end
	self:Close(self.lastError)
	return nil, self.lastError
end

function RpcClient:Connect()
	if self.host ~= "127.0.0.1" then return self:_fail("RPC host must be 127.0.0.1") end
	if not self.port or self.port < 1 or self.port > 65535 or self.port % 1 ~= 0 then return self:_fail("RPC port is invalid") end
	if type(self.token) ~= "string" or #self.token < 16 then return self:_fail("RPC session token is invalid") end
	if not self.socket then
		local factory = self.socketFactory
		if not factory then
			local socket = require("socket")
			factory = socket.tcp
		end
		local ok, created = pcall(factory)
		if not ok or not created then return self:_fail("failed to create RPC socket: " .. tostring(created)) end
		self.socket = created
		self.socket:settimeout(0)
		pcall(self.socket.setoption, self.socket, "tcp-nodelay", true)
	end
	local connected, err = self.socket:connect(self.host, self.port)
	if connected or err == "already connected" or err == "is connected" then
		self.state = "connected"
		return true
	elseif err == "timeout" or err == "Operation already in progress" then
		self.state = "connecting"
		return false, err
	end
	return self:_fail("RPC connection failed: " .. tostring(err))
end

function RpcClient:Register(method, handler)
	assert(type(method) == "string" and type(handler) == "function", "RPC handler is invalid")
	self.handlers[method] = handler
end

function RpcClient:_queue(message)
	message.jsonrpc = "2.0"
	message.protocolVersion = RpcClient.PROTOCOL_VERSION
	message.sessionToken = self.token
	local text, err = encode(message)
	if not text then return nil, err end
	if #text > self.maxFrameSize then return nil, "outgoing RPC frame exceeds limit" end
	self.sendBuffer = self.sendBuffer .. text .. "\n"
	return true
end

function RpcClient:Request(method, params, callback, deadlineMs)
	if self.state == "closed" then return nil, "RPC client is closed" end
	local id = self.nextId
	self.nextId = self.nextId + 1
	local ok, err = self:_queue({ id = id, method = method, params = params or { } })
	if not ok then return nil, err end
	self.pending[id] = { callback = callback, deadline = Util.now() + (deadlineMs or self.defaultDeadline), method = method }
	return id
end

function RpcClient:Notify(method, params)
	return self:_queue({ method = method, params = params or { } })
end

function RpcClient:CancelRequest(id)
	if not self.pending[id] then return false end
	self.pending[id] = nil
	self:Notify("$/cancelRequest", { id = id })
	return true
end

function RpcClient:_respond(id, result, rpcError)
	local message = { id = id }
	if rpcError then message.error = rpcError else message.result = result == nil and json.null or result end
	return self:_queue(message)
end

function RpcClient:_dispatch(message)
	if type(message) ~= "table" or message.jsonrpc ~= "2.0" then return self:_fail("invalid JSON-RPC envelope") end
	if message.protocolVersion ~= RpcClient.PROTOCOL_VERSION then return self:_fail("RPC protocol version mismatch") end
	if message.method then
		local handler = self.handlers[message.method]
		if not handler then
			if message.id ~= nil then self:_respond(message.id, nil, { code = -32601, message = "method not found" }) end
			return true
		end
		local ok, result, handlerErr = pcall(handler, message.params or { }, message)
		if message.id ~= nil then
			if ok and handlerErr == nil then
				self:_respond(message.id, result)
			else
				self:_respond(message.id, nil, { code = -32000, message = tostring(ok and handlerErr or result) })
			end
		elseif not ok and self.onError then
			pcall(self.onError, tostring(result))
		end
		return true
	end
	if message.id == nil then return self:_fail("RPC response is missing id") end
	local pending = self.pending[message.id]
	if not pending then return true end
	self.pending[message.id] = nil
	if pending.callback then pcall(pending.callback, message.result, message.error) end
	return true
end

function RpcClient:_flush()
	if self.sendBuffer == "" or self.state ~= "connected" then return true end
	local sent, err, last = self.socket:send(self.sendBuffer)
	local count = sent or last or 0
	if count > 0 then self.sendBuffer = self.sendBuffer:sub(count + 1) end
	if err and err ~= "timeout" then return self:_fail("RPC send failed: " .. tostring(err)) end
	return true
end

function RpcClient:_receive()
	if self.state ~= "connected" then return true end
	for _ = 1, 100 do
		local line, err, partial = self.socket:receive("*l")
		if line then
			local frame = self.receiveBuffer .. line
			self.receiveBuffer = ""
			if #frame > self.maxFrameSize then return self:_fail("incoming RPC frame exceeds limit") end
			local message, _, decodeErr = json.decode(frame, 1, json.null)
			if decodeErr then return self:_fail("invalid RPC JSON: " .. tostring(decodeErr)) end
			local ok = self:_dispatch(message)
			if not ok then return nil, self.lastError end
		elseif err == "timeout" then
			if partial and partial ~= "" then
				self.receiveBuffer = self.receiveBuffer .. partial
				if #self.receiveBuffer > self.maxFrameSize then return self:_fail("incoming RPC frame exceeds limit") end
			end
			break
		elseif err == "closed" then
			return self:_fail("RPC connection closed")
		else
			return self:_fail("RPC receive failed: " .. tostring(err))
		end
	end
	return true
end

function RpcClient:OnFrame()
	if self.state == "disconnected" or self.state == "connecting" then
		local ok, err = self:Connect()
		if not ok and self.state ~= "connecting" then return nil, err end
	end
	if self.state == "connected" then
		local ok, err = self:_flush()
		if not ok then return nil, err end
		ok, err = self:_receive()
		if not ok then return nil, err end
	end
	local now = Util.now()
	for id, pending in pairs(self.pending) do
		if now >= pending.deadline then
			self.pending[id] = nil
			if pending.callback then pcall(pending.callback, nil, { code = -32001, message = "request deadline exceeded", method = pending.method }) end
		end
	end
	return true
end

function RpcClient:Close(reason)
	if self.state == "closed" then return end
	self.state = "closed"
	if self.socket then pcall(self.socket.close, self.socket) end
	self.socket = nil
	for id, pending in pairs(self.pending) do
		if pending.callback then pcall(pending.callback, nil, { code = -32002, message = reason or "RPC client closed" }) end
		self.pending[id] = nil
	end
	if self.onClose then pcall(self.onClose, reason) end
end

return RpcClient
