// Caller authenticates the prepared state and holds its exclusive run.lock.
// This primitive drains only that named job and unlinks verified private leaves.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;
using System.Security.Principal;
public static class VerifiedPrivateLeafCleanup {
 [StructLayout(LayoutKind.Sequential)] struct Info {public uint attributes;public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
 [StructLayout(LayoutKind.Sequential)] struct Accounting {public long user,kernel,periodUser,periodKernel;public uint faults,total,active,terminated;}
 [StructLayout(LayoutKind.Sequential)] struct Disposition {[MarshalAs(UnmanagedType.Bool)] public bool delete;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out Info info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr file,int kind,ref Disposition value,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveType(string root);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,int size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle,int kind,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 static readonly StringComparer Paths=StringComparer.OrdinalIgnoreCase;
 sealed class Leaf {public string path,identity;}
 static void Check(bool ok,string message){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),message);}
 static bool Contains(string root,string file){return Paths.Equals(root,file)||file.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
 static string Identity(Info info){return info.volume.ToString("x8")+":"+info.indexHigh.ToString("x8")+info.indexLow.ToString("x8");}
 static void Spelling(string path){
  if(String.IsNullOrEmpty(path)||!System.Text.RegularExpressions.Regex.IsMatch(path,@"^[A-Za-z]:\\")||path.IndexOf('/')>=0||path.Any(c=>c<32)||path.Substring(2).IndexOf(':')>=0||GetDriveType(path.Substring(0,3))!=3||!Paths.Equals(Path.GetFullPath(path),path))throw new Exception("Unsupported cleanup path");
  foreach(string part in path.Substring(3).Split('\\')){if(part==""&&path.Length==3)continue;if(String.IsNullOrEmpty(part)||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.IndexOfAny(new[]{'<','>','"','|','?','*'})>=0||System.Text.RegularExpressions.Regex.IsMatch(part,@"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase))throw new Exception("Unsupported cleanup spelling");}
 }
 static Info Inspect(IntPtr handle,string path,bool directory){
  Info info;Check(GetFileInformationByHandle(handle,out info),"cleanup identity");
  if((info.attributes&0x400)!=0||((info.attributes&0x10)!=0)!=directory)throw new Exception("Cleanup refuses reparse/special entries: "+path);
  var final=new StringBuilder(32768);uint size=GetFinalPathNameByHandle(handle,final,32768,0);Check(size>0,"cleanup final path");if(size>=32768)throw new Exception("Cleanup final path too long");string resolved=final.ToString();if(resolved.StartsWith(@"\\?\"))resolved=resolved.Substring(4);if(!Paths.Equals(resolved.TrimEnd('\\'),path.TrimEnd('\\')))throw new Exception("Cleanup path alias: "+path);
  return info;
 }
 static IntPtr Open(string path,bool directory,bool deletion){Spelling(path);IntPtr handle=CreateFile(path,deletion?0x10080u:0x80u,directory||deletion?3u:7u,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);Check(handle!=new IntPtr(-1),"open cleanup entry "+path);try{Inspect(handle,path,directory);return handle;}catch{CloseHandle(handle);throw;}}
 public static string DirectoryIdentity(string path){IntPtr h=Open(path,true,false);try{return Identity(Inspect(h,path,true));}finally{CloseHandle(h);}}
 public static void DrainNamedJob(string name){
  if(!System.Text.RegularExpressions.Regex.IsMatch(name,@"^Global\\FVS\.Windows\.[0-9a-f]{16}\.[0-9a-f]{32}$"))throw new Exception("Invalid cleanup job name");
  IntPtr job=OpenJobObject(0x2000c,false,name);if(job==IntPtr.Zero){if(Marshal.GetLastWin32Error()==2)return;throw new Win32Exception(Marshal.GetLastWin32Error(),"open cleanup job");}
  try{IntPtr owner,group,dacl,sacl,descriptor;uint code=GetSecurityInfo(job,6,1,out owner,out group,out dacl,out sacl,out descriptor);if(code!=0)throw new Win32Exception((int)code,"authenticate cleanup job owner");try{if(owner==IntPtr.Zero||!new SecurityIdentifier(owner).Equals(WindowsIdentity.GetCurrent().User))throw new Exception("Foreign-owned cleanup job");}finally{LocalFree(descriptor);}var clock=Stopwatch.StartNew();bool terminated=false;while(true){Accounting a;Check(QueryInformationJobObject(job,1,out a,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"inspect cleanup job");if(a.active==0)return;if(!terminated){Check(TerminateJobObject(job,125),"terminate cleanup job");terminated=true;}if(clock.ElapsedMilliseconds>5000)throw new Exception("Cleanup job did not drain");Thread.Sleep(10);}}finally{CloseHandle(job);}
 }
 public static int Clean(string[] roots,string[] identities,string jobName){
  if(roots==null||identities==null||roots.Length!=identities.Length||roots.Length==0)throw new Exception("Explicit prepared writable roots required");
  DrainNamedJob(jobName);
  var directories=new Dictionary<string,IntPtr>(Paths);var leaves=new List<Leaf>();
  Action<string> lease=directory=>{if(!directories.ContainsKey(directory))directories.Add(directory,Open(directory,true,false));};
  try{
   for(int i=0;i<roots.Length;i++){
    Spelling(roots[i]);for(int j=0;j<i;j++)if(Contains(roots[i],roots[j])||Contains(roots[j],roots[i]))throw new Exception("Cleanup roots overlap");
    string current=roots[i].Substring(0,3);lease(current);foreach(string part in roots[i].Substring(3).Split('\\')){current=Path.Combine(current,part);lease(current);}
    if(Identity(Inspect(directories[roots[i]],roots[i],true))!=identities[i])throw new Exception("Prepared cleanup root identity changed");
    var pending=new Stack<string>();pending.Push(roots[i]);
    while(pending.Count!=0){string directory=pending.Pop();foreach(string entry in Directory.EnumerateFileSystemEntries(directory)){
     Spelling(entry);if(!Contains(roots[i],entry))throw new Exception("Cleanup entry outside root");
     FileAttributes attrs=File.GetAttributes(entry);if((attrs&FileAttributes.ReparsePoint)!=0)throw new Exception("Cleanup refuses reparse entry: "+entry);
     if((attrs&FileAttributes.Directory)!=0){lease(entry);pending.Push(entry);}else{IntPtr h=Open(entry,false,false);try{leaves.Add(new Leaf{path=entry,identity=Identity(Inspect(h,entry,false))});}finally{CloseHandle(h);}}
    }}
   }
   // Every ancestor/directory remains leased against deletion or replacement.
   // No ACL, owner, content, or attributes are changed, even for outside aliases.
   int deleted=0;foreach(var leaf in leaves){IntPtr h=Open(leaf.path,false,true);try{if(Identity(Inspect(h,leaf.path,false))!=leaf.identity)throw new Exception("Cleanup leaf identity changed");var disposition=new Disposition{delete=true};Check(SetFileInformationByHandle(h,4,ref disposition,4),"unlink private leaf "+leaf.path);}finally{CloseHandle(h);}if(File.Exists(leaf.path))throw new Exception("Private leaf remains after unlink");deleted++;}
   foreach(string root in roots){var pending=new Stack<string>();pending.Push(root);while(pending.Count!=0){string directory=pending.Pop();foreach(string entry in Directory.EnumerateFileSystemEntries(directory)){if(!directories.ContainsKey(entry))throw new Exception("New/unremoved private entry after cleanup");Inspect(directories[entry],entry,true);pending.Push(entry);}}}
   return deleted;
  }finally{foreach(IntPtr handle in directories.Values)CloseHandle(handle);}
 }
}
