// Durable native lifecycle. The host caller is trusted; untrusted children are not.
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Collections;
using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32;

public class ReserveRequest { public string schema,mode; }
public class SessionRequest { public string schema,sessionId; }
public class LifecycleJournal {
 public string schema="fvs/windows-lifecycle-journal/v2",integritySha256,storageLayout,sessionId,phase,step,launcherPath,launcherSha256,originLogonId,sessionDirectory,stageRoot,controlDirectory,planSha256,stateSha256,profileRoot,profileSid,moniker,lastRunId,lastRunResultSha256,cleanupAuditSha256,terminalReceiptSha256;
 public int originSessionId,journalRevision,ownerProcessId; public string ownerCreationTimeUtc,sessionIdentity,controlIdentity,stageIdentity; public bool profileCreationIntended,stageRemovalIntended; public string[] disposablePaths=new string[0];
 public Dictionary<string,long> phaseTimingsMs=new Dictionary<string,long>();
}
public class NativeCleanupAudit {public List<Dictionary<string,object>> resources;public Dictionary<string,object> descendants;}
internal static partial class N {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateDirectory(string name,ref SECURITY_ATTRIBUTES sa);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool MoveFileEx(string from,string to,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateEvent(ref SECURITY_ATTRIBUTES sa,bool manual,bool initial,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr OpenEvent(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetEvent(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
 [StructLayout(LayoutKind.Sequential)] public struct GENERIC_MAPPING {public uint read,write,execute,all;}
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool AccessCheck(byte[] descriptor,IntPtr token,uint access,ref GENERIC_MAPPING mapping,IntPtr privileges,ref uint size,out uint granted,out bool status);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool GetVolumeInformation(string root,StringBuilder volume,uint volumeSize,out uint serial,out uint maximum,out uint flags,StringBuilder fs,uint fsSize);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandleEx(IntPtr file,int kind,out uint value,uint size);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct PROCESS_ENTRY {public uint size,usage,pid;public IntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string executable;}
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Process32First(IntPtr snapshot,ref PROCESS_ENTRY entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Process32Next(IntPtr snapshot,ref PROCESS_ENTRY entry);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct OS_VERSION {public uint size,major,minor,build,platform;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)]public string servicePack;public ushort serviceMajor,serviceMinor,suite;public byte product,reserved;}
 [DllImport("ntdll.dll")] public static extern int RtlGetVersion(ref OS_VERSION version);
 [StructLayout(LayoutKind.Sequential)] public struct SYSTEM_INFO {public ushort architecture,reserved;public uint pageSize;public IntPtr minimum,maximum;public UIntPtr mask;public uint processors,type,granularity;public ushort level,revision;}
 [DllImport("kernel32.dll")] public static extern void GetNativeSystemInfo(out SYSTEM_INFO information);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsWow64Process2(IntPtr process,out ushort processMachine,out ushort nativeMachine);
}

public static partial class FvsWindowsLauncher {
 const int MaximumEntries=250000, MaximumJournalBytes=1024*1024;
 static LifecycleJournal Active;
 static IntPtr CancelEvent=IntPtr.Zero;
 static bool RollbackPreparation;
 static string UserSid {get{return WindowsIdentity.GetCurrent().User.Value;}}
 static string UserKey {get{return HashBytes(Encoding.UTF8.GetBytes(UserSid)).Substring(0,16);}}
 // AppData writes can be virtualized by an MSIX host. The actual Windows
 // UserProfile known folder is shared by packaged and unpackaged callers.
 static string Coordinator {get{return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".fvs","windows-confinement");}}
 static string JournalPath {get{return Path.Combine(Coordinator,"active.json");}}
 static string JobName(string id) {return @"Global\FVS.Windows."+UserKey+"."+id;}
 static string CancelName(string id) {return @"Global\FVS.Windows.Cancel."+UserKey+"."+id;}
 static bool ValidId(string value) {return value!=null&&Regex.IsMatch(value,"^[0-9a-f]{32}$");}
 static Dictionary<string,object> HostFacts() {var version=new N.OS_VERSION{size=(uint)Marshal.SizeOf(typeof(N.OS_VERSION))};int status=N.RtlGetVersion(ref version);if(status!=0)throw new Exception("Native Windows version query failed NTSTATUS "+status);N.SYSTEM_INFO system;N.GetNativeSystemInfo(out system);ushort processMachine,nativeMachine;Check(N.IsWow64Process2(N.GetCurrentProcess(),out processMachine,out nativeMachine),"native architecture query");bool qualified=IntPtr.Size==8&&system.architecture==9&&nativeMachine==0x8664&&processMachine==0&&version.major==10&&version.minor==0&&version.build>=22000&&version.build<30000&&version.product==1;return new Dictionary<string,object>{{"schema","fvs/windows-host/v1"},{"qualified",qualified},{"major",version.major},{"minor",version.minor},{"build",version.build},{"productType",version.product},{"nativeArchitecture",system.architecture},{"nativeMachine",nativeMachine},{"processMachine",processMachine},{"pointerBits",IntPtr.Size*8},{"qualificationPolicy","Windows 11 client x64, native AMD64, build 22000..29999; no ARM64 emulation, Server or Windows 10"}};}
 static string LogonId() {
  IntPtr token;Check(N.OpenProcessToken(N.GetCurrentProcess(),8,out token),"open caller token");
  try{IntPtr memory=Marshal.AllocHGlobal(128);try{int count;Check(N.GetTokenInformation(token,10,memory,128,out count),"caller token statistics");return ((uint)Marshal.ReadInt32(memory,8)).ToString("x8")+((uint)Marshal.ReadInt32(memory,12)).ToString("x8");}finally{Marshal.FreeHGlobal(memory);}}finally{N.CloseHandle(token);}
 }
 static void RequireOrigin() {if(Active.originSessionId!=Process.GetCurrentProcess().SessionId||Active.originLogonId!=LogonId())throw new Exception("cross-logon-recovery-unqualified: actual alternate-logon validation is required; no mutation performed");}
 static void RequireLauncher() {if(Hash(Self)!=Active.launcherSha256)throw new Exception("recovery-launcher-required: use retained launcher "+Active.launcherPath+" sha256 "+Active.launcherSha256);}
 static Process ParentProcess() {IntPtr snapshot=N.CreateToolhelp32Snapshot(2,0);Check(snapshot!=new IntPtr(-1),"parent process snapshot");try{var entry=new N.PROCESS_ENTRY{size=(uint)Marshal.SizeOf(typeof(N.PROCESS_ENTRY))};bool found=N.Process32First(snapshot,ref entry);while(found){if(entry.pid==(uint)Process.GetCurrentProcess().Id)return Process.GetProcessById((int)entry.parent);found=N.Process32Next(snapshot,ref entry);}throw new Exception("Native parent process unavailable");}finally{N.CloseHandle(snapshot);}}
 static bool SameOwner() {using(var parent=ParentProcess())return parent.Id==Active.ownerProcessId&&parent.StartTime.ToUniversalTime().Ticks.ToString()==Active.ownerCreationTimeUtc;}
 static bool OwnerAlive() {try{using(var owner=Process.GetProcessById(Active.ownerProcessId))return !owner.HasExited&&owner.StartTime.ToUniversalTime().Ticks.ToString()==Active.ownerCreationTimeUtc;}catch(ArgumentException){return false;}}
 static void RequireOwner(bool recovery) {if(SameOwner())return;if(recovery&&!OwnerAlive())return;throw new Exception("live-session-owner: another process owns this reservation; stop copying/execution before recovery");}
 static byte[] PrivateDescriptor() {var acl=new DirectorySecurity();acl.SetOwner(WindowsIdentity.GetCurrent().User);acl.SetAccessRuleProtection(true,false);foreach(string value in new[]{UserSid,"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(value),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));return acl.GetSecurityDescriptorBinaryForm();}
 static void CreatePrivateDirectory(string directory) {
  Canonical(directory,true);byte[] bytes=PrivateDescriptor();IntPtr memory=Marshal.AllocHGlobal(bytes.Length);try{Marshal.Copy(bytes,0,memory,bytes.Length);var sa=new N.SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES)),descriptor=memory};Check(N.CreateDirectory(directory,ref sa),"create private directory "+directory);}finally{Marshal.FreeHGlobal(memory);}VerifyPrivate(directory);
 }
 static FileSystemSecurity Security(string file) {return Directory.Exists(file)?(FileSystemSecurity)Directory.GetAccessControl(file,AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group):File.GetAccessControl(file,AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group);}
 static void VerifyPrivate(string file) {
  Canonical(file,false);var acl=Security(file);if(!acl.GetOwner(typeof(SecurityIdentifier)).Equals(WindowsIdentity.GetCurrent().User))throw new Exception("Foreign-owned lifecycle object: "+file);
  var raw=new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(),0);if(raw.DiscretionaryAcl==null||!acl.AreAccessRulesCanonical)throw new Exception("Unsupported lifecycle DACL: "+file);
  foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&Writes)!=0&&!new[]{UserSid,"S-1-5-18","S-1-5-32-544"}.Contains(rule.IdentityReference.Value))throw new Exception("Untrusted lifecycle writer: "+file);
 }
 static void EnsureCoordinator() {
  string parent=Path.GetDirectoryName(Coordinator);Canonical(Path.GetDirectoryName(parent),false);
  if(!Directory.Exists(parent))CreatePrivateDirectory(parent);else VerifyPrivate(parent);
  if(!Directory.Exists(Coordinator))CreatePrivateDirectory(Coordinator);else VerifyPrivate(Coordinator);
  string sessions=Path.Combine(Coordinator,"s");if(!Directory.Exists(sessions))CreatePrivateDirectory(sessions);else VerifyPrivate(sessions);
 }
 sealed class LifecycleLease:IDisposable {
  FileStream stream;IntPtr directory;
  public LifecycleLease(){EnsureCoordinator();var sa=new N.SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES))};directory=N.CreateFile(Coordinator,0x80,3,ref sa,3,0x02200000,IntPtr.Zero);Check(directory!=new IntPtr(-1),"lease coordinator");VerifyFinalPath(directory,Coordinator);Identity(directory);try{string file=Path.Combine(Coordinator,"lifecycle.lock");stream=File.Open(file,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);VerifyPrivate(file);}catch{N.CloseHandle(directory);throw;}}
  public void Dispose(){if(CancelEvent!=IntPtr.Zero){N.CloseHandle(CancelEvent);CancelEvent=IntPtr.Zero;}if(stream!=null)stream.Dispose();N.CloseHandle(directory);}
 }
 static byte[] SnapshotBytes(string file,int maximum) {VerifyPrivate(file);using(var input=File.Open(file,FileMode.Open,FileAccess.Read,FileShare.Read)){if(input.Length>maximum)throw new Exception("Lifecycle file exceeds bound");using(var buffer=new MemoryStream()){input.CopyTo(buffer);return buffer.ToArray();}}}
 static void AtomicBytes(string file,byte[] bytes) {
  if(bytes.Length>128*1024*1024)throw new Exception("Lifecycle snapshot exceeds 128 MiB");VerifyPrivate(Path.GetDirectoryName(file));if(File.Exists(file))VerifyPrivate(file);
  string temporary=file+".pending-"+Guid.NewGuid().ToString("N");
  IoFailure("write:"+Path.GetFileName(file));using(var output=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None,65536,FileOptions.WriteThrough)){output.Write(bytes,0,bytes.Length);IoFailure("flush:"+Path.GetFileName(file));output.Flush(true);}
  VerifyPrivate(temporary);IoFailure("replace:"+Path.GetFileName(file));Check(N.MoveFileEx(temporary,file,9),"durable lifecycle replacement");if(Hash(file)!=HashBytes(bytes))throw new Exception("Lifecycle snapshot reread digest mismatch");
 }
 static void AtomicJson(string file,object value) {AtomicBytes(file,new UTF8Encoding(false).GetBytes(Json.Serialize(value)));}
 static string CanonicalJson(object value) {var map=value as IDictionary;if(map!=null){var keys=new List<string>();foreach(object key in map.Keys)keys.Add((string)key);keys.Sort(StringComparer.Ordinal);return "{"+String.Join(",",keys.Select(k=>Json.Serialize(k)+":"+CanonicalJson(map[k])))+"}";}var list=value as IEnumerable;if(list!=null&&!(value is string)){var values=new List<string>();foreach(object item in list)values.Add(CanonicalJson(item));return "["+String.Join(",",values)+"]";}return Json.Serialize(value);}
 static string JournalDigest(LifecycleJournal journal) {var value=(Dictionary<string,object>)Json.DeserializeObject(Json.Serialize(journal));value.Remove("integritySha256");return HashBytes(Encoding.UTF8.GetBytes(CanonicalJson(value)));}
 static void Persist(string phase,string step) {Active.phase=phase;Active.step=step;Active.journalRevision++;Active.integritySha256=JournalDigest(Active);AtomicJson(JournalPath,Active);}
 static void Fault(string point) {
#if FVS_NATIVE_TEST_HOOKS
  if(Environment.GetEnvironmentVariable("FVS_NATIVE_FAULT")==point){N.TerminateProcess(N.GetCurrentProcess(),197);Environment.FailFast("fault injection termination failed");}
#endif
 }
 static void IoFailure(string point) {
#if FVS_NATIVE_TEST_HOOKS
  if(Environment.GetEnvironmentVariable("FVS_NATIVE_IO_FAULT")==point)throw new IOException("Injected durable I/O failure: "+point);
#endif
 }
 static void Mutation(string name,Action action) {var elapsed=Stopwatch.StartNew();Fault(name+":before-intent");Persist(Active.phase,name+":intent");Fault(name+":after-intent");action();Fault(name+":after-mutation");Active.phaseTimingsMs[name]=elapsed.ElapsedMilliseconds;Persist(Active.phase,name+":complete");Fault(name+":after-completion");CancellationCheckpoint();}
 static void StartCancellation() {byte[] bytes=PrivateDescriptor();IntPtr memory=Marshal.AllocHGlobal(bytes.Length);try{Marshal.Copy(bytes,0,memory,bytes.Length);var sa=new N.SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES)),descriptor=memory};CancelEvent=N.CreateEvent(ref sa,true,false,CancelName(Active.sessionId));Check(CancelEvent!=IntPtr.Zero,"create cancellation event");if(Marshal.GetLastWin32Error()==183)throw new Exception("Cancellation event identity collision");}finally{Marshal.FreeHGlobal(memory);}}
 static bool CancellationRequested() {return CancelEvent!=IntPtr.Zero&&N.WaitForSingleObject(CancelEvent,0)==0;}
 static void CancellationCheckpoint() {if(CancellationRequested())throw new OperationCanceledException("Native lifecycle cancellation requested");}
 static IntPtr CreatePrivateJob(string name) {byte[] bytes=PrivateDescriptor();IntPtr memory=Marshal.AllocHGlobal(bytes.Length),attributes=IntPtr.Zero;try{Marshal.Copy(bytes,0,memory,bytes.Length);var sa=new N.SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES)),descriptor=memory};attributes=Marshal.AllocHGlobal(sa.length);Marshal.StructureToPtr(sa,attributes,false);return N.CreateJobObject(attributes,name);}finally{if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);Marshal.FreeHGlobal(memory);}}
 static LifecycleJournal ReadJournal() {
  if(!File.Exists(JournalPath))return null;string snapshot=Encoding.UTF8.GetString(SnapshotBytes(JournalPath,MaximumJournalBytes));var journal=Json.Deserialize<LifecycleJournal>(snapshot);
  if(journal.integritySha256!=null){var raw=(Dictionary<string,object>)Json.DeserializeObject(snapshot);raw.Remove("integritySha256");if(journal.integritySha256!=HashBytes(Encoding.UTF8.GetBytes(CanonicalJson(raw))))throw new Exception("Lifecycle journal checksum mismatch");}
  if(!new[]{"reserving","reserved","preparing","prepared","running","run-complete","disposing","recovering","recovery-required","disposed","recovered"}.Contains(journal.phase))throw new Exception("Unknown lifecycle phase");
  if(journal.integritySha256==null&&!Terminal(journal))throw new Exception("Legacy incomplete journal requires its recorded retained launcher");
  bool compact=journal.storageLayout=="compact-v1";if(journal.storageLayout!=null&&!compact)throw new Exception("Unsupported lifecycle storage layout");
  if(journal.schema!="fvs/windows-lifecycle-journal/v2"||!ValidId(journal.sessionId)||journal.sessionDirectory!=Path.Combine(Coordinator,compact?"s":"sessions",journal.sessionId)||journal.controlDirectory!=Path.Combine(journal.sessionDirectory,compact?"c":"control")||journal.stageRoot!=Path.Combine(journal.sessionDirectory,compact?"s":"stage")||journal.moniker!="FVS.Windows."+journal.sessionId)throw new Exception("Untrusted lifecycle journal paths or identity");
  if(journal.profileRoot!=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Packages",journal.moniker))throw new Exception("Untrusted journal profile path");
  IntPtr sid;int hr=N.DeriveAppContainerSidFromAppContainerName(journal.moniker,out sid);if(hr!=0)Marshal.ThrowExceptionForHR(hr);try{if(new SecurityIdentifier(sid).Value!=journal.profileSid)throw new Exception("Untrusted journal profile SID");}finally{N.FreeSid(sid);}
  foreach(string directory in new[]{journal.sessionDirectory,journal.controlDirectory})if(Directory.Exists(directory))VerifyPrivate(directory);
  foreach(var item in new[]{new[]{journal.sessionDirectory,journal.sessionIdentity},new[]{journal.controlDirectory,journal.controlIdentity},new[]{journal.stageRoot,journal.stageIdentity}})if(item[1]!=null&&Directory.Exists(item[0])&&PathIdentity(item[0])!=item[1])throw new Exception("Lifecycle directory identity changed: "+item[0]);
  if(Terminal(journal)){string file=Path.Combine(journal.controlDirectory,"terminal-receipt.json");byte[] bytes=SnapshotBytes(file,128*1024*1024);if(journal.terminalReceiptSha256!=null&&HashBytes(bytes)!=journal.terminalReceiptSha256)throw new Exception("Terminal receipt digest mismatch");var receipt=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes));if((string)receipt["sessionId"]!=journal.sessionId||!(bool)receipt["profileAbsent"]||!(bool)receipt["stageRemoved"]||!(bool)receipt["aclCleanupConfirmed"]||Directory.Exists(journal.profileRoot)||Directory.Exists(journal.stageRoot))throw new Exception("Terminal session cleanup not confirmed");}
  return journal;
 }
 static bool Terminal(LifecycleJournal journal) {return journal!=null&&(journal.phase=="disposed"||journal.phase=="recovered");}
 static Dictionary<string,object> SetupRecovery(bool locked) {
  string marker=Path.Combine(Coordinator,"setup-active.json");if(!File.Exists(marker)&&!Directory.Exists(marker))return null;
  var value=Json.Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(SnapshotBytes(marker,MaximumJournalBytes)));
  object checksum;if(!value.TryGetValue("integritySha256",out checksum)||!(checksum is string))throw new Exception("Setup lifecycle marker has no checksum");value.Remove("integritySha256");
  if((string)checksum!=HashBytes(Encoding.UTF8.GetBytes(CanonicalJson(value))))throw new Exception("Setup lifecycle marker checksum mismatch");
  object schema,id,installation,user;if(!value.TryGetValue("schema",out schema)||(string)schema!="fvs/windows-source-setup-active/v1"||!value.TryGetValue("sessionId",out id)||!(id is string)||!Regex.IsMatch((string)id,"^setup:[0-9a-f]{32}$")||!value.TryGetValue("installationId",out installation)||!(installation is string)||!ValidId((string)installation)||(string)id!="setup:"+(string)installation||!value.TryGetValue("userSid",out user)||(string)user!=UserSid)throw new Exception("Invalid setup lifecycle marker identity");
  var result=Result(false,locked?"busy":"recovery-required");result["sessionId"]=id;result["recoveryKind"]="setup";Diagnostics(result).Add("Explicit source setup recovery is required before native lifecycle operations");return result;
 }
 static void CheckOrphanDirectories() {
  foreach(string root in new[]{"sessions","s"}){string parent=Path.Combine(Coordinator,root);if(!Directory.Exists(parent))continue;VerifyPrivate(parent);foreach(string directory in Directory.EnumerateDirectories(parent)){VerifyPrivate(directory);string name=Path.GetFileName(directory);if(!ValidId(name))throw new Exception("Unknown lifecycle session directory");if(Active!=null&&name==Active.sessionId)continue;string receipt=Path.Combine(directory,root=="s"?"c":"control","terminal-receipt.json");if(!File.Exists(receipt))throw new Exception("recovery-required: retained session has no terminal receipt "+name);var value=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(SnapshotBytes(receipt,MaximumJournalBytes)));if(!value.ContainsKey("sessionId")||(string)value["sessionId"]!=name||!value.ContainsKey("stageRemoved")||!(bool)value["stageRemoved"])throw new Exception("Invalid retained terminal receipt");}}
 }
 static Dictionary<string,object> ReserveManaged(ReserveRequest request) {
  if(request.schema!="fvs/windows-reserve/v2"||!(request.mode=="readonly"||request.mode=="staged"))throw new Exception("Invalid reserve request");
  var setup=SetupRecovery(false);if(setup!=null)return setup;
  Active=ReadJournal();CheckOrphanDirectories();if(Active!=null&&!Terminal(Active))throw new Exception("recovery-required: an active session already exists");
  string id=Guid.NewGuid().ToString("N"),moniker="FVS.Windows."+id;IntPtr sid;int hr=N.DeriveAppContainerSidFromAppContainerName(moniker,out sid);if(hr!=0)Marshal.ThrowExceptionForHR(hr);string profileSid;try{profileSid=new SecurityIdentifier(sid).Value;}finally{N.FreeSid(sid);}
  Active=new LifecycleJournal{storageLayout="compact-v1",sessionId=id,phase="reserving",launcherPath=Self,launcherSha256=Hash(Self),originSessionId=Process.GetCurrentProcess().SessionId,originLogonId=LogonId(),sessionDirectory=Path.Combine(Coordinator,"s",id),moniker=moniker,profileSid=profileSid,profileRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Packages",moniker)};
  using(var owner=ParentProcess()){Active.ownerProcessId=owner.Id;Active.ownerCreationTimeUtc=owner.StartTime.ToUniversalTime().Ticks.ToString();}Active.controlDirectory=Path.Combine(Active.sessionDirectory,"c");Active.stageRoot=Path.Combine(Active.sessionDirectory,"s");Persist("reserving","claim:intent");StartCancellation();
  Mutation("create-session",()=>{CreatePrivateDirectory(Active.sessionDirectory);Active.sessionIdentity=PathIdentity(Active.sessionDirectory);});Mutation("create-control",()=>{CreatePrivateDirectory(Active.controlDirectory);Active.controlIdentity=PathIdentity(Active.controlDirectory);});Mutation("create-stage",()=>{CreatePrivateDirectory(Active.stageRoot);Active.stageIdentity=PathIdentity(Active.stageRoot);});Persist("reserved","reservation:complete");
  var result=Result(true,"reserved");SessionFields(result);return result;
 }
 static void SessionFields(Dictionary<string,object> result) {result["sessionId"]=Active.sessionId;result["stageRoot"]=Active.stageRoot;result["controlDirectory"]=Active.controlDirectory;result["statePath"]=Path.Combine(Active.controlDirectory,"state.json");result["journalRevision"]=Active.journalRevision;result["launcherSha256"]=Active.launcherSha256;result["phaseTimingsMs"]=Active.phaseTimingsMs;}
 static void RequireSession(string id) {Active=ReadJournal();if(Active==null||!ValidId(id)||Active.sessionId!=id)throw new Exception("Session identity mismatch");RequireOrigin();RequireLauncher();RequireOwner(false);}
 static void RequireSupportedAcl(string file) {
  var acl=Security(file);var raw=new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(),0);
  if(raw.DiscretionaryAcl==null||!acl.AreAccessRulesCanonical)throw new Exception("Null or noncanonical resource DACL is unsupported: "+file);
  foreach(GenericAce ace in raw.DiscretionaryAcl)if(!(ace is CommonAce)||((CommonAce)ace).IsCallback)throw new Exception("Conditional/object-specific resource ACEs are unsupported: "+file);
  RejectAmbientWrites(file);
 }
 static void RequireAclWrite(string file) {var sa=new N.SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES))};IntPtr handle=N.CreateFile(file,0x60080,7,ref sa,3,0x02200000,IntPtr.Zero);Check(handle!=new IntPtr(-1),"resource ACL write permission "+file);try{VerifyFinalPath(handle,file);Identity(handle);}finally{N.CloseHandle(handle);}}
 static void GrantReadonlyEntry(Entry entry,SecurityIdentifier sid) {
  if(PathIdentity(entry.path)!=entry.identity)throw new Exception("Readonly entry changed before grant");var acl=Security(entry.path);acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.ReadAndExecute,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));string expected=acl.GetSecurityDescriptorSddlForm(AccessControlSections.Owner|AccessControlSections.Access);SetShallowDescriptor(entry.path,new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(),0));if(Acl(entry.path)!=expected)throw new Exception("Readonly grant changed unrelated ACL semantics");
 }
 static Dictionary<string,object> PrepareManaged(PrepareRequest request) {
  if(request.schema!="fvs/windows-prepare/v2")throw new Exception("Unknown prepare schema");RequireSession(request.sessionId);if(Active.phase!="reserved")throw new Exception("Session is not reserved");RollbackPreparation=true;StartCancellation();
  if(request.controlDirectory!=null&&!Paths.Equals(request.controlDirectory,Active.controlDirectory))throw new Exception("Control directory must be the reserved native path");
  var state=new PreparedState{schema="fvs/windows-prepared-state/v2",sessionId=Active.sessionId,stageRoot=Active.stageRoot,controlDirectory=Active.controlDirectory,launcherSha256=Active.launcherSha256,moniker=Active.moniker,profileSid=Active.profileSid,profileRoot=Active.profileRoot,privateTemp=Path.Combine(Active.profileRoot,"AC","Temp"),jobName=JobName(Active.sessionId),profileTempWritable=request.profileTempWritable};
  var ro=(request.readOnlyPaths??new string[0]).Select(p=>Canonical(p,false)).Distinct(Paths).ToArray();var rw=(request.writablePaths??new string[0]).Select(p=>Canonical(p,false)).Distinct(Paths).ToArray();var disposable=(request.disposablePaths??new string[0]).Select(p=>Canonical(p,false)).ToArray();
  if(disposable.Length!=rw.Length||disposable.Distinct(Paths).Count()!=disposable.Length||rw.Any(p=>!disposable.Contains(p,Paths)))throw new Exception("Disposable paths must exactly equal writable roots");
  foreach(string file in rw)if(!Directory.Exists(file)||!Contains(Active.stageRoot,file)||Paths.Equals(Active.stageRoot,file))throw new Exception("Writable roots must be directories inside the reserved stage");
  var all=ro.Concat(rw).ToArray();for(int i=0;i<all.Length;i++){if(Contains(all[i],Coordinator)||(Contains(Coordinator,all[i])&&!Contains(Active.stageRoot,all[i]))||Contains(all[i],state.profileRoot)||Contains(state.profileRoot,all[i]))throw new Exception("Resource overlaps private lifecycle/profile storage");for(int j=i+1;j<all.Length;j++)if(Contains(all[i],all[j])||Contains(all[j],all[i]))throw new Exception("Resource roots must be disjoint");}
  foreach(string file in all)state.resources.Add(new Resource{path=file,identity=PathIdentity(file),beforeAcl=Acl(file),writable=rw.Contains(file,Paths),directory=Directory.Exists(file)});
  string profile=Canonical(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),false);if(all.Any(p=>Contains(p,profile)))throw new Exception("General user-profile resource grant is unsupported");state.resources.Add(new Resource{path=profile,identity=PathIdentity(profile),beforeAcl=Acl(profile),directory=true,metadataOnly=true});
  foreach(var resource in state.resources){RequireAclWrite(resource.path);foreach(string file in Members(resource)){CancellationCheckpoint();RequireSupportedAcl(file);if(!resource.writable)RequireAclWrite(file);state.entries.Add(new Entry{path=file,identity=PathIdentity(file),beforeAcl=Acl(file),directory=Directory.Exists(file)});if(state.entries.Count>MaximumEntries)throw new Exception("Resource entry count exceeds 250000");}}
  foreach(string raw in request.executablePaths??new string[0]){string file=Canonical(raw,false);if(!file.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)||!File.Exists(file)||!ro.Any(p=>Contains(p,file)))throw new Exception("Entrypoints must be exact readonly executables");state.binaries.Add(new Binary{path=file,sha256=Hash(file)});}if(state.binaries.Count==0)throw new Exception("At least one executable is required");
  byte[] plan=new UTF8Encoding(false).GetBytes(Json.Serialize(state));Active.disposablePaths=disposable;Active.planSha256=HashBytes(plan);Persist("preparing","plan:intent");AtomicBytes(Path.Combine(Active.controlDirectory,"plan.json"),plan);Persist("preparing","plan:complete");
  if(Directory.Exists(state.profileRoot)||ProfileMappingExists(state.profileSid))throw new Exception("Profile identity already exists before creation");Active.profileCreationIntended=true;IntPtr package=IntPtr.Zero;
  try{
   Mutation("create-profile",()=>{int hr=N.CreateAppContainerProfile(state.moniker,state.moniker,"FVS Windows confinement",IntPtr.Zero,0,out package);if(hr!=0)Marshal.ThrowExceptionForHR(hr);if(new SecurityIdentifier(package).Value!=state.profileSid)throw new Exception("Created profile SID mismatch");});
   string ac=Canonical(ProfilePath(state.profileSid),false);if(!Paths.Equals(Directory.GetParent(ac).FullName,state.profileRoot))throw new Exception("Unexpected profile storage path");var identity=new SecurityIdentifier(state.profileSid);
   Mutation("create-temp",()=>{if(!Directory.Exists(state.privateTemp))Directory.CreateDirectory(state.privateTemp);});
   Mutation("harden-profile",()=>{foreach(string file in Walk(state.profileRoot).Reverse())PrivateAcl(file,identity,FileSystemRights.ReadAndExecute);if(state.profileTempWritable)Grant(state.privateTemp,identity,true);state.profileRootAcl=Acl(state.profileRoot);});
   for(int n=0;n<state.resources.Count;n++){var resource=state.resources[n];Mutation("grant-"+n,()=>{if(PathIdentity(resource.path)!=resource.identity)throw new Exception("Resource identity changed before grant");if(resource.metadataOnly)ShallowProfileGrant(resource.path,identity,false);else if(resource.writable)Grant(resource.path,identity,true);else {int index=0;foreach(var entry in state.entries.Where(e=>Contains(resource.path,e.path))){Fault("grant-entry-"+n+"-"+index+":before-mutation");GrantReadonlyEntry(entry,identity);Fault("grant-entry-"+n+"-"+index+":after-mutation");CancellationCheckpoint();index++;}}resource.preparedAcl=Acl(resource.path);});}
   foreach(var entry in state.entries){CancellationCheckpoint();if(PathIdentity(entry.path)!=entry.identity)throw new Exception("Resource identity changed while preparing");entry.acl=Acl(entry.path);entry.beforeAcl=null;}
   byte[] prepared=new UTF8Encoding(false).GetBytes(Json.Serialize(state));Active.stateSha256=HashBytes(prepared);Mutation("publish-state",()=>AtomicBytes(Path.Combine(state.controlDirectory,"state.json"),prepared));
   foreach(string name in new[]{"run.lock","handle-sentinel"})Mutation("create-"+name,()=>AtomicBytes(Path.Combine(state.controlDirectory,name),new byte[0]));Persist("prepared","prepare:complete");
   var result=Result(true,"prepared");SessionFields(result);result["stateSha256"]=Active.stateSha256;result["profileSid"]=state.profileSid;result["profileRoot"]=state.profileRoot;result["privateTemp"]=state.privateTemp;RollbackPreparation=false;return result;
  }finally{if(package!=IntPtr.Zero)N.FreeSid(package);}
 }
 static PreparedState ReadPlan() {string file=Path.Combine(Active.controlDirectory,"plan.json");byte[] bytes=SnapshotBytes(file,128*1024*1024);if(HashBytes(bytes)!=Active.planSha256)throw new Exception("Recovery plan digest mismatch");var state=Json.Deserialize<PreparedState>(Encoding.UTF8.GetString(bytes));if(state.sessionId!=Active.sessionId||state.controlDirectory!=Active.controlDirectory||state.stageRoot!=Active.stageRoot||state.moniker!=Active.moniker||state.profileSid!=Active.profileSid||state.profileRoot!=Active.profileRoot||state.jobName!=JobName(Active.sessionId)||state.launcherSha256!=Active.launcherSha256)throw new Exception("Recovery plan binding mismatch");return state;}
 static RawSecurityDescriptor WithoutSid(string sddl,string sid) {var raw=new RawSecurityDescriptor(sddl);if(raw.DiscretionaryAcl==null)throw new Exception("Null recovery DACL");for(int n=raw.DiscretionaryAcl.Count-1;n>=0;n--){var ace=raw.DiscretionaryAcl[n] as KnownAce;if(ace!=null&&ace.SecurityIdentifier.Value==sid)raw.DiscretionaryAcl.RemoveAce(n);}return raw;}
 static bool SameAclRules(RawSecurityDescriptor a,RawSecurityDescriptor b) {if(!a.Owner.Equals(b.Owner)||a.DiscretionaryAcl.Count!=b.DiscretionaryAcl.Count)return false;for(int n=0;n<a.DiscretionaryAcl.Count;n++){byte[] x=new byte[a.DiscretionaryAcl[n].BinaryLength],y=new byte[b.DiscretionaryAcl[n].BinaryLength];a.DiscretionaryAcl[n].GetBinaryForm(x,0);b.DiscretionaryAcl[n].GetBinaryForm(y,0);if(!x.SequenceEqual(y))return false;}return true;}
 static void SetShallowDescriptor(string file,RawSecurityDescriptor descriptor) {byte[] bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);bool auto=(descriptor.ControlFlags&ControlFlags.DiscretionaryAclAutoInherited)!=0;Check(N.SetSecurityDescriptorControl(bytes,0x0500,(ushort)(auto?0x0500:0)),"preserve recovery DACL control");Check(N.SetFileSecurity(file,4,bytes),"restore own ACL delta "+file);}
 static List<Dictionary<string,object>> LastAclResults=new List<Dictionary<string,object>>();
 static Dictionary<string,object> LastDescendantAudit;
 static bool RemovedStagePath(string file) {return Active.stageRemovalIntended&&Active.cleanupAuditSha256!=null&&Contains(Active.stageRoot,file)&&!File.Exists(file)&&!Directory.Exists(file);}
 static NativeCleanupAudit ReadCleanupAudit() {if(Active.cleanupAuditSha256==null)return null;byte[] bytes=SnapshotBytes(Path.Combine(Active.controlDirectory,"cleanup-audit.json"),128*1024*1024);if(HashBytes(bytes)!=Active.cleanupAuditSha256)throw new Exception("Cleanup audit digest mismatch");var audit=Json.Deserialize<NativeCleanupAudit>(Encoding.UTF8.GetString(bytes));if(audit.resources==null||audit.descendants==null||Convert.ToInt32(audit.descendants["ownSidRemaining"])!=0)throw new Exception("Incomplete cleanup audit");return audit;}
 static List<string> CleanupManaged(PreparedState supplied,bool removeProfile) {
  var errors=new List<string>();PreparedState plan;NativeCleanupAudit previous=null;try{plan=ReadPlan();previous=ReadCleanupAudit();foreach(var resource in plan.resources){if(RemovedStagePath(resource.path))continue;Canonical(resource.path,false);if(PathIdentity(resource.path)!=resource.identity)throw new Exception("Resource identity changed: "+resource.path);foreach(string file in Members(resource)){} }if(Directory.Exists(plan.profileRoot))foreach(string file in Walk(plan.profileRoot)){}foreach(var entry in plan.entries)if(File.Exists(entry.path)||Directory.Exists(entry.path)){if(PathIdentity(entry.path)!=entry.identity)throw new Exception("Original descendant identity changed: "+entry.path);}else if(!RemovedStagePath(entry.path)&&!plan.resources.Any(r=>r.writable&&Contains(r.path,entry.path)))throw new Exception("Protected descendant disappeared: "+entry.path);}catch(Exception ex){errors.Add("Cleanup preflight refused before ACL mutation: "+ex.Message);return errors;}
  LastAclResults=new List<Dictionary<string,object>>();var changed=new List<string>();int checkedEntries=0;
  try{
   // One durable intent names each snapshotted resource subtree before the
   // inheritance API touches its descendants. The immutable plan contains every
   // original descendant identity and descriptor, including for partial failure.
   for(int n=plan.resources.Count-1;n>=0;n--){var resource=plan.resources[n];if((!resource.writable&&!resource.metadataOnly)||RemovedStagePath(resource.path)||!Acl(resource.path).Contains(plan.profileSid))continue;Mutation("remove-resource-"+n,()=>{if(resource.metadataOnly)ShallowProfileGrant(resource.path,new SecurityIdentifier(plan.profileSid),true);else RemoveGrant(resource.path,new SecurityIdentifier(plan.profileSid));});}
   // Restore each original entry with a non-propagating setter. This removes a
   // partially propagated own grant without replaying stale unrelated ACEs.
   // This intent binds the complete pre-mutation manifest, so every individual
   // setter below is covered even if the process dies between two entries.
   Persist(Active.phase,"remove-original-descendants:intent");
   foreach(var entry in plan.entries.AsEnumerable().Reverse()){
    if(!File.Exists(entry.path)&&!Directory.Exists(entry.path))continue;string current=Acl(entry.path);var stripped=WithoutSid(current,plan.profileSid);var before=new RawSecurityDescriptor(entry.beforeAcl);
    if(SameAclRules(stripped,before))stripped.SetFlags(before.ControlFlags);
    string desired=stripped.GetSddlForm(AccessControlSections.Owner|AccessControlSections.Access);
    if(current!=desired){Fault("remove-entry-"+checkedEntries+":before-mutation");if(PathIdentity(entry.path)!=entry.identity)throw new Exception("Descendant identity changed before ACL cleanup");SetShallowDescriptor(entry.path,stripped);if(Acl(entry.path)!=desired)throw new Exception("ACL cleanup postcheck mismatch");Fault("remove-entry-"+checkedEntries+":after-mutation");CancellationCheckpoint();}
    string after=Acl(entry.path);if(after.Contains(plan.profileSid))throw new Exception("Own SID remains on original descendant");if(after!=entry.beforeAcl)changed.Add(entry.path);checkedEntries++;
   }
   Persist(Active.phase,"remove-original-descendants:complete");
   // New descendants in writable copies can carry inherited own grants; remove
   // them too without ever following an alias or touching another inode.
   foreach(var resource in plan.resources){if(RemovedStagePath(resource.path)){var prior=previous.resources.SingleOrDefault(r=>(string)r["path"]==resource.path);if(prior==null)throw new Exception("Missing pre-removal ACL evidence");LastAclResults.Add(prior);continue;}foreach(string file in Members(resource)){string current=Acl(file);if(current.Contains(plan.profileSid)){var stripped=WithoutSid(current,plan.profileSid);Mutation("remove-created-entry",()=>SetShallowDescriptor(file,stripped));if(Acl(file).Contains(plan.profileSid))throw new Exception("Own SID remains on created descendant");}}string acl=Acl(resource.path);LastAclResults.Add(new Dictionary<string,object>{{"path",resource.path},{"beforeAcl",resource.beforeAcl},{"currentAcl",acl},{"exactRestored",resource.beforeAcl==acl}});}
   LastDescendantAudit=new Dictionary<string,object>{{"checked",checkedEntries},{"exactRestored",changed.Count==0},{"changedPreserved",changed},{"ownSidRemaining",0}};
   if(removeProfile)Mutation("delete-profile",()=>{int hr=N.DeleteAppContainerProfile(plan.moniker);if(hr!=0&&hr!=unchecked((int)0x80070002))Marshal.ThrowExceptionForHR(hr);if(Directory.Exists(plan.profileRoot)||ProfileMappingExists(plan.profileSid))throw new Exception("Profile remains after deletion");});
  }catch(Exception ex){errors.Add(ex.Message);}return errors;
 }
 static bool ProfileMappingExists(string sid) {using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings\"+sid,false))return key!=null;}
 static void AuthorizePrivateCleanup(PreparedState state,string[] roots) {if(roots.Length!=Active.disposablePaths.Length||roots.Distinct(Paths).Count()!=roots.Length||roots.Any(p=>!Active.disposablePaths.Contains(p,Paths)))throw new Exception("Private cleanup differs from reserved disposable root set");}
 static void RemoveStage() {
  if(!Directory.Exists(Active.stageRoot))return;Canonical(Active.stageRoot,false);string identity=VerifiedPrivateLeafCleanup.DirectoryIdentity(Active.stageRoot);if(Active.stageIdentity!=null&&identity!=Active.stageIdentity)throw new Exception("Reserved stage identity changed");VerifiedPrivateLeafCleanup.Clean(new[]{Active.stageRoot},new[]{identity},JobName(Active.sessionId));
  foreach(string directory in Walk(Active.stageRoot).Reverse()){if(!Directory.Exists(directory))throw new Exception("Stage cleanup leaf remains");Directory.Delete(directory,false);Fault("remove-stage-directory:"+Path.GetFileName(directory)+":after-mutation");}if(Directory.Exists(Active.stageRoot))throw new Exception("Reserved stage remains");
 }
 static void CompleteSession(PreparedState state,Dictionary<string,object> result,string terminal) {
  if(Active.cleanupAuditSha256==null){byte[] audit=new UTF8Encoding(false).GetBytes(Json.Serialize(new NativeCleanupAudit{resources=LastAclResults,descendants=LastDescendantAudit}));Mutation("persist-cleanup-audit",()=>{AtomicBytes(Path.Combine(Active.controlDirectory,"cleanup-audit.json"),audit);Active.cleanupAuditSha256=HashBytes(audit);});}
  Active.stageRemovalIntended=true;Mutation("remove-stage",RemoveStage);var receipt=new Dictionary<string,object>{{"schema","fvs/windows-terminal-receipt/v2"},{"sessionId",Active.sessionId},{"stageRoot",Active.stageRoot},{"controlDirectory",Active.controlDirectory},{"stateSha256",Active.stateSha256},{"launcherSha256",Active.launcherSha256},{"lastRunId",Active.lastRunId},{"lastRunResultSha256",Active.lastRunResultSha256},{"status",terminal},{"jobDrained",true},{"profileAbsent",!Directory.Exists(Active.profileRoot)&&!ProfileMappingExists(Active.profileSid)},{"stageRemoved",!Directory.Exists(Active.stageRoot)},{"aclCleanupConfirmed",true},{"resourceAclResults",LastAclResults},{"descendantAclAudit",LastDescendantAudit},{"journalRevision",Active.journalRevision+4}};
  string file=Path.Combine(Active.controlDirectory,"terminal-receipt.json");Mutation("terminal-receipt",()=>{AtomicJson(file,receipt);Active.terminalReceiptSha256=Hash(file);});Fault("session-release:before-intent");Persist(Active.phase,"session-release:intent");Fault("session-release:after-intent");Persist(terminal,"session-release:complete");Fault("session-release:after-mutation");Fault("session-release:after-completion");result["terminalReceiptPath"]=file;result["terminalReceiptSha256"]=Hash(file);SessionFields(result);
 }
 static Dictionary<string,object> RecoverManaged(SessionRequest request) {
  if(request.schema!="fvs/windows-recover/v2")throw new Exception("Unknown recover schema");Active=ReadJournal();if(Active==null){return Result(true,"idle");}if(request.sessionId!=null&&request.sessionId!=Active.sessionId)throw new Exception("Recovery session mismatch");RequireOrigin();RequireLauncher();RequireOwner(true);
  if(Terminal(Active)){var prior=Result(true,Active.phase);SessionFields(prior);string file=Path.Combine(Active.controlDirectory,"terminal-receipt.json");VerifyPrivate(file);prior["terminalReceiptPath"]=file;prior["terminalReceiptSha256"]=Hash(file);return prior;}
  if(Active.stageRemovalIntended&&ReadCleanupAudit()==null)throw new Exception("Stage removal intent without cleanup audit");StartCancellation();Persist("recovering","recovery:start");VerifiedPrivateLeafCleanup.DrainNamedJob(JobName(Active.sessionId));
  if(!Directory.Exists(Active.sessionDirectory))Mutation("recover-session-directory",()=>CreatePrivateDirectory(Active.sessionDirectory));if(!Directory.Exists(Active.controlDirectory))Mutation("recover-control-directory",()=>CreatePrivateDirectory(Active.controlDirectory));
  PreparedState state=null;int deleted=0;
  if(!String.IsNullOrEmpty(Active.planSha256)&&File.Exists(Path.Combine(Active.controlDirectory,"plan.json"))){state=ReadPlan();if(Active.disposablePaths.Length!=0&&Directory.Exists(Active.stageRoot)){var roots=state.resources.Where(r=>r.writable&&!RemovedStagePath(r.path)).ToArray();if(roots.Length!=0)deleted=VerifiedPrivateLeafCleanup.Clean(roots.Select(r=>r.path).ToArray(),roots.Select(r=>r.identity).ToArray(),state.jobName);}var failures=CleanupManaged(state,Active.profileCreationIntended);if(failures.Count!=0)throw new Exception(String.Join("; ",failures));}
  else {if(Active.profileCreationIntended)throw new Exception("Profile intent without durable resource plan");LastAclResults=new List<Dictionary<string,object>>();LastDescendantAudit=new Dictionary<string,object>{{"checked",0},{"exactRestored",true},{"changedPreserved",new string[0]},{"ownSidRemaining",0}};}
  var result=Result(true,"recovered");result["privateLeavesDeleted"]=deleted;CompleteSession(state,result,"recovered");return result;
 }
 static void VerifyRestrictedReadonly(IntPtr token,PreparedState state) {
  IntPtr duplicate;Check(N.DuplicateToken(token,2,out duplicate),"duplicate restricted token for effective access");try{
   var mapping=new N.GENERIC_MAPPING{read=0x120089,write=0x120116,execute=0x1200a0,all=0x1f01ff};uint size=4096;IntPtr privileges=Marshal.AllocHGlobal((int)size);try{
    foreach(string group in new[]{"S-1-15-2-1","S-1-15-2-2"}){var descriptor=new RawSecurityDescriptor("O:"+UserSid+"G:"+UserSid+"D:(A;;FA;;;"+UserSid+")(A;;FR;;;"+group+")");byte[] bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);uint granted,available=size;bool access;Check(N.AccessCheck(bytes,duplicate,1,ref mapping,privileges,ref available,out granted,out access),"LPAC group effective-access qualification");if(access!=(group=="S-1-15-2-2"))throw new Exception("LPAC AAP opt-out/ARAP effective access qualification failed");}
    foreach(var entry in state.entries){if(state.resources.Any(r=>r.writable&&Contains(r.path,entry.path)))continue;byte[] descriptor=Security(entry.path).GetSecurityDescriptorBinaryForm();uint granted;bool access;uint available=size;Check(N.AccessCheck(descriptor,duplicate,0x02000000,ref mapping,privileges,ref available,out granted,out access),"effective restricted-token access check");if(access&&(granted&(uint)Writes)!=0)throw new Exception("Readonly resource permits effective restricted-token writes: "+entry.path);}
   }finally{Marshal.FreeHGlobal(privileges);}
  }finally{N.CloseHandle(duplicate);}
 }
 static Dictionary<string,object> StatusManaged() {
  if(!Directory.Exists(Coordinator))return Result(true,"idle");VerifyPrivate(Coordinator);bool locked=false;string lockFile=Path.Combine(Coordinator,"lifecycle.lock");if(File.Exists(lockFile)){VerifyPrivate(lockFile);try{using(var handle=File.Open(lockFile,FileMode.Open,FileAccess.Read,FileShare.None)){} }catch(IOException error){int code=error.HResult&0xffff;if(code!=32&&code!=33)throw;locked=true;}}
  var setup=SetupRecovery(locked);if(setup!=null)return setup;
  Active=ReadJournal();if(Active==null){CheckOrphanDirectories();return Result(true,locked?"busy":"idle");}bool alive=OwnerAlive();string status=locked?"busy":Terminal(Active)?"idle":alive&&!SameOwner()?"busy":alive&&(Active.phase=="reserved"||Active.phase=="prepared"||Active.phase=="run-complete")?Active.phase:"recovery-required";var result=Result(true,status);SessionFields(result);result["phase"]=Active.phase;result["step"]=Active.step;result["ownerAlive"]=alive;result["ownerProcessId"]=Active.ownerProcessId;result["responsibleLauncher"]=new Dictionary<string,object>{{"path",Active.launcherPath},{"sha256",Active.launcherSha256}};result["sameLogon"]=Active.originSessionId==Process.GetCurrentProcess().SessionId&&Active.originLogonId==LogonId();result["crossLogonRecoveryQualified"]=false;return result;
 }
 static Dictionary<string,object> CancelManaged(SessionRequest request) {if(request.schema!="fvs/windows-cancel/v2")throw new Exception("Unknown cancel schema");Active=ReadJournal();if(Active==null||Active.sessionId!=request.sessionId)throw new Exception("Cancellation session mismatch");RequireOrigin();IntPtr handle=N.OpenEvent(2,false,CancelName(Active.sessionId));if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==2)return Result(true,"not-running");throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"open cancellation event");}try{Check(N.SetEvent(handle),"signal cancellation");return Result(true,"cancel-requested");}finally{N.CloseHandle(handle);}}
 static T Request<T>(string path) {if(path!="-")return Read<T>(path);var input=new StringBuilder();var buffer=new char[8192];int count;while((count=Console.In.Read(buffer,0,buffer.Length))!=0){if(input.Length+count>MaximumJournalBytes)throw new Exception("Stdin request exceeds 1 MiB");input.Append(buffer,0,count);}return Json.Deserialize<T>(input.ToString());}
 static int LifecycleMain(string[] args) {
  Dictionary<string,object> result,host=null;string operation=args.Length>0?args[0]:"";
  try{
   Console.InputEncoding=new UTF8Encoding(false,true);
   host=HostFacts();if(operation=="host"&&args.Length==1)result=Result(true,"host");
   else if(!(bool)host["qualified"])result=Result(false,"host-unsupported");
   else if(operation=="status"&&(args.Length==1||args.Length==2))result=StatusManaged();
   else if(operation=="cancel"&&args.Length==2)result=CancelManaged(Request<SessionRequest>(args[1]));
   else using(var lease=new LifecycleLease()){
    if(operation=="reserve"&&args.Length==2)result=ReserveManaged(Request<ReserveRequest>(args[1]));
    else if(operation=="prepare"&&args.Length==2)result=PrepareManaged(Request<PrepareRequest>(args[1]));
    else if(operation=="recover"&&args.Length==2)result=SetupRecovery(false)??RecoverManaged(Request<SessionRequest>(args[1]));
    else if((operation=="run"||operation=="dispose")&&args.Length==3){Active=ReadJournal();if(Active==null)throw new Exception("No active session");RequireOrigin();RequireLauncher();RequireOwner(false);if(Active.phase!="prepared"&&Active.phase!="run-complete")throw new Exception("Session is not prepared");if(!Paths.Equals(Canonical(args[1],false),Path.Combine(Active.controlDirectory,"state.json")))throw new Exception("State is outside active session");StartCancellation();
     if(operation=="run") {var request=Request<RunRequest>(args[2]);if(request.stateSha256!=Active.stateSha256)throw new Exception("State digest differs from journal");if(Active.phase=="run-complete"&&Active.disposablePaths.Length!=0)throw new Exception("Writable extraction session is single-use");string id=Guid.NewGuid().ToString("N");Fault("run:before-intent");Persist("running","run:"+id);Fault("run:after-intent");result=Run(args[1],request);result["runId"]=id;string file=Path.Combine(Active.controlDirectory,"run-"+id+".json");Fault("run-result:before-write");AtomicJson(file,result);Fault("run-result:after-write");Active.lastRunId=id;Active.lastRunResultSha256=Hash(file);Fault("run-complete:before-write");Persist("run-complete","run:complete");Fault("run-complete:after-write");result["resultPath"]=file;result["resultSha256"]=Active.lastRunResultSha256;SessionFields(result);}
     else {var request=Request<DisposeRequest>(args[2]);if(request.stateSha256!=Active.stateSha256)throw new Exception("State digest differs from journal");Persist("disposing","dispose:start");result=DisposeState(args[1],request);if(!(bool)result["ok"])Persist("recovery-required","dispose:failed");}
    }else throw new Exception("Usage: reserve|prepare|recover|cancel request.json-or-stdin-dash; status; run|dispose state.json request.json-or-stdin-dash");
   }
  }catch(Exception ex){result=Result(false,"confinement-unavailable");Diagnostics(result).Add(ex.Message);try{if(Directory.Exists(Coordinator)){if(File.Exists(Path.Combine(Coordinator,"setup-active.json"))||Directory.Exists(Path.Combine(Coordinator,"setup-active.json")))result["status"]="quarantined";else{Active=ReadJournal();if(Active!=null&&!Terminal(Active)){result["status"]="recovery-required";SessionFields(result);if(RollbackPreparation){using(var recoveryLease=new LifecycleLease()){var rollback=RecoverManaged(new SessionRequest{schema="fvs/windows-recover/v2",sessionId=Active.sessionId});result["rollback"]=rollback;if((bool)rollback["ok"])result["status"]="preparation-failed-rolled-back";}}}}}}catch(Exception journalError){result["status"]="quarantined";Diagnostics(result).Add(journalError.Message);}}
  result["host"]=host;Console.OutputEncoding=new UTF8Encoding(false);Console.WriteLine(Json.Serialize(result));return (bool)result["ok"]?0:1;
 }
}
