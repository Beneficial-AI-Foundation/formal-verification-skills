// This release gate is independent of the official probe-aeneas archive.
// Change it only after the packaged production route has native positive,
// installation-denial, interruption/recovery and cleanup evidence.
export const WINDOWS_SOURCE_QUALIFICATION = Object.freeze({
  id: 'windows-source-v1',
  target: 'x86_64-pc-windows-msvc',
  qualified: false,
  policySha256: 'd5ef0588040b6ba8ce5e52f19d17f23a817b557580e437750fcb8264c2311177',
  tuple: 'aeneas-6e167c9b-charon-0.1.225-lean-v4.31.0',
  isolation: 'windows-appcontainer-journal-v2',
  evidence: Object.freeze({
    path: 'tests/fixtures/windows-source-v1.json',
    sha256: '8ae23aaa4f51f6a1a80fa0a3428ec1951af3f5a8caf18537c09aa9fbbcb9d70a',
  }),
  reason: 'Unqualified: successful fresh helper-build installation and complete normal-command acceptance remain outstanding; the official Windows archive remains unsupported.',
});
