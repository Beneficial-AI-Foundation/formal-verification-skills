using System;
using System.Collections.Generic;
using System.Collections;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Diagnostics;

// Profile-free setup lifetime owner. The exclusive lease outlives every command
// job, including after parent EOF. No application-container profile is created.
public static class FvsSourceSetupHost {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 128 * 1024 * 1024 };
  static readonly BlockingCollection<string> Input = new BlockingCollection<string>();
  static readonly ManualResetEvent ParentGone = new ManualResetEvent(false);
  static string JobName;
  const uint STARTF_USESTDHANDLES=0x100, CREATE_SUSPENDED=4, CREATE_UNICODE_ENVIRONMENT=0x400, EXTENDED_STARTUPINFO_PRESENT=0x80000, CREATE_NO_WINDOW=0x08000000;
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long a,b; public uint LimitFlags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint pageFault,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string reserved,desktop,title; public uint x,y,w,h,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reservedBytes,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(ref SECURITY_ATTRIBUTES sa,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXT_LIMIT info,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNT info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string executable,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX start,out PROCESSINFO info);
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct OSVERSION {
    public uint size,major,minor,build,platform;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string servicePack;
    public ushort servicePackMajor,servicePackMinor,suiteMask; public byte productType,reserved;
  }
  [StructLayout(LayoutKind.Sequential)] struct SYSTEMINFO { public ushort architecture,reserved;public uint pageSize;public IntPtr min,max,mask;public uint processors,type,granularity;public ushort level,revision; }
  [DllImport("ntdll.dll",CharSet=CharSet.Unicode)] static extern int RtlGetVersion(ref OSVERSION version);
  [DllImport("kernel32.dll")] static extern void GetNativeSystemInfo(out SYSTEMINFO info);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsWow64Process2(IntPtr process,out ushort processMachine,out ushort nativeMachine);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int returned);
  public static string LogonId() {
    IntPtr token;Check(OpenProcessToken(GetCurrentProcess(),8,out token),"open setup caller token");
    try{IntPtr memory=Marshal.AllocHGlobal(128);try{int count;Check(GetTokenInformation(token,10,memory,128,out count),"setup caller token statistics");return ((uint)Marshal.ReadInt32(memory,8)).ToString("x8")+((uint)Marshal.ReadInt32(memory,12)).ToString("x8");}finally{Marshal.FreeHGlobal(memory);}}finally{CloseHandle(token);}
  }
  public static object HostFacts() {
    var version=new OSVERSION();version.size=(uint)Marshal.SizeOf(typeof(OSVERSION));
    if(RtlGetVersion(ref version)!=0)throw new Exception("Cannot query actual Windows version");
    SYSTEMINFO system;GetNativeSystemInfo(out system);ushort processMachine,nativeMachine;
    Check(IsWow64Process2(GetCurrentProcess(),out processMachine,out nativeMachine),"query native process architecture");
    if(IntPtr.Size!=8||version.major!=10||version.minor!=0||version.productType!=1||version.build<22000||version.build>29999||system.architecture!=9||nativeMachine!=0x8664||processMachine!=0)throw new Exception("The source distribution requires Windows 11 client build 22000..29999 on native AMD64 without emulation");
    return new {major=version.major,minor=version.minor,build=version.build,productType=version.productType,processorArchitecture=system.architecture,processMachine=processMachine,nativeMachine=nativeMachine,pointerBits=IntPtr.Size*8,originSessionId=Process.GetCurrentProcess().SessionId,originLogonId=LogonId()};
  }
  static void ValidateSetupOrigin(string coordinatorLock) {
    string file=Path.Combine(Path.GetDirectoryName(coordinatorLock),"setup-active.json");if(!File.Exists(file))return;
    if(new FileInfo(file).Length>1024*1024)throw new Exception("Setup marker exceeds limit");
    var marker=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
    if((int)marker["originSessionId"]!=Process.GetCurrentProcess().SessionId||Text(marker,"originLogonId")!=LogonId())throw new Exception("cross-logon-recovery-unqualified: alternate-logon validation is required before setup recovery");
  }
  static void Check(bool result,string operation) { if(!result)throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static string Quote(string value) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\'){slashes++;continue;} if(c=='"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0; }
    b.Append('\\',slashes*2);b.Append('"');return b.ToString();
  }
  static string Text(Dictionary<string,object> request,string key) { return (string)request[key]; }
  static void Emit(object value) { Console.Out.WriteLine(Json.Serialize(value));Console.Out.Flush(); }
  static string Hash(byte[] bytes) { using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
  static string Canonical(object value) {
    var map=value as IDictionary;if(map!=null){var keys=new List<string>();foreach(object key in map.Keys)keys.Add((string)key);keys.Sort(StringComparer.Ordinal);var parts=new List<string>();foreach(string key in keys)parts.Add(Json.Serialize(key)+":"+Canonical(map[key]));return "{"+String.Join(",",parts)+"}";}
    var list=value as IEnumerable;if(list!=null&&!(value is string)){var parts=new List<string>();foreach(object item in list)parts.Add(Canonical(item));return "["+String.Join(",",parts)+"]";}return Json.Serialize(value);
  }
  static void ValidateTerminal(string activeJournal) {
    if(!File.Exists(activeJournal))return;
    if(new FileInfo(activeJournal).Length>1024*1024)throw new Exception("Native journal exceeds limit");
    var active=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(activeJournal));
    object phase; if(!active.TryGetValue("phase",out phase)||((string)phase!="disposed"&&(string)phase!="recovered"))throw new Exception("A native confinement session requires completion or recovery before source setup");
    string checksum=Text(active,"integritySha256");active.Remove("integritySha256");
    if(checksum!=Hash(Encoding.UTF8.GetBytes(Canonical(active))))throw new Exception("Native journal checksum mismatch");
    string id=Text(active,"sessionId"),coordinator=Path.GetDirectoryName(activeJournal);
    if(!System.Text.RegularExpressions.Regex.IsMatch(id,"^[a-f0-9]{32}$"))throw new Exception("Invalid native session identity");
    string session=Path.Combine(coordinator,Text(active,"storageLayout")=="compact-v1"?"s":"sessions",id);
    string control=Path.Combine(session,Text(active,"storageLayout")=="compact-v1"?"c":"control");
    string stage=Path.Combine(session,Text(active,"storageLayout")=="compact-v1"?"s":"stage");
    string profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Packages","FVS.Windows."+id);
    if(Text(active,"schema")!="fvs/windows-lifecycle-journal/v2"||Text(active,"sessionDirectory")!=session||Text(active,"controlDirectory")!=control||Text(active,"stageRoot")!=stage||Text(active,"profileRoot")!=profile)throw new Exception("Native journal path binding mismatch");
    string file=Path.Combine(control,"terminal-receipt.json");if(new FileInfo(file).Length>128L*1024*1024)throw new Exception("Native terminal receipt exceeds limit");byte[] bytes=File.ReadAllBytes(file);
    if(Hash(bytes)!=Text(active,"terminalReceiptSha256"))throw new Exception("Native terminal receipt checksum mismatch");
    var receipt=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes));
    if(Text(receipt,"sessionId")!=id||!(bool)receipt["profileAbsent"]||!(bool)receipt["stageRemoved"]||!(bool)receipt["aclCleanupConfirmed"]||Directory.Exists(stage)||Directory.Exists(profile))throw new Exception("Native terminal cleanup is not confirmed");
  }
  static IntPtr PrivateJob() {
    string sid=WindowsIdentity.GetCurrent().User.Value;
    var raw=new RawSecurityDescriptor("O:"+sid+"D:P(A;;GA;;;"+sid+")(A;;GA;;;SY)(A;;GA;;;BA)");
    byte[] bytes=new byte[raw.BinaryLength];raw.GetBinaryForm(bytes,0);IntPtr memory=Marshal.AllocHGlobal(bytes.Length);
    try {Marshal.Copy(bytes,0,memory,bytes.Length);var sa=new SECURITY_ATTRIBUTES{length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),descriptor=memory};IntPtr job=CreateJobObject(ref sa,JobName);if(job==IntPtr.Zero)throw new Win32Exception();if(Marshal.GetLastWin32Error()==183){CloseHandle(job);throw new Exception("Setup job identity collision");}return job;}finally{Marshal.FreeHGlobal(memory);}
  }
  static void DrainPriorJob() {
    IntPtr job=OpenJobObject(0x2000c,false,JobName);
    if(job==IntPtr.Zero){if(Marshal.GetLastWin32Error()==2)return;throw new Win32Exception(Marshal.GetLastWin32Error(),"open interrupted setup job");}
    try {IntPtr owner,group,dacl,sacl,sd;uint result=GetSecurityInfo(job,6,1,out owner,out group,out dacl,out sacl,out sd);if(result!=0)throw new Win32Exception((int)result);try{if(!new SecurityIdentifier(owner).Equals(WindowsIdentity.GetCurrent().User))throw new Exception("Foreign setup job owner");}finally{LocalFree(sd);}Check(TerminateJobObject(job,125),"terminate interrupted setup job");Drain(job);}finally{CloseHandle(job);}
  }
  static void Drain(IntPtr job) {
    // Never release the setup lease while the job can still write its stage.
    for(;;) { ACCOUNT a; if(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero)&&a.active==0)return; Thread.Sleep(50); }
  }
  static object Execute(Dictionary<string,object> request) {
    string executable=Text(request,"executable"),cwd=Text(request,"cwd"),log=Text(request,"log");
    var command=new StringBuilder(Quote(executable));
    var arguments=new List<string>();foreach(object argument in (System.Collections.IEnumerable)request["args"])arguments.Add((string)argument);
    if(String.Equals(Path.GetFileName(executable),"cmd.exe",StringComparison.OrdinalIgnoreCase)) {
      // cmd /s /c consumes one outer pair and parses the remaining command itself;
      // CRT backslash-escaping would insert literal backslashes before its quotes.
      if(arguments.Count!=4||arguments[0]!="/d"||arguments[1]!="/s"||arguments[2]!="/c")throw new Exception("Unsupported setup cmd invocation");
      command.Append(" /d /s /c \"").Append(arguments[3]).Append('"');
    } else foreach(string argument in arguments)command.Append(' ').Append(Quote(argument));
    var env=(Dictionary<string,object>)request["environment"];
    var keys=new List<string>(env.Keys);keys.Sort(StringComparer.OrdinalIgnoreCase);
    var environment=new StringBuilder();foreach(string key in keys){if(key.IndexOf('=')>=0||key.IndexOf('\0')>=0)throw new Exception("Invalid environment key");var v=(string)env[key];if(v.IndexOf('\0')>=0)throw new Exception("Invalid environment value");environment.Append(key).Append('=').Append(v).Append('\0');}environment.Append('\0');
    IntPtr job=IntPtr.Zero,attributeList=IntPtr.Zero,handles=IntPtr.Zero,jobList=IntPtr.Zero,environmentBlock=IntPtr.Zero;
    PROCESSINFO process=new PROCESSINFO();bool assigned=false,attributesReady=false;uint exitCode=1;bool interrupted=false;
    using(var stdin=new FileStream(log+".stdin",FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read))
    using(var stdout=new FileStream(log+".stdout",FileMode.CreateNew,FileAccess.Write,FileShare.Read))
    using(var stderr=new FileStream(log+".stderr",FileMode.CreateNew,FileAccess.Write,FileShare.Read)) {
      try {
        job=PrivateJob();
        var limit=new EXT_LIMIT();limit.Basic.LimitFlags=0x2000;
        Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(EXT_LIMIT))),"set setup kill-on-close job");
        var input=stdin.SafeFileHandle.DangerousGetHandle();var output=stdout.SafeFileHandle.DangerousGetHandle();var error=stderr.SafeFileHandle.DangerousGetHandle();
        foreach(IntPtr handle in new[]{input,output,error})Check(SetHandleInformation(handle,1,1),"stdio inheritance");
        IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
        attributeList=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attributeList,2,0,ref size),"initialize handle/job list");attributesReady=true;
        handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,output);Marshal.WriteIntPtr(handles,IntPtr.Size*2,error);
        Check(UpdateProcThreadAttribute(attributeList,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"restrict inherited handles");
        jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job);
        Check(UpdateProcThreadAttribute(attributeList,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"atomically assign setup job at process creation");
        var startup=new STARTUPINFOEX();startup.Startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEX));startup.Startup.flags=STARTF_USESTDHANDLES;startup.Startup.input=input;startup.Startup.output=output;startup.Startup.error=error;startup.Attributes=attributeList;
        environmentBlock=Marshal.StringToHGlobalUni(environment.ToString());
        Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,environmentBlock,cwd,ref startup,out process),"create suspended setup command");
        assigned=true;
        if(ResumeThread(process.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error(),"resume setup command");
        while(WaitForSingleObject(process.process,100)==0x102){if(ParentGone.WaitOne(0)){interrupted=true;Check(TerminateJobObject(job,125),"cancel interrupted setup command");break;}}
        Check(GetExitCodeProcess(process.process,out exitCode),"read setup exit status");
      } finally {
        if(job!=IntPtr.Zero&&assigned){TerminateJobObject(job,125);Drain(job);if(process.process!=IntPtr.Zero)Check(GetExitCodeProcess(process.process,out exitCode),"read drained setup exit status");}
        else if(process.process!=IntPtr.Zero){TerminateProcess(process.process,125);WaitForSingleObject(process.process,0xffffffff);}
        if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);
        if(job!=IntPtr.Zero)CloseHandle(job);if(attributesReady)DeleteProcThreadAttributeList(attributeList);
        if(attributeList!=IntPtr.Zero)Marshal.FreeHGlobal(attributeList);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);if(environmentBlock!=IntPtr.Zero)Marshal.FreeHGlobal(environmentBlock);
      }
    }
    if(new FileInfo(log+".stdout").Length>32L*1024*1024||new FileInfo(log+".stderr").Length>32L*1024*1024)throw new Exception("Setup command output limit exceeded");
    return new {id=request["id"],ok=!interrupted&&exitCode==0,exitCode=exitCode,interrupted=interrupted,activeProcessesAfter=0,stdout=File.ReadAllText(log+".stdout"),stderr=File.ReadAllText(log+".stderr")};
  }
  public static int Run(string lockFile,string coordinatorLock,string activeJournal) {
    Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false,true);
    SetErrorMode(3);
    try {
      HostFacts();
      using(var coordination=new FileStream(coordinatorLock,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))
      using(var lease=new FileStream(lockFile,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
        ValidateTerminal(activeJournal);
        ValidateSetupOrigin(coordinatorLock);
        JobName="Global\\FVS.SourceSetup."+Hash(Encoding.UTF8.GetBytes(WindowsIdentity.GetCurrent().User.Value+"\n"+LogonId()+"\n"+Process.GetCurrentProcess().SessionId+"\n"+Path.GetFullPath(lockFile).ToLowerInvariant())).Substring(0,32);
        DrainPriorJob();
        var reader=new Thread(()=>{try{string line;while((line=Console.In.ReadLine())!=null)Input.Add(line);}finally{ParentGone.Set();Input.CompleteAdding();}});reader.IsBackground=true;reader.Start();
        Emit(new{ready=true});
        foreach(string line in Input.GetConsumingEnumerable()) {
          if(ParentGone.WaitOne(0))break;
          var request=Json.Deserialize<Dictionary<string,object>>(line);
          if(Text(request,"operation")=="release")break;
          if(Text(request,"operation")!="execute")throw new Exception("Unknown setup host operation");
          try{Emit(Execute(request));}catch(Exception error){Emit(new{id=request["id"],ok=false,error=error.Message,activeProcessesAfter=0});}
        }
      }
      return 0;
    } catch(Exception error){Emit(new{ready=false,error=error.Message});return 3;}
  }
}
