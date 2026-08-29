describe("AIPoB portable updater paths", function()
	local UpdatePaths = require("Modules.AIPoB.UpdatePaths")
	local manifest = { { elem = "PoBVersion" } }

	it("finds the package-root manifest from the src script directory", function()
		local attempts = { }
		local paths, loaded = UpdatePaths.Resolve({
			LoadXMLFile = function(path)
				table.insert(attempts, path)
				if path == "C:/portable/src/../manifest.xml" then return manifest end
			end,
		}, {
			GetScriptPath = function() return "C:/portable/src" end,
			GetRuntimePath = function() return "C:/portable" end,
			GetWorkDir = function() return "C:/portable/src" end,
		})

		assert.are.same({
			"C:/portable/src/manifest.xml",
			"C:/portable/src/../manifest.xml",
		}, attempts)
		assert.are.equal(manifest, loaded)
		assert.are.equal("C:/portable/src/..", paths.installPath)
		assert.are.equal("C:/portable/src/../manifest.xml", paths.manifestPath)
		assert.are.equal("C:/portable/src/Update", paths.updatePath)
	end)

	it("maps manifest parts to their packaged owners", function()
		local paths = {
			scriptPath = "C:/portable/src",
			runtimePath = "C:/portable",
			installPath = "C:/portable",
		}

		assert.are.equal("C:/portable/src/UpdateCheck.lua", UpdatePaths.FilePath(paths, "UpdateCheck.lua", "program"))
		assert.are.equal("C:/portable/src/TreeData/tree.lua", UpdatePaths.FilePath(paths, "TreeData/tree.lua", "tree"))
		assert.are.equal("C:/portable/Path of Building.exe", UpdatePaths.FilePath(paths, "Path{space}of{space}Building.exe", "runtime"))
		assert.are.equal("C:/portable/changelog.txt", UpdatePaths.FilePath(paths, "changelog.txt", "default"))
		assert.are.equal("C:/portable/sidecar/dist/server.cjs", UpdatePaths.FilePath(paths, "sidecar/dist/server.cjs", "sidecar"))
	end)
end)
