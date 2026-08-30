# AIPoB sidecar launcher

Windows GUI-subsystem helper used only to start the packaged Node sidecar with
`CREATE_NO_WINDOW`. It accepts the child executable as its first argument and
passes all remaining arguments directly to `CreateProcessW`; no shell is used.

Build through `python scripts/aipob.py build-sidecar-launcher` in the Windows
GitHub Actions job. Do not commit the generated executable.
