// Native Windows confinement backend. Distribution policy is enforced by its caller.
// Preparation is explicit; run never provisions a profile or changes an ACL.
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;

public class PrepareRequest { public string schema,sessionId,controlDirectory; public string[] readOnlyPaths,writablePaths,executablePaths,disposablePaths; public bool profileTempWritable; }
public class RunRequest { public string schema,stateSha256,executable,cwd; public string[] args; public Dictionary<string,string> environment; public int timeoutMs,maxOutputBytes; }
public class DisposeRequest { public string schema,stateSha256; public string[] cleanPrivatePaths; }
public class Resource { public string path,identity,beforeAcl,preparedAcl; public bool writable,directory,metadataOnly; }
public class Entry { public string path,identity,acl,beforeAcl; public bool directory; }
public class Binary { public string path,sha256; }
public class PreparedState {
 public string schema,sessionId,stageRoot,controlDirectory,launcherSha256,moniker,profileSid,profileRoot,privateTemp,profileRootAcl,jobName;
 public bool profileTempWritable;
 public List<Resource> resources=new List<Resource>(); public List<Entry> entries=new List<Entry>(); public List<Binary> binaries=new List<Binary>();
}

public static partial class FvsWindowsLauncher {
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=128*1024*1024,RecursionLimit=100 };
 static readonly StringComparer Paths=StringComparer.OrdinalIgnoreCase;
 static readonly FileSystemRights Writes=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
 static string Self {get{return System.Reflection.Assembly.GetExecutingAssembly().Location;}}
 static void Check(bool value,string operation) {if(!value){int code=Marshal.GetLastWin32Error();throw new Win32Exception(code,operation+": "+new Win32Exception(code).Message+" (Win32 "+code+")");}}
 static string Hash(string file) {using(var input=File.OpenRead(file))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant();}
 static string HashBytes(byte[] bytes) {using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
 static T Read<T>(string file) {var path=Canonical(file,false);if(new FileInfo(path).Length>128*1024*1024)throw new Exception("JSON input exceeds limit");return Json.Deserialize<T>(File.ReadAllText(path,new UTF8Encoding(false,true)));}
 static Dictionary<string,object> Result(bool ok,string status) {return new Dictionary<string,object>{{"ok",ok},{"status",status},{"diagnostics",new List<string>()}};}
 static List<string> Diagnostics(Dictionary<string,object> result) {return (List<string>)result["diagnostics"];}
 static string Identity(IntPtr handle) {N.FILE_INFO info;Check(N.GetFileInformationByHandle(handle,out info),"file identity");if((info.attrs&0x400)!=0)throw new Exception("Reparse points are unsupported");if((info.attrs&0x10)!=0){uint sensitive;Check(N.GetFileInformationByHandleEx(handle,23,out sensitive,4),"directory case-sensitivity query");if((sensitive&1)!=0)throw new Exception("Case-sensitive directories are unsupported");}if((info.attrs&0x10)==0&&info.links!=1)throw new Exception("Files with multiple hardlinks are unsupported");return info.volume.ToString("x8")+":"+info.indexHigh.ToString("x8")+info.indexLow.ToString("x8");}
 static IntPtr OpenIdentity(string path) {var sa=new N.SECURITY_ATTRIBUTES();sa.length=Marshal.SizeOf(sa);IntPtr h=N.CreateFile(path,0x80,7,ref sa,3,0x02000000|0x00200000,IntPtr.Zero);Check(h!=new IntPtr(-1),"open identity "+path);return h;}
 static void VerifyFinalPath(IntPtr handle,string expected) {var resolved=new StringBuilder(32768);uint count=N.GetFinalPathNameByHandle(handle,resolved,32768,0);Check(count!=0,"resolve final path");if(count>=32768)throw new Exception("Resolved path exceeds limit");string path=resolved.ToString();if(path.StartsWith(@"\\?\",StringComparison.Ordinal))path=path.Substring(4);if(!Paths.Equals(path.TrimEnd('\\'),expected.TrimEnd('\\')))throw new Exception("Short-name, drive substitution, or other path alias is unsupported: "+expected);}
 static string PathIdentity(string path) {IntPtr h=OpenIdentity(path);try{VerifyFinalPath(h,path);return Identity(h);}finally{N.CloseHandle(h);}}
 static string Canonical(string value,bool allowMissingLeaf) {return CanonicalPath(value,allowMissingLeaf,true);}
 // Tree traversal has already checked its root and external ancestors. Validate
 // every descendant's spelling and native final path/identity without reopening
 // every ancestor for every leaf. Every enumerated directory is checked too.
 static string CanonicalTreeEntry(string value) {return CanonicalPath(value,false,false);}
 static string CanonicalPath(string value,bool allowMissingLeaf,bool verifyAncestors) {
  if(String.IsNullOrEmpty(value)||!Regex.IsMatch(value,@"^[A-Za-z]:\\")||value.IndexOf('/')>=0||value.Any(c=>c<32)||value.Substring(2).IndexOf(':')>=0)throw new Exception("Only canonical absolute local-drive Windows paths are accepted");
  string root=value.Substring(0,3);if(N.GetDriveType(root)!=3)throw new Exception("Only fixed local drives are accepted");if(verifyAncestors){uint serial,maximum,flags;var filesystem=new StringBuilder(32);Check(N.GetVolumeInformation(root,null,0,out serial,out maximum,out flags,filesystem,32),"filesystem qualification");if(filesystem.ToString()!="NTFS")throw new Exception("Only local NTFS resources are qualified");PathIdentity(root);}
  string[] parts=value.Substring(3).Split('\\');if(parts.Length==1&&parts[0]=="")parts=new string[0];
  string current=root;
  foreach(string part in parts) {if(String.IsNullOrEmpty(part)||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.IndexOfAny(new char[]{'<','>','"','|','?','*'})>=0||Regex.IsMatch(part,@"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)",RegexOptions.IgnoreCase))throw new Exception("Unsupported Windows path alias");current=Path.Combine(current,part);if(verifyAncestors){bool exists=File.Exists(current)||Directory.Exists(current);if(!exists){if(allowMissingLeaf&&Paths.Equals(current,value))return Path.GetFullPath(value);throw new Exception("Required path is absent: "+current);}PathIdentity(current);}}
  if(!verifyAncestors)PathIdentity(value);
  if(!Paths.Equals(Path.GetFullPath(value),value))throw new Exception("Path is not canonical");return Path.GetFullPath(value);
 }
 static bool Contains(string root,string path) {return Paths.Equals(root,path)||path.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
 static string Acl(string path) {return Directory.Exists(path)?Directory.GetAccessControl(path,AccessControlSections.Access|AccessControlSections.Owner).GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner):File.GetAccessControl(path,AccessControlSections.Access|AccessControlSections.Owner).GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner);}
 static void RejectAmbientWrites(string path) {
  FileSystemSecurity acl=Directory.Exists(path)?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
  foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&Writes)!=0&&rule.IdentityReference.Value=="S-1-15-2-2")throw new Exception("ALL RESTRICTED APPLICATION PACKAGES has write access: "+path);
 }
 static IEnumerable<string> Walk(string root) {
  yield return Canonical(root,false);if(!Directory.Exists(root))yield break;
  var todo=new Stack<string>();todo.Push(root);while(todo.Count!=0){string directory=todo.Pop();foreach(string path in Directory.EnumerateFileSystemEntries(directory)){CanonicalTreeEntry(path);yield return path;if(Directory.Exists(path))todo.Push(path);}}
 }
 static IEnumerable<string> Members(Resource resource) {return resource.metadataOnly?new[]{Canonical(resource.path,false)}:Walk(resource.path);}
 static void ShallowProfileGrant(string path,SecurityIdentifier sid,bool remove) {
  if(!Paths.Equals(path,Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)))throw new Exception("Metadata grant must target actual Windows user profile");
  var acl=Directory.GetAccessControl(path,AccessControlSections.Access|AccessControlSections.Owner);
  if(remove)acl.PurgeAccessRules(sid);else acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.ReadAttributes|FileSystemRights.Traverse,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));
  string expected=acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner);
  byte[] descriptor=acl.GetSecurityDescriptorBinaryForm();bool auto=(BitConverter.ToUInt16(descriptor,2)&0x0400)!=0;
  // Preserve current inheritance control bits without propagating any ACL to
  // children. SetFileSecurity is intentionally used for this shallow operation;
  // AUTO_INHERIT_REQ is required to preserve an existing AUTO_INHERITED bit.
  Check(N.SetSecurityDescriptorControl(descriptor,0x0500,(ushort)(auto?0x0500:0)),"preserve profile ACL control");
  Check(N.SetFileSecurity(path,4,descriptor),"set shallow profile metadata ACL");
  if(Acl(path)!=expected)throw new Exception("Shallow metadata ACL owner/control/rules differ after update");
 }
 static void Grant(string path,SecurityIdentifier sid,bool writable) {
  var rights=writable?FileSystemRights.Modify:FileSystemRights.ReadAndExecute;
  if(Directory.Exists(path)){var acl=Directory.GetAccessControl(path);acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.SetAccessControl(path,acl);}
  else {var acl=File.GetAccessControl(path);acl.AddAccessRule(new FileSystemAccessRule(sid,rights,AccessControlType.Allow));File.SetAccessControl(path,acl);}
 }
 static void RemoveGrant(string path,SecurityIdentifier sid) {
  if(Directory.Exists(path)){var acl=Directory.GetAccessControl(path);acl.PurgeAccessRules(sid);Directory.SetAccessControl(path,acl);}
  else {var acl=File.GetAccessControl(path);acl.PurgeAccessRules(sid);File.SetAccessControl(path,acl);}
 }
 static void PrivateAcl(string path,SecurityIdentifier package,FileSystemRights rights) {
  var principals=new SecurityIdentifier[]{WindowsIdentity.GetCurrent().User,new SecurityIdentifier("S-1-5-18"),new SecurityIdentifier("S-1-5-32-544")};
  if(Directory.Exists(path)) {var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);foreach(var sid in principals)acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));if(package!=null)acl.AddAccessRule(new FileSystemAccessRule(package,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.SetAccessControl(path,acl);}
  else {var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);foreach(var sid in principals)acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));if(package!=null)acl.AddAccessRule(new FileSystemAccessRule(package,rights,AccessControlType.Allow));File.SetAccessControl(path,acl);}
 }
 static string ProfilePath(string sid) {IntPtr result;int hr=N.GetAppContainerFolderPath(sid,out result);if(hr!=0)Marshal.ThrowExceptionForHR(hr);try{return Marshal.PtrToStringUni(result);}finally{Marshal.FreeCoTaskMem(result);}}
 static PreparedState LoadState(string statePath,string expectedHash) {
  statePath=Canonical(statePath,false);byte[] snapshot;using(var stream=File.Open(statePath,FileMode.Open,FileAccess.Read,FileShare.Read)){if(stream.Length>128*1024*1024)throw new Exception("Prepared manifest exceeds limit");using(var buffer=new MemoryStream()){stream.CopyTo(buffer);snapshot=buffer.ToArray();}}
  if(String.IsNullOrEmpty(expectedHash)||!Regex.IsMatch(expectedHash,"^[0-9a-f]{64}$")||!String.Equals(HashBytes(snapshot),expectedHash,StringComparison.Ordinal))throw new Exception("Prepared manifest digest mismatch");
  var state=Json.Deserialize<PreparedState>(Encoding.UTF8.GetString(snapshot));if(state.schema!="fvs/windows-prepared-state/v2"||!Paths.Equals(statePath,Path.Combine(state.controlDirectory,"state.json")))throw new Exception("Untrusted prepared manifest location");
  Canonical(state.controlDirectory,false);if(Hash(Self)!=state.launcherSha256)throw new Exception("Launcher differs from prepared identity");
  var controlAcl=Directory.GetAccessControl(state.controlDirectory,AccessControlSections.Owner|AccessControlSections.Access);var owner=controlAcl.GetOwner(typeof(SecurityIdentifier));if(!owner.Equals(WindowsIdentity.GetCurrent().User))throw new Exception("Control directory owner differs from caller");
  foreach(string controlPath in new[]{state.controlDirectory,statePath,Path.Combine(state.controlDirectory,"run.lock"),Path.Combine(state.controlDirectory,"handle-sentinel")}){Canonical(controlPath,false);FileSystemSecurity acl=Directory.Exists(controlPath)?(FileSystemSecurity)Directory.GetAccessControl(controlPath):File.GetAccessControl(controlPath);foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&Writes)!=0&&!new[]{WindowsIdentity.GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544"}.Contains(rule.IdentityReference.Value))throw new Exception("Prepared manifest/control directory has an untrusted writer");}
  if(!Regex.IsMatch(state.moniker,@"^FVS\.Windows\.[0-9a-f]{32}$"))throw new Exception("Invalid prepared profile name");
  if(state.jobName!=JobName(state.sessionId))throw new Exception("Invalid prepared job identity");
  IntPtr sid;int hr=N.DeriveAppContainerSidFromAppContainerName(state.moniker,out sid);if(hr!=0)Marshal.ThrowExceptionForHR(hr);try{if(new SecurityIdentifier(sid).Value!=state.profileSid)throw new Exception("Prepared profile SID mismatch");}finally{N.FreeSid(sid);}
  string expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Packages",state.moniker);if(!Paths.Equals(state.profileRoot,expected))throw new Exception("Prepared profile path mismatch");
  return state;
 }
 static List<string> Cleanup(PreparedState state,bool removeProfile) { return CleanupManaged(state,removeProfile); }
 static Dictionary<string,object> DisposeState(string statePath,DisposeRequest request) {
  if(request.schema!="fvs/windows-dispose/v2")throw new Exception("Unknown dispose schema");
  var state=LoadState(statePath,request.stateSha256);
  using(var sessionLease=File.Open(Path.Combine(state.controlDirectory,"run.lock"),FileMode.Open,FileAccess.Read,FileShare.None)){
   var errors=new List<string>();int deleted=0;
   try {
    VerifiedPrivateLeafCleanup.DrainNamedJob(state.jobName);
    if(request.cleanPrivatePaths!=null){
     AuthorizePrivateCleanup(state,request.cleanPrivatePaths);
     var writable=state.resources.Where(r=>r.writable&&!r.metadataOnly&&r.directory).ToArray();
     var requested=request.cleanPrivatePaths.Select(p=>Canonical(p,false)).ToArray();
     if(requested.Length!=writable.Length||requested.Distinct(Paths).Count()!=requested.Length||writable.Any(r=>!requested.Contains(r.path,Paths)))throw new Exception("cleanPrivatePaths must exactly equal the prepared writable resource roots");
     if(writable.Length!=0)deleted=VerifiedPrivateLeafCleanup.Clean(writable.Select(r=>r.path).ToArray(),writable.Select(r=>r.identity).ToArray(),state.jobName);
    }
   }catch(Exception ex){errors.Add(ex.Message);}
   if(errors.Count==0)errors.AddRange(Cleanup(state,true));
   var result=Result(errors.Count==0,errors.Count==0?"disposed":"cleanup-failed");Diagnostics(result).AddRange(errors);result["privateLeavesDeleted"]=deleted;
   if(errors.Count==0) CompleteSession(state,result,"disposed");
   return result;
  }
 }
 static string Quote(string value) {
  if(value==null||value.IndexOf('\0')>=0)throw new Exception("Invalid argument");var b=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);return b.Append('"').ToString();
 }
 sealed class BufferPipe {
  public IntPtr read,write; public readonly MemoryStream bytes=new MemoryStream(); public Thread thread;public volatile bool overflow,done;public int error;public uint nativeThreadId;readonly int limit;
  public BufferPipe(int maximum){limit=maximum;var sa=new N.SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES)),inherit=1};Check(N.CreatePipe(out read,out write,ref sa,0),"create pipe");Check(N.SetHandleInformation(read,1,0),"clear read inheritance");}
  public void Start(){thread=new Thread(()=>{nativeThreadId=N.GetCurrentThreadId();var buffer=new byte[8192];try{while(true){int count;if(!N.ReadFile(read,buffer,buffer.Length,out count,IntPtr.Zero)){int e=Marshal.GetLastWin32Error();if(e!=109&&e!=995)error=e;break;}if(count==0)break;int room=limit-(int)bytes.Length;if(count>room){overflow=true;if(room>0)bytes.Write(buffer,0,room);}else bytes.Write(buffer,0,count);}}finally{done=true;}});thread.IsBackground=true;thread.Start();}
  public bool Finish(){if(thread==null||thread.Join(1000))return true;IntPtr handle=N.OpenThread(1,false,nativeThreadId);if(handle!=IntPtr.Zero){try{N.CancelSynchronousIo(handle);}finally{N.CloseHandle(handle);}}return thread.Join(1000);}
  public string Text(){return Encoding.UTF8.GetString(bytes.ToArray());}
  public void CloseWrite(){if(write!=IntPtr.Zero){N.CloseHandle(write);write=IntPtr.Zero;}}
  public void Close(){CloseWrite();if(read!=IntPtr.Zero){N.CloseHandle(read);read=IntPtr.Zero;}}
 }
 static IntPtr Allocate<T>(T value,List<IntPtr> list){IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(value));Marshal.StructureToPtr(value,p,false);list.Add(p);return p;}
 static void Attribute(IntPtr list,int key,IntPtr value,int size){Check(N.UpdateProcThreadAttribute(list,0,new IntPtr(key),value,new IntPtr(size),IntPtr.Zero,IntPtr.Zero),"process attribute "+key);}
 static void Drain(IntPtr job){Check(N.TerminateJobObject(job,125),"terminate descendant job");var watch=Stopwatch.StartNew();while(true){N.ACCOUNTING a;Check(N.QueryInformationJobObject(job,1,out a,Marshal.SizeOf(typeof(N.ACCOUNTING)),IntPtr.Zero),"job accounting");if(a.active==0)return;if(watch.ElapsedMilliseconds>5000)throw new Exception("Descendant job did not empty");Thread.Sleep(10);}}
 static Dictionary<string,object> Run(string statePath,RunRequest request) {
  if(request.schema!="fvs/windows-run/v2")throw new Exception("Unknown run schema");if(request.timeoutMs<1||request.timeoutMs>3600000||request.maxOutputBytes<1024||request.maxOutputBytes>64*1024*1024)throw new Exception("Invalid output or timeout limit");
  var state=LoadState(statePath,request.stateSha256);using(var sessionLease=File.Open(Path.Combine(state.controlDirectory,"run.lock"),FileMode.Open,FileAccess.Read,FileShare.None)){return RunPrepared(state,request);}
 }
 static Dictionary<string,object> RunPrepared(PreparedState state,RunRequest request) {
  if(File.Exists(Path.Combine(state.controlDirectory,"disposed.json")))throw new Exception("Prepared identity has been disposed");
  string executable=Canonical(request.executable,false),cwd=Canonical(request.cwd,false);if(!Directory.Exists(cwd)||!state.resources.Any(r=>!r.metadataOnly&&Contains(r.path,cwd)))throw new Exception("cwd is outside prepared resources");var binary=state.binaries.SingleOrDefault(b=>Paths.Equals(b.path,executable));if(binary==null||Hash(executable)!=binary.sha256)throw new Exception("Command is not an exact prepared executable");
  foreach(var resource in state.resources)Canonical(resource.path,false);
  foreach(var entry in state.entries){CancellationCheckpoint();CanonicalTreeEntry(entry.path);if(PathIdentity(entry.path)!=entry.identity||Acl(entry.path)!=entry.acl)throw new Exception("Prepared resource identity/ACL changed: "+entry.path);}
  foreach(var resource in state.resources)foreach(string path in Members(resource))RejectAmbientWrites(path);
  if(Acl(state.profileRoot)!=state.profileRootAcl)throw new Exception("Prepared profile ACL changed");
  foreach(string path in Walk(state.profileRoot))RejectAmbientWrites(path);
  var result=Result(false,"confinement-unavailable");result["exitCode"]=null;result["stdout"]="";result["stderr"]="";result["activeProcessesAfter"]=null;
  IntPtr sid=IntPtr.Zero,attrs=IntPtr.Zero,job=IntPtr.Zero,stdin=IntPtr.Zero,environment=IntPtr.Zero,token=IntPtr.Zero,sentinel=IntPtr.Zero;var pi=new N.PROCESS_INFORMATION();var allocations=new List<IntPtr>();var locals=new List<IntPtr>();var leases=new List<IntPtr>();BufferPipe output=null,error=null;bool started=false,drained=false;
  try{
   // Deny deletion/renaming of prepared resource roots during the run. Readonly files are opened without write sharing.
   foreach(var entry in state.entries){var sa=new N.SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES))};Resource writableRoot=state.resources.SingleOrDefault(r=>r.writable&&Contains(r.path,entry.path));if(writableRoot!=null&&!Paths.Equals(writableRoot.path,entry.path))continue;IntPtr handle=N.CreateFile(entry.path,0x80,writableRoot!=null||entry.directory?3u:1u,ref sa,3,0x02000000|0x00200000,IntPtr.Zero);Check(handle!=new IntPtr(-1),"lease "+entry.path);leases.Add(handle);VerifyFinalPath(handle,entry.path);if(Identity(handle)!=entry.identity)throw new Exception("Resource changed during lease acquisition");}
   if(Hash(executable)!=binary.sha256)throw new Exception("Executable bytes changed before readonly leases were acquired");
   int hr=N.DeriveAppContainerSidFromAppContainerName(state.moniker,out sid);if(hr!=0)Marshal.ThrowExceptionForHR(hr);
   IntPtr groups,capabilities;uint groupCount,capabilityCount;Check(N.DeriveCapabilitySidsFromName("registryRead",out groups,out groupCount,out capabilities,out capabilityCount),"registryRead capability");locals.Add(groups);locals.Add(capabilities);for(int n=0;n<groupCount;n++)locals.Add(Marshal.ReadIntPtr(groups,n*IntPtr.Size));for(int n=0;n<capabilityCount;n++)locals.Add(Marshal.ReadIntPtr(capabilities,n*IntPtr.Size));if(capabilityCount!=1)throw new Exception("Expected exactly registryRead capability");var cap=new N.SID_AND_ATTRIBUTES{sid=Marshal.ReadIntPtr(capabilities),attributes=4};var caps=new N.SECURITY_CAPABILITIES{Sid=sid,Capabilities=Allocate(cap,allocations),Count=1};
   output=new BufferPipe(request.maxOutputBytes);error=new BufferPipe(request.maxOutputBytes);var security=new N.SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES)),inherit=1};stdin=N.CreateFile("NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero);Check(stdin!=new IntPtr(-1),"stdin");
   sentinel=N.CreateFile(Path.Combine(state.controlDirectory,"handle-sentinel"),0xc0000000,3,ref security,3,0x80,IntPtr.Zero);Check(sentinel!=new IntPtr(-1),"inherited handle sentinel");string sentinelIdentity=Identity(sentinel);
   Fault("job:before-create");job=CreatePrivateJob(state.jobName);Check(job!=IntPtr.Zero,"job");if(Marshal.GetLastWin32Error()==183)throw new Exception("Prepared job already exists; dispose before reusing identity");var limits=new N.EXTENDED_LIMITS();limits.basic.flags=0x2000;Check(N.SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)),"job kill-on-close");Fault("job:after-configure");
   IntPtr size=IntPtr.Zero;N.InitializeProcThreadAttributeList(IntPtr.Zero,4,0,ref size);attrs=Marshal.AllocHGlobal(size);Check(N.InitializeProcThreadAttributeList(attrs,4,0,ref size),"attribute list");Attribute(attrs,0x20009,Allocate(caps,allocations),Marshal.SizeOf(caps));Attribute(attrs,0x2000f,Allocate(1,allocations),4);Attribute(attrs,0x2000d,Allocate(job,allocations),IntPtr.Size);IntPtr handles=Marshal.AllocHGlobal(3*IntPtr.Size);allocations.Add(handles);Marshal.WriteIntPtr(handles,stdin);Marshal.WriteIntPtr(handles,IntPtr.Size,output.write);Marshal.WriteIntPtr(handles,2*IntPtr.Size,error.write);Attribute(attrs,0x20002,handles,3*IntPtr.Size);
   string system=Environment.GetFolderPath(Environment.SpecialFolder.Windows);var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase){{"SystemRoot",system},{"WINDIR",system},{"SystemDrive",Path.GetPathRoot(system).TrimEnd('\\')},{"COMSPEC",Path.Combine(system,"System32","cmd.exe")},{"USERPROFILE",Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)},{"APPDATA",Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)},{"LOCALAPPDATA",Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)},{"PATH",Path.Combine(system,"System32")},{"PATHEXT",".COM;.EXE;.BAT;.CMD"},{"TEMP",state.privateTemp},{"TMP",state.privateTemp}};
   foreach(var pair in request.environment??new Dictionary<string,string>()){if(String.IsNullOrEmpty(pair.Key)||pair.Key.IndexOfAny(new char[]{'=', '\0'})>=0||pair.Value==null||pair.Value.IndexOf('\0')>=0)throw new Exception("Invalid environment entry");if(new string[]{"SystemRoot","WINDIR","SystemDrive","COMSPEC","USERPROFILE","APPDATA","LOCALAPPDATA","TEMP","TMP"}.Contains(pair.Key,StringComparer.OrdinalIgnoreCase)){if(!Paths.Equals(env[pair.Key],pair.Value))throw new Exception("Cannot override required Windows environment: "+pair.Key);}else env[pair.Key]=pair.Value;}
   env["RUSTUP_AUTO_INSTALL"]="0";string environmentText=String.Join("\0",env.Select(p=>p.Key+"="+p.Value))+"\0\0";environment=Marshal.StringToHGlobalUni(environmentText);
   string commandLine=Quote(executable)+" "+String.Join(" ",(request.args??new string[0]).Select(Quote));if(commandLine.Length>30000)throw new Exception("Command line exceeds candidate limit");var si=new N.STARTUPINFOEX();si.info.cb=Marshal.SizeOf(si);si.info.flags=0x100;si.info.stdin=stdin;si.info.stdout=output.write;si.info.stderr=error.write;si.attrs=attrs;
   Check(N.CreateProcess(executable,new StringBuilder(commandLine),IntPtr.Zero,IntPtr.Zero,true,0x00080000|0x00000400|0x08000000|4,environment,cwd,ref si,out pi),"confined CreateProcess");started=true;Fault("child:after-create-suspended");Check(N.OpenProcessToken(pi.process,10,out token),"token query");VerifyRestrictedReadonly(token,state);result["lpacAccessCheckVerified"]=true;IntPtr tokenValue=Marshal.AllocHGlobal(4);allocations.Add(tokenValue);int returned;Check(N.GetTokenInformation(token,29,tokenValue,4,out returned),"AppContainer token query");if(Marshal.ReadInt32(tokenValue)!=1)throw new Exception("Child is not an AppContainer");
   N.GetTokenInformation(token,30,IntPtr.Zero,0,out returned);if(returned<24||returned>65536)throw new Exception("Invalid capability token buffer");IntPtr actualCaps=Marshal.AllocHGlobal(returned);allocations.Add(actualCaps);Check(N.GetTokenInformation(token,30,actualCaps,returned,out returned),"capability token query");if(Marshal.ReadInt32(actualCaps)!=1||new SecurityIdentifier(Marshal.ReadIntPtr(actualCaps,8)).Value!=new SecurityIdentifier(cap.sid).Value)throw new Exception("Child capabilities differ from registryRead-only configuration");result["capabilities"]=new[]{"registryRead"};
   IntPtr leaked;if(N.DuplicateHandle(pi.process,sentinel,N.GetCurrentProcess(),out leaked,0,false,2)){try{if(N.GetFileType(leaked)==1&&Identity(leaked)==sentinelIdentity)throw new Exception("Unlisted inheritable writable handle reached child");}finally{N.CloseHandle(leaked);}}else if(Marshal.GetLastWin32Error()!=6)throw new Win32Exception(Marshal.GetLastWin32Error(),"inherited-handle sentinel inspection");result["inheritedSentinelExcluded"]=true;
   Fault("child:after-token-checks");output.CloseWrite();error.CloseWrite();output.Start();error.Start();Fault("child:before-resume");if(N.ResumeThread(pi.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error(),"resume");Fault("child:after-resume");var clock=Stopwatch.StartNew();string status="exited";
   while(true){if(CancellationRequested()){status="cancelled";break;}if(output.overflow||error.overflow){status="output-limit";break;}uint wait=N.WaitForSingleObject(pi.process,10);if(wait==0)break;if(wait!=258)throw new Win32Exception(Marshal.GetLastWin32Error(),"process wait");if(clock.ElapsedMilliseconds>=request.timeoutMs){status="timeout";break;}}
   if(status!="exited")Check(N.TerminateJobObject(job,status=="timeout"?124u:122u),"terminate limited job");Check(N.WaitForSingleObject(pi.process,5000)==0,"process exit confirmation");uint code;Check(N.GetExitCodeProcess(pi.process,out code),"exit code");Drain(job);drained=true;Fault("job:after-drain");
   if(!output.thread.Join(5000)||!error.thread.Join(5000))throw new Exception("Inherited output pipes did not close after empty job");if(output.error!=0||error.error!=0)throw new Exception("Output pipe read failed");if(output.overflow||error.overflow)status="output-limit";
   result["status"]=status;result["exitCode"]=code;result["stdout"]=output.Text();result["stderr"]=error.Text();result["activeProcessesAfter"]=0;result["ok"]=status=="exited"&&code==0;return result;
  }catch(Exception ex){Diagnostics(result).Add(ex.Message);return result;}
  finally{
   if(started&&!drained)try{Drain(job);result["activeProcessesAfter"]=0;}catch(Exception ex){result["ok"]=false;result["status"]="cleanup-failed";Diagnostics(result).Add(ex.Message);}
   if(output!=null){if(!output.Finish()){result["ok"]=false;result["status"]="cleanup-failed";Diagnostics(result).Add("stdout reader did not finish");}else {if(output.done)result["stdout"]=output.Text();output.Close();}}if(error!=null){if(!error.Finish()){result["ok"]=false;result["status"]="cleanup-failed";Diagnostics(result).Add("stderr reader did not finish");}else {if(error.done)result["stderr"]=error.Text();error.Close();}}
   if(token!=IntPtr.Zero)N.CloseHandle(token);if(pi.thread!=IntPtr.Zero)N.CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)N.CloseHandle(pi.process);if(job!=IntPtr.Zero)N.CloseHandle(job);if(stdin!=IntPtr.Zero&&stdin!=new IntPtr(-1))N.CloseHandle(stdin);if(sentinel!=IntPtr.Zero&&sentinel!=new IntPtr(-1))N.CloseHandle(sentinel);foreach(IntPtr lease in leases)N.CloseHandle(lease);if(attrs!=IntPtr.Zero){N.DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}foreach(IntPtr p in allocations)Marshal.FreeHGlobal(p);foreach(IntPtr p in locals)if(p!=IntPtr.Zero)N.LocalFree(p);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(sid!=IntPtr.Zero)N.FreeSid(sid);
  }
 }
 public static int Main(string[] args) { return LifecycleMain(args); }
}
