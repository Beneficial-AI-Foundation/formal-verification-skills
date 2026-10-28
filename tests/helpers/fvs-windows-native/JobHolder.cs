// Test-only process that retains an already-created native job across launcher death.
using System;
using System.Runtime.InteropServices;
public static class JobHolder {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int Main(string[] args){if(args.Length<1||args.Length>2)return 2;IntPtr job=args.Length==2&&args[1]=="create"?CreateJobObject(IntPtr.Zero,args[0]):OpenJobObject(4,false,args[0]);if(job==IntPtr.Zero)return 3;try{Console.WriteLine("ready");Console.Out.Flush();Console.ReadLine();return 0;}finally{CloseHandle(job);}}
}
