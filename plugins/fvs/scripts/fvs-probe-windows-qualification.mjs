// This release gate is independent of the official probe-aeneas archive.
// Change it only after the packaged production route has native positive,
// installation-denial, interruption/recovery and cleanup evidence.
export const WINDOWS_SOURCE_QUALIFICATION = Object.freeze({
  id: 'windows-source-v1',
  target: 'x86_64-pc-windows-msvc',
  qualified: true,
  policySha256: '323acfbff84d5841615612ffc110479123b9c5556a83a40b74a6b651fcbb4216',
  tuple: 'aeneas-6e167c9b-charon-0.1.225-lean-v4.31.0',
  isolation: 'windows-appcontainer-journal-v2',
  evidence: Object.freeze({
    path: 'tests/fixtures/windows-source-v1.json',
    sha256: '54e7f395dd87b9cb982f460f2f43718b6b6c5234bee253918857bf6c0b6ec8ba',
  }),
  reason: 'Qualified native Windows 11 x64 source build for the pinned tuple and validated local NTFS layouts; the official Windows archive remains separately unsupported.',
});
