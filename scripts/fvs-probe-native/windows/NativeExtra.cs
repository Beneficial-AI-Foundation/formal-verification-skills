using System;
using System.Text;
using System.Runtime.InteropServices;
internal static partial class N {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool SetFileSecurity(string path,uint information,byte[] descriptor);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool SetSecurityDescriptorControl([In,Out] byte[] descriptor,ushort interest,ushort bits);
 [StructLayout(LayoutKind.Sequential)] public struct FILE_INFO {public uint attrs;public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern uint GetDriveType(string root);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandle(IntPtr file,out FILE_INFO info);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint GetFileType(IntPtr file);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint length,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool ReadFile(IntPtr file,byte[] buffer,int length,out int read,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CancelSynchronousIo(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenThread(uint access,bool inherit,uint id);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
}
