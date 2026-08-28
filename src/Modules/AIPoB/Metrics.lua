local Metrics = { SCHEMA_VERSION = 1 }

local fields = {
	FullDPS = "fullDps",
	CombinedDPS = "combinedDps",
	TotalDPS = "totalDps",
	TotalDot = "totalDot",
	Speed = "speed",
	Life = "life",
	EnergyShield = "energyShield",
	Mana = "mana",
	TotalEHP = "effectiveHitPool",
	PhysicalMaximumHitTaken = "physicalMaxHit",
	FireMaximumHitTaken = "fireMaxHit",
	ColdMaximumHitTaken = "coldMaxHit",
	LightningMaximumHitTaken = "lightningMaxHit",
	ChaosMaximumHitTaken = "chaosMaxHit",
	LifeRegen = "lifeRegen",
	EnergyShieldRegen = "energyShieldRegen",
	NetLifeRegen = "netLifeRegen",
	NetManaRegen = "netManaRegen",
	SpellSuppressionChance = "spellSuppressionChance",
	BlockChance = "blockChance",
	SpellBlockChance = "spellBlockChance",
}

local function clean(value)
	if type(value) ~= "number" then
		return value
	end
	if value == math.huge or value == -math.huge or value ~= value then
		return nil
	end
	return value
end

function Metrics.FromOutput(output)
	local result = { }
	for source, target in pairs(fields) do
		if output and output[source] ~= nil then
			result[target] = clean(output[source])
		end
	end
	local maxHits = { result.physicalMaxHit, result.fireMaxHit, result.coldMaxHit, result.lightningMaxHit, result.chaosMaxHit }
	local worst
	for _, value in ipairs(maxHits) do
		if type(value) == "number" and (not worst or value < worst) then
			worst = value
		end
	end
	result.worstCaseMaxHit = worst
	return result
end

function Metrics.Capture(build)
	local output = build and build.calcsTab and build.calcsTab.mainOutput
	if type(output) ~= "table" then
		return nil, "build has no calculated output"
	end
	return Metrics.FromOutput(output)
end

return Metrics
