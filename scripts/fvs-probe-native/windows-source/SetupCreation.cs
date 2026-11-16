// Profile-free, exclusive creation for durable source-setup intents.
// The caller persists an unpredictable tag and exact path BEFORE invoking this
// primitive. A tag authenticates only this newly created private object; public
// publication still requires the separately persisted file identity.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class FvsSetupCreation {
    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)]
    struct FILE_INFO {
        public uint attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct DISPOSITION { [MarshalAs(UnmanagedType.Bool)] public bool delete; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateDirectoryW")]
    static extern bool NativeCreateDirectory(string path, ref SECURITY_ATTRIBUTES security);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FILE_INFO info);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out uint value, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref DISPOSITION value, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetDriveType(string root);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumeInformation(string root, StringBuilder volume, uint volumeSize, out uint serial, out uint maximum, out uint flags, StringBuilder filesystem, uint filesystemSize);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern uint GetSecurityInfo(SafeFileHandle handle, int kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);

    static readonly StringComparer Paths = StringComparer.OrdinalIgnoreCase;
    static string UserSid { get { return WindowsIdentity.GetCurrent().User.Value; } }
    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static SecurityIdentifier Tag(string value) {
        if (value == null || !Regex.IsMatch(value, @"^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$") || value.Length > 128)
            throw new ArgumentException("Creation tag must be an unpredictable S-1-5-21 SID with four uint32 components");
        var sid = new SecurityIdentifier(value);
        if (sid.Value != value || sid.Value == UserSid) throw new ArgumentException("Creation tag is not canonical or equals the account SID");
        return sid;
    }
    public static byte[] SecurityDescriptor(string tag, bool directory = true) {
        string inheritance = directory ? "OICI" : "";
        var descriptor = new RawSecurityDescriptor("O:" + UserSid + "D:P(D;;0x80;;;" + Tag(tag).Value + ")"
            + "(A;" + inheritance + ";FA;;;" + UserSid + ")"
            + "(A;" + inheritance + ";FA;;;SY)(A;" + inheritance + ";FA;;;BA)");
        var bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0); return bytes;
    }
    static string Spelling(string path) {
        if (String.IsNullOrEmpty(path) || !Regex.IsMatch(path, @"^[A-Za-z]:\\") || path.IndexOf('/') >= 0
            || path.Substring(2).IndexOf(':') >= 0 || !Paths.Equals(Path.GetFullPath(path), path))
            throw new IOException("Creation path must use a canonical local drive spelling");
        foreach (char c in path) if (c < 32) throw new IOException("Control characters in creation path");
        foreach (string part in path.Substring(3).Split('\\')) {
            if (part.Length == 0 && path.Length == 3) continue;
            if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ")
                || part.IndexOfAny(new[] { '<', '>', '"', '|', '?', '*' }) >= 0
                || Regex.IsMatch(part, @"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase))
                throw new IOException("Unsupported creation path component");
        }
        string root = path.Substring(0, 3);
        if (GetDriveType(root) != 3) throw new IOException("Creation requires a fixed local drive");
        var filesystem = new StringBuilder(64); uint serial, maximum, flags;
        Check(GetVolumeInformation(root, null, 0, out serial, out maximum, out flags, filesystem, 64), "query creation filesystem");
        if (filesystem.ToString() != "NTFS") throw new IOException("Creation requires NTFS");
        return path;
    }
    static FILE_INFO Inspect(SafeFileHandle handle, string path, bool? directory) {
        FILE_INFO info; Check(GetFileInformationByHandle(handle, out info), "inspect creation object");
        bool isDirectory = (info.attributes & 0x10) != 0;
        if ((info.attributes & 0x400) != 0 || (directory.HasValue && directory.Value != isDirectory))
            throw new IOException("Creation refuses reparse or unexpected object types");
        if (!isDirectory && info.links != 1) throw new IOException("Creation refuses multiply linked files");
        if (isDirectory) {
            uint sensitive; Check(GetFileInformationByHandleEx(handle, 23, out sensitive, 4), "query directory case sensitivity");
            if ((sensitive & 1) != 0) throw new IOException("Creation refuses case-sensitive directories");
        }
        var final = new StringBuilder(32768);
        uint size = GetFinalPathNameByHandle(handle, final, 32768, 0);
        Check(size != 0, "resolve creation object");
        if (size >= 32768) throw new IOException("Resolved creation path exceeds limit");
        string resolved = final.ToString(); if (resolved.StartsWith(@"\\?\")) resolved = resolved.Substring(4);
        if (!Paths.Equals(resolved.TrimEnd('\\'), path.TrimEnd('\\'))) throw new IOException("Creation refuses path aliases");
        return info;
    }
    static SafeFileHandle Open(string path, uint access, uint share, bool? directory) {
        IntPtr raw = CreateFile(path, access, share, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        Check(raw != new IntPtr(-1), "open creation object " + path);
        var handle = new SafeFileHandle(raw, true);
        try { Inspect(handle, path, directory); return handle; } catch { handle.Dispose(); throw; }
    }
    sealed class ParentLeases : IDisposable {
        readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        public ParentLeases(string path) {
            Spelling(path); string parent = Path.GetDirectoryName(path);
            if (String.IsNullOrEmpty(parent)) throw new IOException("Creation cannot target a drive root");
            try {
                string current = path.Substring(0, 3); handles.Add(Open(current, 0x80, 3, true));
                if (parent.Length > 3) foreach (string part in parent.Substring(3).Split('\\')) {
                    current = Path.Combine(current, part); handles.Add(Open(current, 0x80, 3, true));
                }
            } catch { Dispose(); throw; }
        }
        public void Dispose() { foreach (var handle in handles) handle.Dispose(); handles.Clear(); }
    }
    static bool Matches(SafeFileHandle handle, string tag, bool directory) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) throw new Win32Exception((int)result, "read creation descriptor");
        try {
            uint size = GetSecurityDescriptorLength(descriptor);
            if (size == 0 || size > 65536) throw new IOException("Unexpected creation descriptor size");
            byte[] bytes = new byte[size]; Marshal.Copy(descriptor, bytes, 0, (int)size);
            var actual = new RawSecurityDescriptor(bytes, 0);
            var expected = new RawSecurityDescriptor(SecurityDescriptor(tag, directory), 0);
            return actual.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access)
                == expected.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
        } finally { LocalFree(descriptor); }
    }
    public static bool MatchesCreationTag(string path, string tag) {
        Tag(tag);
        try {
            using (var parents = new ParentLeases(path))
            using (var handle = Open(path, 0x20080, 3, null)) {
                var info = Inspect(handle, path, null); return Matches(handle, tag, (info.attributes & 0x10) != 0);
            }
        } catch (Win32Exception error) {
            if (error.NativeErrorCode == 2 || error.NativeErrorCode == 3) return false;
            throw;
        }
    }
    public static void CreateDirectory(string path, string tag) {
        byte[] descriptor = SecurityDescriptor(tag, true);
        using (var parents = new ParentLeases(path)) {
            IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
            try {
                Marshal.Copy(descriptor, 0, memory, descriptor.Length);
                var security = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), descriptor = memory };
                Check(NativeCreateDirectory(path, ref security), "exclusively create tagged directory");
            } finally { Marshal.FreeHGlobal(memory); }
            using (var handle = Open(path, 0x20080, 3, true)) {
                if (!Matches(handle, tag, true)) throw new IOException("Created directory descriptor differs from intent");
            }
        }
    }
    public static void CopyFile(string source, string temporary, string tag) {
        byte[] descriptor = SecurityDescriptor(tag, false);
        using (var sourceParents = new ParentLeases(source))
        using (var targetParents = new ParentLeases(temporary))
        using (var inputHandle = Open(source, 0x80000000, 1, false)) {
            IntPtr memory = Marshal.AllocHGlobal(descriptor.Length), attributes = IntPtr.Zero;
            SafeFileHandle outputHandle = null;
            try {
                Marshal.Copy(descriptor, 0, memory, descriptor.Length);
                var security = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), descriptor = memory };
                attributes = Marshal.AllocHGlobal(security.length); Marshal.StructureToPtr(security, attributes, false);
                IntPtr raw = CreateFile(temporary, 0x40020080, 1, attributes, 1, 0x80200080, IntPtr.Zero);
                Check(raw != new IntPtr(-1), "exclusively create tagged temporary file"); outputHandle = new SafeFileHandle(raw, true);
                Inspect(outputHandle, temporary, false);
                if (!Matches(outputHandle, tag, false)) throw new IOException("Created file descriptor differs from intent");
                using (var input = new FileStream(inputHandle, FileAccess.Read, 65536, false))
                using (var output = new FileStream(outputHandle, FileAccess.Write, 65536, false)) {
                    input.CopyTo(output); output.Flush(true);
                }
            } finally {
                if (outputHandle != null) outputHandle.Dispose();
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(memory);
            }
        }
    }
    // Recovery-only: the journal must name this exact private object and tag.
    // NTFS refuses nonempty directories; no recursive traversal or ACL update
    // occurs. The no-delete handle also prevents a checked leaf being renamed.
    public static void RemoveIncomplete(string path, string tag, bool directory) {
        Tag(tag);
        using (var parents = new ParentLeases(path))
        using (var handle = Open(path, 0x30080, 3, directory)) {
            if (!Matches(handle, tag, directory)) throw new IOException("Incomplete object does not match its durable creation tag");
            var disposition = new DISPOSITION { delete = true };
            Check(SetFileInformationByHandle(handle, 4, ref disposition, 4), "unlink verified incomplete private object");
        }
        if (File.Exists(path) || Directory.Exists(path)) throw new IOException("Incomplete object remains after unlink");
    }
}
