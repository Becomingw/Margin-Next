param([Parameter(Mandatory=$true)][int]$ProcessId, [string]$Path, [switch]$Cancel)
$ErrorActionPreference = 'Stop'
if ((Get-Process -Id $ProcessId).ProcessName -ne 'margin') { throw 'Not a dedicated Margin test process' }
if (-not $Cancel -and -not (Test-Path -LiteralPath $Path -PathType Container)) { throw 'Fixture directory missing' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class MarginWorkspacePicker {
  delegate bool EnumProc(IntPtr hwnd,IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn,IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder name,int max);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr dialog,int id);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr w,string text);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  public static void Pick(uint pid,string path,bool cancel) {
    IntPtr dialog=IntPtr.Zero;
    for(int i=0;i<100 && dialog==IntPtr.Zero;i++) {
      EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var name=new StringBuilder(128);GetClassName(h,name,128);if(owner==pid && name.ToString()=="#32770"){dialog=h;return false;}return true;},IntPtr.Zero);
      if(dialog==IntPtr.Zero)Thread.Sleep(100);
    }
    if(dialog==IntPtr.Zero){if(cancel)return;throw new Exception("Native workspace picker did not open");}
    if(!cancel) {
      var edit=GetDlgItem(dialog,1152);
      if(edit==IntPtr.Zero)throw new Exception("Native directory input missing");
      SendMessage(edit,0x000C,IntPtr.Zero,path);
    }
    PostMessage(dialog,0x0111,new IntPtr(cancel?2:1),IntPtr.Zero);
    if(!cancel) {
      // IFileDialog may navigate to a typed directory on the first OK instead
      // of completing selection. Confirm the now-current fixture directory.
      Thread.Sleep(500);
      if(IsWindow(dialog))PostMessage(dialog,0x0111,new IntPtr(1),IntPtr.Zero);
    }
  }
}
'@
[MarginWorkspacePicker]::Pick($ProcessId,$Path,$Cancel.IsPresent)
