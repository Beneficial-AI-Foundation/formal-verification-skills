// Native canary used only by the disposable AppContainer feasibility experiment.
package main

import (
 "encoding/json"
 "errors"
 "fmt"
 "net"
 "os"
 "os/exec"
 "path/filepath"
 "strconv"
 "syscall"
 "time"
 "unsafe"
)

func record(name string, values map[string]any) { values["check"]=name; values["pid"]=os.Getpid(); _=json.NewEncoder(os.Stdout).Encode(values) }
func attempt(name string, f func() error) { err:=f(); result:=map[string]any{"success":err==nil}; if err!=nil {result["error"]=err.Error();var errno syscall.Errno;if errors.As(err,&errno){result["errorCode"]=uint32(errno)}}; record(name,result) }
func token() {
 dll:=syscall.NewLazyDLL("advapi32.dll"); var h syscall.Handle
 ok,_,err:=dll.NewProc("OpenProcessToken").Call(^uintptr(0),8,uintptr(unsafe.Pointer(&h)))
 if ok==0 {record("token",map[string]any{"error":err.Error()}); return}; defer syscall.CloseHandle(h)
 for _,kind:=range []uint32{29,46} {var value,returned uint32; ok,_,err=dll.NewProc("GetTokenInformation").Call(uintptr(h),uintptr(kind),uintptr(unsafe.Pointer(&value)),4,uintptr(unsafe.Pointer(&returned))); record("token",map[string]any{"class":kind,"success":ok!=0,"value":value,"error":err.Error()})}
 for _,kind:=range []uint32{45,46} {var value,returned uint32; status,_,_:=syscall.NewLazyDLL("ntdll.dll").NewProc("NtQueryInformationToken").Call(uintptr(h),uintptr(kind),uintptr(unsafe.Pointer(&value)),4,uintptr(unsafe.Pointer(&returned))); record("native-token",map[string]any{"class":kind,"ntstatus":status,"value":value})}
 var needed uint32;dll.NewProc("GetTokenInformation").Call(uintptr(h),30,0,0,uintptr(unsafe.Pointer(&needed)));if needed>0&&needed<65536{buffer:=make([]byte,needed);ok,_,err=dll.NewProc("GetTokenInformation").Call(uintptr(h),30,uintptr(unsafe.Pointer(&buffer[0])),uintptr(needed),uintptr(unsafe.Pointer(&needed)));if ok!=0{count:=*(*uint32)(unsafe.Pointer(&buffer[0]));sids:=[]string{};for n:=uint32(0);n<count;n++{sid:=*(**syscall.SID)(unsafe.Pointer(&buffer[8+n*16]));text,_:=sid.String();sids=append(sids,text)};record("capabilities",map[string]any{"count":count,"sids":sids})}else{record("capabilities",map[string]any{"error":err.Error()})}}
 for _,value:=range []string{"S-1-15-2-1","S-1-15-2-2"}{sid,_:=syscall.StringToSid(value);var member uint32;ok,_,err=syscall.NewLazyDLL("kernelbase.dll").NewProc("CheckTokenMembershipEx").Call(0,uintptr(unsafe.Pointer(sid)),1,uintptr(unsafe.Pointer(&member)));record("package-membership",map[string]any{"sid":value,"success":ok!=0,"member":member,"error":err.Error()})}
}
func nativeWrite(path string)error {name,err:=syscall.UTF16PtrFromString(path);if err!=nil{return err}; h,err:=syscall.CreateFile(name,syscall.GENERIC_WRITE,syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE,nil,syscall.CREATE_ALWAYS,syscall.FILE_ATTRIBUTE_NORMAL,0);if err!=nil{return err};defer syscall.CloseHandle(h);var written uint32;return syscall.WriteFile(h,[]byte("allowed"),&written,nil)}
func main() {
 if len(os.Args)>1&&os.Args[1]=="create-readonly"{file:=os.Args[2];if err:=nativeWrite(file);err!=nil{panic(err)};name,_:=syscall.UTF16PtrFromString(file);if err:=syscall.SetFileAttributes(name,syscall.FILE_ATTRIBUTE_READONLY);err!=nil{panic(err)};record("readonly-created",map[string]any{"path":file});return}
 if len(os.Args)>1&&os.Args[1]=="echo-args"{record("arguments",map[string]any{"args":os.Args[2:]});return}
 if len(os.Args)>1&&os.Args[1]=="flood"{for n:=0;n<100000;n++{fmt.Println("untrusted-output-output-output-output-output-output-output-output-output-output")};return}
 if len(os.Args)>1&&os.Args[1]=="linger-leaf"{record("linger-child",map[string]any{});time.Sleep(30*time.Second);return}
 if len(os.Args)>1&&os.Args[1]=="chain-linger"{depth,_:=strconv.Atoi(os.Args[2]);_ = os.WriteFile(filepath.Join(os.Args[3],fmt.Sprintf("pid-%d.txt",depth)),[]byte(strconv.Itoa(os.Getpid())),0600);if depth<2{executable,_:=os.Executable();cmd:=exec.Command(executable,"chain-linger",strconv.Itoa(depth+1),os.Args[3]);cmd.Stdout=os.Stdout;cmd.Stderr=os.Stderr;cmd.SysProcAttr=&syscall.SysProcAttr{HideWindow:true};if err:=cmd.Start();err!=nil{panic(err)}};time.Sleep(30*time.Second);return}
 if len(os.Args)>1&&os.Args[1]=="spawn-linger"{executable,_:=os.Executable();cmd:=exec.Command(executable,"linger-leaf");cmd.Stdout=os.Stdout;cmd.Stderr=os.Stderr;cmd.SysProcAttr=&syscall.SysProcAttr{HideWindow:true};if err:=cmd.Start();err!=nil{panic(err)};record("background-child",map[string]any{"childPid":cmd.Process.Pid});time.Sleep(100*time.Millisecond);return}
 if len(os.Args)<4 {panic("usage: native-canary depth protected port [linger]")}
 depth,_:=strconv.Atoi(os.Args[1]); executable,_:=os.Executable(); stage:=filepath.Dir(executable); protected:=os.Args[2]
 record("started",map[string]any{"depth":depth,"executable":executable}); token()
 attempt("private-write",func()error{return nativeWrite(filepath.Join(stage,"write",fmt.Sprintf("depth-%d.txt",depth)))})
 attempt("private-replace-delete",func()error{dir:=filepath.Join(stage,"write");a:=filepath.Join(dir,fmt.Sprintf("replace-a-%d",depth));b:=filepath.Join(dir,fmt.Sprintf("replace-b-%d",depth));if err:=nativeWrite(a);err!=nil{return err};if err:=nativeWrite(b);err!=nil{return err};if err:=os.Rename(a,b);err!=nil{return err};return os.Remove(b)})
 attempt("private-directory-rename",func()error{dir:=filepath.Join(stage,"write");a:=filepath.Join(dir,fmt.Sprintf("rename-a-%d",depth));b:=filepath.Join(dir,fmt.Sprintf("rename-b-%d",depth));if err:=os.Mkdir(a,0700);err!=nil{return err};if err:=os.Rename(a,b);err!=nil{return err};return os.Remove(b)})
 if _,err:=os.Stat(filepath.Join(stage,"write",fmt.Sprintf("preexisting-a-%d",depth)));err==nil {attempt("private-preexisting-replace-delete",func()error{dir:=filepath.Join(stage,"write");a:=filepath.Join(dir,fmt.Sprintf("preexisting-a-%d",depth));b:=filepath.Join(dir,fmt.Sprintf("preexisting-b-%d",depth));if err:=os.Rename(a,b);err!=nil{return err};return os.Remove(b)})}
 attempt("all-app-packages-read",func()error{_,err:=os.ReadFile(filepath.Join(stage,"aap-only.txt"));return err})
 attempt("all-restricted-packages-read",func()error{_,err:=os.ReadFile(filepath.Join(stage,"arap-only.txt"));return err})
 attempt("profile-root-write",func()error{return nativeWrite(filepath.Join(os.Getenv("FVS_PROOF_PROFILE_ROOT"),fmt.Sprintf("outside-temp-%d.txt",depth)))})
 attempt("profile-localstate-create",func()error{return os.Mkdir(filepath.Join(os.Getenv("FVS_PROOF_PROFILE_ROOT"),"LocalState"),0700)})
 attempt("profile-localstate-write",func()error{return nativeWrite(filepath.Join(os.Getenv("FVS_PROOF_PROFILE_ROOT"),"LocalState",fmt.Sprintf("outside-temp-%d.txt",depth)))})
 attempt("profile-temp-write",func()error{return nativeWrite(filepath.Join(os.Getenv("FVS_PROOF_PROFILE_TEMP"),fmt.Sprintf("private-temp-%d.txt",depth)))})
 if depth==0 && os.Getenv("FVS_PROOF_SENTINEL_HANDLE")!="" { record("sentinel-child-observation",map[string]any{"skipped":true,"reason":"Invalid-handle probing can trigger strict-handle exceptions; use launcher-side duplicate/identity inspection"}) }
 attempt("readonly-dacl-rewrite",func()error{name,_:=syscall.UTF16PtrFromString(filepath.Join(stage,"readonly.txt"));result,_,_:=syscall.NewLazyDLL("advapi32.dll").NewProc("SetNamedSecurityInfoW").Call(uintptr(unsafe.Pointer(name)),1,4,0,0,0,0);if result!=0{return syscall.Errno(result)};return nil})
 attempt("profile-dacl-rewrite",func()error{name,_:=syscall.UTF16PtrFromString(os.Getenv("FVS_PROOF_PROFILE_ROOT"));result,_,_:=syscall.NewLazyDLL("advapi32.dll").NewProc("SetNamedSecurityInfoW").Call(uintptr(unsafe.Pointer(name)),1,4,0,0,0,0);if result!=0{return syscall.Errno(result)};return nil})
 attempt("protected-dacl-rewrite",func()error{name,_:=syscall.UTF16PtrFromString(filepath.Join(protected,"source.txt"));result,_,_:=syscall.NewLazyDLL("advapi32.dll").NewProc("SetNamedSecurityInfoW").Call(uintptr(unsafe.Pointer(name)),1,4,0,0,0,0);if result!=0{return syscall.Errno(result)};return nil})
 attempt("readonly-write",func()error{return os.WriteFile(filepath.Join(stage,"readonly.txt"),[]byte("forbidden"),0600)})
 attempt("protected-write",func()error{return os.WriteFile(filepath.Join(protected,"source.txt"),[]byte("forbidden"),0600)})
 attempt("protected-delete",func()error{return os.Remove(filepath.Join(protected,"source.txt"))})
 attempt("absent-directory",func()error{return os.Mkdir(filepath.Join(protected,"initially-absent"),0700)})
 attempt("network-connect",func()error{conn,err:=net.DialTimeout("tcp","127.0.0.1:"+os.Args[3],2*time.Second); if conn!=nil {conn.Close()}; return err})
 attempt("network-connect-ipv6",func()error{conn,err:=net.DialTimeout("tcp6","[::1]:"+os.Args[3],2*time.Second); if conn!=nil {conn.Close()}; return err})
 attempt("network-connect-udp",func()error{conn,err:=net.DialTimeout("udp","127.0.0.1:"+os.Args[3],2*time.Second); if conn!=nil {conn.Close()}; return err})
 if depth<2 {childArgs:=[]string{strconv.Itoa(depth+1),protected,os.Args[3]};if len(os.Args)>4 && os.Args[4]=="linger" {childArgs=append(childArgs,"linger")};cmd:=exec.Command(executable,childArgs...); cmd.Stdout=os.Stdout; cmd.Stderr=os.Stderr; cmd.SysProcAttr=&syscall.SysProcAttr{HideWindow:true}; attempt("child-process",cmd.Run)}
 if len(os.Args)>4 && os.Args[4]=="linger" {record("linger",map[string]any{}); time.Sleep(30*time.Second)}
}
