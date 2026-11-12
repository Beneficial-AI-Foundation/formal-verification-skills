<purpose>
Self-update of an npm-installed FVS.

This workflow has no process of its own. The update command (`/fvs:update`) holds the single
supported update process: it locates the installed version, compares it with npm by SemVer
precedence, stops when the installed version is unknown, ahead or unparseable, and never
downgrades a prerelease.
</purpose>

<process>
Run the update command (`/fvs:update`) and follow its process exactly. Do not run the installer from here.
</process>
